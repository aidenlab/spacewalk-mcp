import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import type { Color, Proposal } from '@aidenlab/spacewalk-remote/protocol'
import { describe, expect, it } from 'vitest'
import type { Result } from '../src/room.ts'

// Apple crayon "iron", #545453, as three.js puts it in linear space: Spacewalk's default
// furniture color.
const IRON = { r: 0.08865558627723595, g: 0.08865558627723595, b: 0.08650046202808521 }

// Each test opens its own Room, so they share nothing.
let rooms = 0
function freshRoom() {
  return env.ROOM.getByName(`room-${++rooms}`)
}

describe('opening a Room', () => {
  it('starts it empty at version 0', async () => {
    const room = freshRoom()
    const opened = await room.open()
    expect(opened).toEqual({
      ok: true,
      version: 0,
      state: {
        ensemble: null,
        renderStyle: 'ball-and-stick',
        structureAppearance: {
          ballRadiusIndex: 5,
          stickRadiusIndex: 5,
          sticksVisible: true,
          pointSizeRadiusFraction: null,
          pointOpacity: 0.375,
          colorRamp: 'peter_kovesi_rainbow_bgyr_35_85_c72_n256',
          isCircular: false,
        },
        viewerSettings: {
          background: { r: 1, g: 1, b: 1 },
          gnomon: { visible: false, ...IRON },
          groundPlane: { visible: false, ...IRON },
          referenceRuler: { visible: false, ...IRON },
        },
        camera: null,
      },
    })
  })
})

describe('a Room that was never opened', () => {
  it('refuses everything until it is opened', async () => {
    const room = freshRoom()
    const unknown = { ok: false, reason: 'room-unknown' }
    expect(await room.read()).toMatchObject(unknown)
    expect(await room.propose({ type: 'reset-camera' })).toMatchObject(unknown)
  })
})

describe('opening a Room again while it is live', () => {
  it('keeps what it holds', async () => {
    const room = freshRoom()
    await room.open()
    await room.propose({ type: 'set-render-style', style: 'ribbon' })
    expect(await room.open()).toMatchObject({
      ok: true,
      version: 1,
      state: { renderStyle: 'ribbon' },
    })
  })
})

describe('a Room left unused for a day', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('is due to expire a day after it was last used', async () => {
    const room = freshRoom()
    await room.open()
    const before = Date.now()
    await room.propose({ type: 'reset-camera' })
    const after = Date.now()
    const alarm = await runInDurableObject(room, (_, ctx) => ctx.storage.getAlarm())
    expect(alarm).toBeGreaterThanOrEqual(before + DAY)
    expect(alarm).toBeLessThanOrEqual(after + DAY)
  })

  it('expires, refusing everything', async () => {
    const room = freshRoom()
    await room.open()
    await room.propose({ type: 'load-ensemble', url: 'https://example.com/a.sw' })
    expect(await runDurableObjectAlarm(room)).toBe(true)

    const expired = { ok: false, reason: 'room-expired' }
    expect(await room.read()).toMatchObject(expired)
    expect(await room.propose({ type: 'reset-camera' })).toMatchObject(expired)
    expect(await room.recordKind(1, 'trace')).toMatchObject(expired)
  })

  it('tells its Viewers it has expired, and lets them go', async () => {
    const room = freshRoom()
    await room.open()
    const viewer = await runInDurableObject(room, (_, ctx) => listen(ctx))
    await runDurableObjectAlarm(room)
    await viewer.closed
    expect(viewer.heard).toEqual([
      { type: 'error', code: 'room-expired', message: expect.any(String) },
    ])
  })

  it('restarts empty under the same id when opened, never getting its contents back', async () => {
    const room = freshRoom()
    await room.open()
    await room.propose({ type: 'load-ensemble', url: 'https://example.com/a.sw' })
    await runDurableObjectAlarm(room)

    const reopened = await room.open()
    expect(reopened).toMatchObject({ ok: true, state: { ensemble: null } })
    expect(await room.read()).toEqual(reopened)
  })

  it('counts on from its last version after a restart, so no Viewer takes it for old', async () => {
    const room = freshRoom()
    await room.open()
    await room.propose({ type: 'reset-camera' })
    await room.propose({ type: 'reset-camera' })
    await runDurableObjectAlarm(room)

    expect(await room.open()).toMatchObject({ version: 3 })
    expect(await room.propose({ type: 'reset-camera' })).toMatchObject({ version: 4 })
  })
})

describe('a proposal', () => {
  it('is applied, giving the viewer state a new version', async () => {
    const room = freshRoom()
    await room.open()
    const result = await room.propose({ type: 'set-render-style', style: 'ribbon' })
    expect(result).toMatchObject({ ok: true, version: 1, state: { renderStyle: 'ribbon' } })
    expect(await room.read()).toEqual(result)
  })

  it('is applied in the order it arrives, each one a version of its own', async () => {
    const room = freshRoom()
    await room.open()
    const results = await Promise.all([
      room.propose({ type: 'load-ensemble', url: 'https://example.com/a.sw' }),
      room.propose({ type: 'select-ensemble-group', key: 'g2' }),
      room.propose({ type: 'select-trace', key: '12' }),
    ])
    expect(results.map((result) => result.ok && result.version)).toEqual([1, 2, 3])
    expect(await room.read()).toMatchObject({
      version: 3,
      state: {
        ensemble: { url: 'https://example.com/a.sw', groupKey: 'g2', traceKey: '12', kind: null },
      },
    })
  })

  it('loading another ensemble starts at its default group and trace', async () => {
    const room = freshRoom()
    await room.open()
    await room.propose({ type: 'load-ensemble', url: 'https://example.com/a.sw' })
    await room.propose({ type: 'select-ensemble-group', key: 'g2' })
    await room.propose({ type: 'select-trace', key: '12' })
    const result = await room.propose({ type: 'load-ensemble', url: 'https://example.com/b.sw' })
    expect(result).toMatchObject({
      state: {
        ensemble: { url: 'https://example.com/b.sw', groupKey: null, traceKey: null, kind: null },
      },
    })
  })

  it('choosing a group goes to its default trace', async () => {
    const room = freshRoom()
    await room.open()
    await room.propose({ type: 'load-ensemble', url: 'https://example.com/a.sw' })
    await room.propose({ type: 'select-trace', key: '12' })
    const result = await room.propose({ type: 'select-ensemble-group', key: 'g2' })
    expect(result).toMatchObject({ state: { ensemble: { groupKey: 'g2', traceKey: null } } })
  })

  it('is refused, with no new version, when it is malformed', async () => {
    const room = freshRoom()
    await room.open()
    const offTheLadder = { type: 'set-structure-appearance', patch: { ballRadiusIndex: 11 } }
    expect(await room.propose(offTheLadder as Proposal)).toMatchObject({
      ok: false,
      reason: 'refused',
    })
    expect(await room.propose({ type: 'teapot' } as unknown as Proposal)).toMatchObject({
      ok: false,
      reason: 'refused',
    })
    expect(await room.read()).toMatchObject({ version: 0 })
  })

  it('is refused, with no new version, when it needs an ensemble and none is loaded', async () => {
    const room = freshRoom()
    await room.open()
    expect(await room.propose({ type: 'select-trace', key: '3' })).toMatchObject({ ok: false })
    expect(await room.propose({ type: 'select-ensemble-group', key: 'g' })).toMatchObject({
      ok: false,
    })
    expect(await room.read()).toMatchObject({ version: 0 })
  })
})

describe('broadcasting', () => {
  it('sends every socket in the Room each new version, and nothing for a refusal', async () => {
    const room = freshRoom()
    await room.open()
    await runInDurableObject(room, async (instance, ctx) => {
      const viewers = [listen(ctx), listen(ctx)]
      await instance.propose({ type: 'step-ball-radius', direction: 'up' })
      await instance.propose({ type: 'select-trace', key: '1' }) // refused: no ensemble
      await instance.propose({ type: 'reset-camera' })
      await settle()
      for (const { heard } of viewers) {
        expect(heard).toMatchObject([
          { type: 'state', version: 1, state: { structureAppearance: { ballRadiusIndex: 6 } } },
          { type: 'state', version: 2, state: { camera: null } },
        ])
      }
    })
  })
})

// Accept one end of a socket pair into the Room, as /ws will, and collect what the other end hears.
function listen(ctx: DurableObjectState) {
  const [client, server] = Object.values(new WebSocketPair())
  ctx.acceptWebSocket(server)
  client.accept()
  const heard: unknown[] = []
  client.addEventListener('message', (event) => heard.push(JSON.parse(event.data as string)))
  const closed = new Promise((resolve) => client.addEventListener('close', resolve))
  return { heard, closed }
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

describe('a relative step along the radius ladder', () => {
  it('moves the ball or stick radius one rung from wherever it is', async () => {
    const room = freshRoom()
    await room.open()
    await room.propose({ type: 'set-structure-appearance', patch: { ballRadiusIndex: 2 } })
    expect(await room.propose({ type: 'step-ball-radius', direction: 'up' })).toMatchObject({
      state: { structureAppearance: { ballRadiusIndex: 3, stickRadiusIndex: 5 } },
    })
    expect(await room.propose({ type: 'step-stick-radius', direction: 'down' })).toMatchObject({
      state: { structureAppearance: { ballRadiusIndex: 3, stickRadiusIndex: 4 } },
    })
  })

  it('stops at the top rung', async () => {
    const room = freshRoom()
    await room.open()
    await room.propose({ type: 'set-structure-appearance', patch: { ballRadiusIndex: 10 } })
    expect(await room.propose({ type: 'step-ball-radius', direction: 'up' })).toMatchObject({
      ok: true,
      state: { structureAppearance: { ballRadiusIndex: 10 } },
    })
  })

  it('stops at the bottom rung', async () => {
    const room = freshRoom()
    await room.open()
    await room.propose({ type: 'set-structure-appearance', patch: { stickRadiusIndex: 0 } })
    expect(await room.propose({ type: 'step-stick-radius', direction: 'down' })).toMatchObject({
      ok: true,
      state: { structureAppearance: { stickRadiusIndex: 0 } },
    })
  })
})

// The background steps ten points of HSL lightness, in sRGB, keeping hue and saturation.
// Expected colors were worked out with Python's colorsys and the sRGB transfer function.
describe('a relative step of the background', () => {
  it('darkens white to a light gray', async () => {
    const room = freshRoom()
    await room.open()
    const result = await room.propose({ type: 'adjust-background', direction: 'darker' })
    expect(backgroundOf(result)).toEqual(closeTo({ r: 0.787412, g: 0.787412, b: 0.787412 }))
  })

  it('keeps the hue of a colored background', async () => {
    const room = freshRoom()
    await room.open()
    await room.propose({
      type: 'set-viewer-settings',
      patch: { background: { r: 1, g: 0, b: 0 } },
    })
    const result = await room.propose({ type: 'adjust-background', direction: 'darker' })
    expect(backgroundOf(result)).toEqual(closeTo({ r: 0.603827, g: 0, b: 0 }))
  })

  it('lightens back to where it started', async () => {
    const room = freshRoom()
    await room.open()
    await room.propose({ type: 'adjust-background', direction: 'darker' })
    const result = await room.propose({ type: 'adjust-background', direction: 'lighter' })
    expect(backgroundOf(result)).toEqual(closeTo({ r: 1, g: 1, b: 1 }))
  })

  it('stops at white', async () => {
    const room = freshRoom()
    await room.open()
    const result = await room.propose({ type: 'adjust-background', direction: 'lighter' })
    expect(result).toMatchObject({ ok: true })
    expect(backgroundOf(result)).toEqual(closeTo({ r: 1, g: 1, b: 1 }))
  })

  it('stops at black', async () => {
    const room = freshRoom()
    await room.open()
    await room.propose({
      type: 'set-viewer-settings',
      patch: { background: { r: 0, g: 0, b: 0 } },
    })
    const result = await room.propose({ type: 'adjust-background', direction: 'darker' })
    expect(backgroundOf(result)).toEqual(closeTo({ r: 0, g: 0, b: 0 }))
  })

  it('leaves the rest of the viewer settings alone', async () => {
    const room = freshRoom()
    await room.open()
    await room.propose({ type: 'set-viewer-settings', patch: { gnomon: { visible: true } } })
    const result = await room.propose({ type: 'adjust-background', direction: 'darker' })
    expect(result).toMatchObject({
      state: { viewerSettings: { gnomon: { visible: true, ...IRON } } },
    })
  })
})

describe('choosing a render style', () => {
  const url = 'https://example.com/cloud.sw'

  it('is refused once a Viewer has reported the ensemble a point cloud', async () => {
    const room = freshRoom()
    await room.open()
    await room.propose({ type: 'load-ensemble', url })
    await room.recordKind(1, 'point-cloud')
    const result = await room.propose({ type: 'set-render-style', style: 'ribbon' })
    expect(result).toMatchObject({
      ok: false,
      reason: 'refused',
      message: expect.stringMatching(/point cloud/),
    })
    expect(await room.read()).toMatchObject({
      version: 1,
      state: { renderStyle: 'ball-and-stick' },
    })
  })

  it('is applied while the kind is not yet known', async () => {
    const room = freshRoom()
    await room.open()
    await room.propose({ type: 'load-ensemble', url })
    const result = await room.propose({ type: 'set-render-style', style: 'ribbon' })
    expect(result).toMatchObject({ ok: true, state: { renderStyle: 'ribbon' } })
  })

  it('is applied to a trace ensemble', async () => {
    const room = freshRoom()
    await room.open()
    await room.propose({ type: 'load-ensemble', url })
    await room.recordKind(1, 'trace')
    const result = await room.propose({ type: 'set-render-style', style: 'ribbon' })
    expect(result).toMatchObject({ ok: true, state: { renderStyle: 'ribbon' } })
  })
})

describe('recording the kind a Viewer reports', () => {
  // A realized report names the version the Viewer drew; the kind is that version's ensemble's.
  it('fills in the loaded ensemble without a new version, since it is no proposal', async () => {
    const room = freshRoom()
    await room.open()
    await room.propose({ type: 'load-ensemble', url: 'https://example.com/a.sw' })
    await room.propose({ type: 'select-trace', key: '4' })
    await room.recordKind(2, 'point-cloud')
    expect(await room.read()).toMatchObject({
      version: 2,
      state: { ensemble: { url: 'https://example.com/a.sw', kind: 'point-cloud' } },
    })
  })

  it('is ignored when it is about an ensemble loaded before the current one', async () => {
    const room = freshRoom()
    await room.open()
    await room.propose({ type: 'load-ensemble', url: 'https://example.com/a.sw' })
    await room.propose({ type: 'load-ensemble', url: 'https://example.com/b.sw' })
    await room.recordKind(1, 'point-cloud')
    expect(await room.read()).toMatchObject({ state: { ensemble: { kind: null } } })
  })

  it('is ignored when it is about an earlier load of the same ensemble', async () => {
    const room = freshRoom()
    await room.open()
    await room.propose({ type: 'load-ensemble', url: 'https://example.com/a.sw' })
    await room.propose({ type: 'load-ensemble', url: 'https://example.com/a.sw' })
    await room.recordKind(1, 'point-cloud')
    expect(await room.read()).toMatchObject({ state: { ensemble: { kind: null } } })
  })

  it('is ignored when nothing is loaded, or for a version the Room has not reached', async () => {
    const room = freshRoom()
    await room.open()
    await room.recordKind(0, 'trace')
    await room.propose({ type: 'load-ensemble', url: 'https://example.com/a.sw' })
    await room.recordKind(7, 'trace')
    expect(await room.read()).toMatchObject({ state: { ensemble: { kind: null } } })
  })
})

describe('the camera', () => {
  const camera = { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } }

  it('is set by a Viewer and reset by a tool', async () => {
    const room = freshRoom()
    await room.open()
    expect(await room.propose({ type: 'set-camera', camera })).toMatchObject({
      state: { camera },
    })
    expect(await room.propose({ type: 'reset-camera' })).toMatchObject({
      version: 2,
      state: { camera: null },
    })
  })
})

function backgroundOf(result: Result) {
  if (!result.ok) throw new Error(result.message)
  return result.state.viewerSettings.background
}

function closeTo({ r, g, b }: Color) {
  return { r: expect.closeTo(r, 5), g: expect.closeTo(g, 5), b: expect.closeTo(b, 5) }
}
