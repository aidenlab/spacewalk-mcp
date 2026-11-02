import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { PROTOCOL_VERSION } from '@aidenlab/spacewalk-remote/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { Result } from '../src/room.ts'
import { emptyViewerState } from '../src/viewerState.ts'
import { connect, join, joinAndSync, report, upgrade, VIEWER_ORIGIN, type Connection } from './viewer.ts'

// Each test opens its own Room, so they share nothing.
let rooms = 0
async function openRoom() {
  const id = `ws-room-${++rooms}`
  const room = env.ROOM.getByName(id)
  await room.open()
  return { id, room }
}

describe('connecting to /ws', () => {
  it('refuses an origin not on the allow-list with 403', async () => {
    const response = await upgrade('origin-refused', 'https://elsewhere.example')
    expect(response.status).toBe(403)
    expect(response.webSocket).toBeNull()
  })

  it('refuses a connection with no origin with 403', async () => {
    const response = await upgrade('origin-missing', null)
    expect(response.status).toBe(403)
  })

  it('matches origins however VIEWER_ORIGINS writes them', async () => {
    // wrangler.toml lists 'https://viewer.example/', with a path, as a person might.
    const response = await upgrade('origin-normalized', 'https://viewer.example')
    expect(response.status).toBe(101)
    response.webSocket?.accept()
    response.webSocket?.close()
  })

  it('accepts an allowed origin', async () => {
    const response = await upgrade('origin-allowed', VIEWER_ORIGIN)
    expect(response.status).toBe(101)
    response.webSocket?.accept()
    response.webSocket?.close()
  })
})

describe('joining a Room', () => {
  it('sends the joining Viewer the current viewer state', async () => {
    const { id, room } = await openRoom()
    await room.propose({ type: 'set-render-style', style: 'ribbon' })
    const viewer = await connect(id)
    viewer.send({ type: 'join', protocol: PROTOCOL_VERSION })
    expect(await viewer.next()).toEqual({ type: 'state', ...versioned(await room.read()), loaded: null })
  })

  it('refuses a Viewer speaking another protocol version, telling it to reload', async () => {
    const { id } = await openRoom()
    const viewer = await connect(id)
    viewer.send({ type: 'join', protocol: PROTOCOL_VERSION + 1 })
    expect(await viewer.next()).toEqual({
      type: 'error',
      code: 'protocol-mismatch',
      message: expect.stringMatching(/reload the viewer/i),
    })
    await viewer.closed
  })

  it('refuses a Viewer still on protocol 1, telling it to reload', async () => {
    const { id } = await openRoom()
    const viewer = await connect(id)
    viewer.send({ type: 'join', protocol: 1 })
    expect(await viewer.next()).toEqual({
      type: 'error',
      code: 'protocol-mismatch',
      message: expect.stringMatching(/reload the viewer/i),
    })
    await viewer.closed
  })

  it('answers a join to an expired Room with "this Room has expired"', async () => {
    const { id, room } = await openRoom()
    await runDurableObjectAlarm(room)
    const viewer = await connect(id)
    viewer.send({ type: 'join', protocol: PROTOCOL_VERSION })
    expect(await viewer.next()).toEqual({
      type: 'error',
      code: 'room-expired',
      message: expect.stringMatching(/this Room has expired/i),
    })
    await viewer.closed
  })

  it('answers a join to a Room never opened with "no such Room"', async () => {
    const viewer = await connect('never-opened')
    viewer.send({ type: 'join', protocol: PROTOCOL_VERSION })
    expect(await viewer.next()).toEqual({
      type: 'error',
      code: 'room-unknown',
      message: expect.stringMatching(/no such Room/i),
    })
    await viewer.closed
  })
})

describe('a message the Room cannot read', () => {
  it('is answered with why, and the Viewer stays connected', async () => {
    const { id } = await openRoom()
    const viewer = await joinAndSync(id)
    viewer.send({ type: 'teapot' })
    expect(await viewer.next()).toEqual({
      type: 'error',
      code: 'malformed-message',
      message: expect.any(String),
    })
    viewer.send({ type: 'join', protocol: PROTOCOL_VERSION })
    expect(await viewer.next()).toMatchObject({ type: 'state', version: 0 })
  })
})

describe('a hand change the Room cannot read', () => {
  it('is answered with why, and its Viewer resynced to put the change back', async () => {
    const { id } = await openRoom()
    const viewer = await joinAndSync(id)
    const offTheLadder = { type: 'set-structure-appearance', patch: { ballRadiusIndex: 11 } }
    viewer.send({ type: 'propose', proposal: offTheLadder })
    expect(await viewer.next()).toMatchObject({ type: 'error', code: 'malformed-message' })
    expect(await viewer.next()).toMatchObject({ type: 'state', version: 0 })
  })
})

describe('a Viewer that reconnects', () => {
  it('is resynced to the version it missed while away', async () => {
    const { id, room } = await openRoom()
    const before = await join(id)
    expect(await before.next()).toMatchObject({ version: 0 })
    before.close()

    await room.propose({ type: 'step-ball-radius', direction: 'up' })
    const after = await join(id)
    expect(await after.next()).toMatchObject({
      type: 'state',
      version: 1,
      state: { structureAppearance: { ballRadiusIndex: 6 } },
    })
  })
})

describe('a second Viewer', () => {
  it('is tolerated: every joined Viewer hears each new version', async () => {
    const { id, room } = await openRoom()
    const viewers = [await join(id), await join(id)]
    for (const viewer of viewers) expect(await viewer.next()).toMatchObject({ version: 0 })

    await room.propose({ type: 'set-render-style', style: 'ribbon' })
    for (const viewer of viewers) {
      expect(await viewer.next()).toMatchObject({ version: 1, state: { renderStyle: 'ribbon' } })
    }
  })

  it('hears nothing of a refused proposal', async () => {
    const { id, room } = await openRoom()
    const viewers = [await join(id), await join(id)]
    for (const viewer of viewers) await viewer.next()

    await room.propose({ type: 'select-trace', key: '1' }) // refused: no ensemble
    await room.propose({ type: 'adjust-background', direction: 'darker' })
    for (const viewer of viewers) expect(await viewer.next()).toMatchObject({ version: 1 })
  })

  it('hears nothing until it joins', async () => {
    const { id, room } = await openRoom()
    const early = await connect(id)
    await room.propose({ type: 'adjust-background', direction: 'darker' })
    await room.propose({ type: 'adjust-background', direction: 'darker' })
    early.send({ type: 'join', protocol: PROTOCOL_VERSION })
    // Its first message is the join's answer, not a broadcast of version 1.
    expect(await early.next()).toMatchObject({ type: 'state', version: 2 })
  })
})

describe('a hand change', () => {
  it('is proposed by a Viewer and broadcast to every Viewer as a new version', async () => {
    const { id, room } = await openRoom()
    const [hand, other] = [await join(id), await join(id)]
    await hand.next()
    await other.next()

    hand.send({ type: 'propose', proposal: { type: 'set-render-style', style: 'ribbon' } })
    for (const viewer of [hand, other]) {
      expect(await viewer.next()).toMatchObject({ version: 1, state: { renderStyle: 'ribbon' } })
    }
    expect(await room.read()).toMatchObject({ version: 1, state: { renderStyle: 'ribbon' } })
  })

  it('when refused, tells only its Viewer why and resyncs it to put the change back', async () => {
    const { id, room } = await openRoom()
    const [hand, other] = [await join(id), await join(id)]
    await hand.next()
    await other.next()

    hand.send({ type: 'propose', proposal: { type: 'select-trace', key: '3' } })
    expect(await hand.next()).toEqual({
      type: 'error',
      code: 'proposal-refused',
      message: expect.any(String),
    })
    expect(await hand.next()).toMatchObject({ type: 'state', version: 0 })

    // The other Viewer hears nothing of it: its next message is the next version.
    await room.propose({ type: 'adjust-background', direction: 'darker' })
    expect(await other.next()).toMatchObject({ type: 'state', version: 1 })
  })
})

describe('realized reports', () => {
  const url = 'https://example.com/a.sw'
  const drawn = { outcome: 'drawn' }
  const failed = (reason: string) => ({ outcome: 'failed', reason })

  it('records the first report of a version', async () => {
    const { id, room } = await openRoom()
    await room.propose({ type: 'load-ensemble', url })
    const viewer = await joinAndSync(id)
    await report(viewer, { version: 1, kind: 'trace', result: drawn })
    expect(await room.realized()).toEqual({
      ok: true,
      latest: { version: 1, result: drawn },
      failures: [],
    })
  })

  it('lets the first report of a version win', async () => {
    const { id, room } = await openRoom()
    await room.propose({ type: 'adjust-background', direction: 'darker' })
    const [first, second] = [await joinAndSync(id), await joinAndSync(id)]
    await report(first, { version: 1, kind: null, result: drawn })
    await report(second, { version: 1, kind: null, result: failed('out of memory') })
    expect(await room.realized()).toMatchObject({ latest: { version: 1, result: drawn } })
  })

  it('keeps the failures from every Viewer, even when another drew the version', async () => {
    const { id, room } = await openRoom()
    await room.propose({ type: 'adjust-background', direction: 'darker' })
    const first = await joinAndSync(id)
    const second = await joinAndSync(id)
    const third = await joinAndSync(id)
    await report(first, { version: 1, kind: null, result: drawn })
    await report(second, { version: 1, kind: null, result: failed('out of memory') })
    await report(third, { version: 1, kind: null, result: failed('lost the WebGL context') })
    expect(await room.realized()).toMatchObject({
      failures: [
        { version: 1, reason: 'out of memory' },
        { version: 1, reason: 'lost the WebGL context' },
      ],
    })
  })

  it('ignores a late report on a version older than one already realized', async () => {
    const { id, room } = await openRoom()
    await room.propose({ type: 'adjust-background', direction: 'darker' })
    await room.propose({ type: 'adjust-background', direction: 'darker' })
    const viewer = await joinAndSync(id)
    await report(viewer, { version: 2, kind: null, result: drawn })
    await report(viewer, { version: 1, kind: null, result: drawn })
    expect(await room.realized()).toMatchObject({ latest: { version: 2 } })
  })

  it('ignores a report on a version the Room has not reached', async () => {
    const { id, room } = await openRoom()
    const viewer = await joinAndSync(id)
    await report(viewer, { version: 5, kind: null, result: failed('from the future') })
    expect(await room.realized()).toEqual({ ok: true, latest: null, failures: [] })
  })

  it('records the kind of ensemble the Viewer drew', async () => {
    const { id, room } = await openRoom()
    await room.propose({ type: 'load-ensemble', url })
    const viewer = await joinAndSync(id)
    await report(viewer, { version: 1, kind: 'point-cloud', result: drawn })
    expect(await room.read()).toMatchObject({
      version: 1,
      state: { ensemble: { url, kind: 'point-cloud' } },
    })
  })
})

describe('a look at the Room', () => {
  it('tells the hand changes since the last look, and only once', async () => {
    const { id, room } = await openRoom()
    const viewer = await joinAndSync(id)
    viewer.send({ type: 'propose', proposal: { type: 'set-render-style', style: 'ribbon' } })
    await viewer.next()

    expect(await room.look()).toMatchObject({
      ok: true,
      version: 1,
      state: { renderStyle: 'ribbon' },
      viewers: 1,
      realized: null,
      news: [{ type: 'hand', version: 1, proposal: { type: 'set-render-style', style: 'ribbon' } }],
    })
    expect(await room.look()).toMatchObject({ version: 1, news: [] })
  })

  it("leaves out the model's own changes", async () => {
    const { room } = await openRoom()
    await room.propose({ type: 'set-render-style', style: 'ribbon' })
    expect(await room.look()).toMatchObject({ version: 1, viewers: 0, news: [] })
  })

  it('tells a Viewer failing to draw a version', async () => {
    const { id, room } = await openRoom()
    await room.propose({ type: 'adjust-background', direction: 'darker' })
    const viewer = await joinAndSync(id)
    await report(viewer, { version: 1, kind: null, result: { outcome: 'failed', reason: 'out of memory' } })
    expect(await room.look()).toMatchObject({
      news: [{ type: 'failure', version: 1, reason: 'out of memory' }],
    })
  })

  it('tells the latest version a Viewer has realized', async () => {
    const { id, room } = await openRoom()
    await room.propose({ type: 'adjust-background', direction: 'darker' })
    const viewer = await joinAndSync(id)
    await report(viewer, { version: 1, kind: null, result: { outcome: 'drawn' } })
    expect(await room.look()).toMatchObject({ realized: { version: 1, result: { outcome: 'drawn' } } })
  })

  it('counts only the Viewers that have joined', async () => {
    const { id, room } = await openRoom()
    await joinAndSync(id)
    await joinAndSync(id)
    await connect(id)
    expect(await room.look()).toMatchObject({ viewers: 2 })
  })
})

describe('waiting for a change to be realized', () => {
  const drawn = { outcome: 'drawn' }

  it('answers at once that no viewer is open, when none has joined', async () => {
    const { room } = await openRoom()
    await room.propose({ type: 'adjust-background', direction: 'darker' })
    expect(await room.settle(1, 5000)).toEqual({ outcome: 'no-viewer' })
  })

  it('answers drawn when the first Viewer reports it drawn', async () => {
    const { id, room } = await openRoom()
    const viewer = await joinAndSync(id)
    await room.propose({ type: 'adjust-background', direction: 'darker' })
    await viewer.next()
    const settling = room.settle(1, 5000)
    await report(viewer, { version: 1, kind: null, result: drawn })
    expect(await settling).toEqual({ outcome: 'realized', realized: { version: 1, result: drawn } })
  })

  it('answers failed, with why, when the first Viewer reports it failed', async () => {
    const { id, room } = await openRoom()
    const viewer = await joinAndSync(id)
    await room.propose({ type: 'adjust-background', direction: 'darker' })
    await viewer.next()
    const settling = room.settle(1, 5000)
    await report(viewer, { version: 1, kind: null, result: { outcome: 'failed', reason: 'out of memory' } })
    expect(await settling).toEqual({
      outcome: 'realized',
      realized: { version: 1, result: { outcome: 'failed', reason: 'out of memory' } },
    })
  })

  it('answers at once for a version already realized', async () => {
    const { id, room } = await openRoom()
    const viewer = await joinAndSync(id)
    await room.propose({ type: 'adjust-background', direction: 'darker' })
    await viewer.next()
    await report(viewer, { version: 1, kind: null, result: drawn })
    expect(await room.settle(1, 5000)).toEqual({ outcome: 'realized', realized: { version: 1, result: drawn } })
  })

  it('takes a later version realized as standing for it', async () => {
    const { id, room } = await openRoom()
    const viewer = await joinAndSync(id)
    await room.propose({ type: 'adjust-background', direction: 'darker' })
    await room.propose({ type: 'adjust-background', direction: 'darker' })
    const settling = room.settle(1, 5000)
    await report(viewer, { version: 2, kind: null, result: drawn })
    expect(await settling).toEqual({ outcome: 'realized', realized: { version: 2, result: drawn } })
  })

  it('gives up, still drawing, when no Viewer reports in time', async () => {
    const { id, room } = await openRoom()
    await joinAndSync(id)
    await room.propose({ type: 'adjust-background', direction: 'darker' })
    expect(await room.settle(1, 50)).toEqual({ outcome: 'still-drawing' })
  })

  // Each of these would answer the same after the wait's full ten seconds; the test's own
  // two-second limit tells them apart. A Room handles its calls in order, so once a later call is
  // answered, the wait has begun.
  it('answers that no viewer is open as soon as the last Viewer leaves', { timeout: 2000 }, async () => {
    const { id, room } = await openRoom()
    const viewer = await joinAndSync(id)
    await room.propose({ type: 'adjust-background', direction: 'darker' })
    const settling = room.settle(1, 10_000)
    await room.read()
    viewer.close()
    expect(await settling).toEqual({ outcome: 'no-viewer' })
  })

  it('keeps waiting while another Viewer stays', async () => {
    const { id, room } = await openRoom()
    const [leaving, staying] = [await joinAndSync(id), await joinAndSync(id)]
    await room.propose({ type: 'adjust-background', direction: 'darker' })
    const settling = room.settle(1, 10_000)
    leaving.close()
    await staying.next()
    await report(staying, { version: 1, kind: null, result: drawn })
    expect(await settling).toMatchObject({ outcome: 'realized' })
  })

  it('gives up, still drawing, as soon as the Room expires', { timeout: 2000 }, async () => {
    const { id, room } = await openRoom()
    await joinAndSync(id)
    await room.propose({ type: 'adjust-background', direction: 'darker' })
    const settling = room.settle(1, 10_000)
    await room.read()
    await runDurableObjectAlarm(room)
    expect(await settling).toEqual({ outcome: 'still-drawing' })
  })
})

/** A Room's answer as the state message a Viewer would hear. */
function versioned(result: Result) {
  if (!result.ok) throw new Error(result.message)
  return { version: result.version, state: result.state }
}

describe('the camera', () => {
  const POSE = {
    place: { url: 'https://example.com/a.sw', groupKey: null, traceKey: '1' },
    camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } },
  }
  const room = async () => {
    const id = crypto.randomUUID()
    await env.ROOM.getByName(id).open()
    return id
  }
  /** Ask the Room who holds the camera: the holder is the Viewer that hears the question. */
  const heardBy = async (id: string, viewer: Connection) => {
    const reading = env.ROOM.getByName(id).readCamera(5000)
    const { requestId } = (await viewer.next()) as { requestId: string }
    viewer.send({ type: 'camera-answer', requestId, pose: null })
    await reading
  }

  it('has the first Viewer in hold it', async () => {
    const id = await room()
    const first = await joinAndSync(id)
    await joinAndSync(id)
    await heardBy(id, first)
  })

  it('passes to a Viewer whose person takes hold of it', async () => {
    const id = await room()
    await joinAndSync(id)
    const second = await joinAndSync(id)
    second.send({ type: 'took-camera' })
    await report(second, { version: 0, kind: null, result: { outcome: 'drawn' } })
    await heardBy(id, second)
  })

  it('passes to a Viewer whose person lets go of it', async () => {
    const id = await room()
    const first = await joinAndSync(id)
    const second = await joinAndSync(id)
    second.send({ type: 'camera-released', ...POSE })
    expect(await first.next()).toEqual({ type: 'camera-moved', ...POSE })
    await heardBy(id, second)
  })

  it('passes to a Viewer whose person resets it', async () => {
    const id = await room()
    const first = await joinAndSync(id)
    const second = await joinAndSync(id)
    second.send({ type: 'camera-reset' })
    expect(await first.next()).toEqual({ type: 'reset-camera' })
    await heardBy(id, second)
  })

  it('passes to a Viewer whose person steps to another trace', async () => {
    const id = await room()
    await env.ROOM.getByName(id).propose({ type: 'load-ensemble', url: POSE.place.url })
    const first = await joinAndSync(id)
    const second = await joinAndSync(id)
    second.send({ type: 'propose', proposal: { type: 'select-trace', key: '1' } })
    await first.next()
    await second.next()
    await heardBy(id, second)
  })

  it('passes to the longest-connected Viewer when the holder leaves', async () => {
    const id = await room()
    const first = await joinAndSync(id)
    const second = await joinAndSync(id)
    const third = await joinAndSync(id)
    third.send({ type: 'took-camera' })
    await report(third, { version: 0, kind: null, result: { outcome: 'drawn' } })
    third.close()
    await third.closed
    // A socket lingers until its close has been handled.
    await vi.waitFor(async () => {
      const count = await runInDurableObject(env.ROOM.getByName(id), (_, ctx) => ctx.getWebSockets().length)
      expect(count).toBe(2)
    })
    void second
    await heardBy(id, first)
  })

  it('relays a released pose to the others, not back, and keeps no copy', async () => {
    const id = await room()
    const first = await joinAndSync(id)
    const second = await joinAndSync(id)
    first.send({ type: 'camera-released', ...POSE })
    expect(await second.next()).toEqual({ type: 'camera-moved', ...POSE })
    const stored = await runInDurableObject(env.ROOM.getByName(id), (_, ctx) => ctx.storage.get<object>('current'))
    expect(JSON.stringify(stored)).not.toContain('position')
    await report(first, { version: 0, kind: null, result: { outcome: 'drawn' } })
  })

  it('relays a hand reset to the others', async () => {
    const id = await room()
    const first = await joinAndSync(id)
    const second = await joinAndSync(id)
    first.send({ type: 'camera-reset' })
    expect(await second.next()).toEqual({ type: 'reset-camera' })
  })

  it('asks the holder to share its pose for a Viewer that wants it, without changing the holder', async () => {
    const id = await room()
    const holder = await joinAndSync(id)
    const joiner = await joinAndSync(id)
    joiner.send({ type: 'want-camera' })
    expect(await holder.next()).toEqual({ type: 'share-camera' })
    holder.send({ type: 'camera-shared', ...POSE })
    expect(await joiner.next()).toEqual({ type: 'camera-moved', ...POSE })
    await heardBy(id, holder)
  })

  it('asks nobody when the holder itself wants the pose', async () => {
    const id = await room()
    const alone = await joinAndSync(id)
    alone.send({ type: 'want-camera' })
    await report(alone, { version: 0, kind: null, result: { outcome: 'drawn' } })
    await heardBy(id, alone)
  })

  describe('a loaded session\'s pose', () => {
    const SESSION = {
      type: 'load-session',
      ensemble: { url: POSE.place.url, groupKey: null, traceKey: '1' },
      renderStyle: 'ribbon',
      structureAppearance: emptyViewerState().structureAppearance,
      viewerSettings: {},
      camera: POSE.camera,
    } as const

    it('waits for a Viewer that joins later', async () => {
      const id = await room()
      await env.ROOM.getByName(id).propose(SESSION)
      const viewer = await join(id)
      expect(await viewer.next()).toMatchObject({ loaded: { version: 1, camera: POSE.camera } })
    })

    it('is gone once a Viewer has drawn the load', async () => {
      const id = await room()
      await env.ROOM.getByName(id).propose(SESSION)
      const viewer = await joinAndSync(id)
      await report(viewer, { version: 1, kind: 'trace', result: { outcome: 'drawn' } })
      const late = await join(id)
      expect(await late.next()).toMatchObject({ loaded: { version: 1, camera: null } })
    })

    it('stays while a Viewer has only failed to draw the load', async () => {
      const id = await room()
      await env.ROOM.getByName(id).propose(SESSION)
      const viewer = await joinAndSync(id)
      await report(viewer, { version: 1, kind: null, result: { outcome: 'failed', reason: 'no' } })
      const late = await join(id)
      expect(await late.next()).toMatchObject({ loaded: { version: 1, camera: POSE.camera } })
    })

    it('is gone once the Room moves to another trace, or the camera is reset', async () => {
      const id = await room()
      const stub = env.ROOM.getByName(id)
      await stub.propose(SESSION)
      await stub.propose({ type: 'select-trace', key: '2' })
      expect(await (await join(id)).next()).toMatchObject({ loaded: { version: 1, camera: null } })

      const other = await room()
      const otherStub = env.ROOM.getByName(other)
      await otherStub.propose(SESSION)
      expect(await otherStub.resetCamera(10)).toBe('no-viewer')
      expect(await (await join(other)).next()).toMatchObject({ loaded: { version: 1, camera: null } })
    })
  })
})

describe('the highlight', () => {
  const PLACE = { url: 'https://example.com/a.sw', groupKey: null, traceKey: '1' }
  const SELECTION = [{ index: 4, interpolant: 0.5 }]
  const room = async () => {
    const id = crypto.randomUUID()
    await env.ROOM.getByName(id).open()
    return id
  }
  /** What a Viewer hears next, once the Room has handled all it sent before: a join's resync if nothing else. */
  const nextAfterAll = async (viewer: Connection) => {
    viewer.send({ type: 'join', protocol: PROTOCOL_VERSION })
    return viewer.next()
  }

  it('reaches every other Viewer, and not the one pointing', async () => {
    const id = await room()
    const pointing = await joinAndSync(id)
    const second = await joinAndSync(id)
    const third = await joinAndSync(id)
    pointing.send({ type: 'highlighted', place: PLACE, selection: SELECTION })
    const moved = { type: 'highlight-moved', place: PLACE, selection: SELECTION }
    expect(await second.next()).toEqual(moved)
    expect(await third.next()).toEqual(moved)
    expect(await nextAfterAll(pointing)).toMatchObject({ type: 'state' })
  })

  it('is kept nowhere, and does not keep the Room alive', async () => {
    const id = await room()
    const pointing = await joinAndSync(id)
    const other = await joinAndSync(id)
    const stub = env.ROOM.getByName(id)
    const before = await runInDurableObject(stub, async (_, ctx) => {
      await ctx.storage.deleteAlarm()
      return Object.fromEntries(await ctx.storage.list())
    })
    pointing.send({ type: 'highlighted', place: PLACE, selection: SELECTION })
    await other.next()
    const after = await runInDurableObject(stub, async (_, ctx) => ({
      stored: Object.fromEntries(await ctx.storage.list()),
      alarm: await ctx.storage.getAlarm(),
    }))
    expect(after).toEqual({ stored: before, alarm: null })
  })

  /** Close a Viewer and wait for the Room to have handled it. */
  const leave = async (id: string, viewer: Connection, remaining: number) => {
    viewer.close()
    await viewer.closed
    await vi.waitFor(async () => {
      const count = await runInDurableObject(env.ROOM.getByName(id), (_, ctx) => ctx.getWebSockets().length)
      expect(count).toBe(remaining)
    })
  }

  it('is cleared for the others when the Viewer that pointed last leaves', async () => {
    const id = await room()
    const pointing = await joinAndSync(id)
    const other = await joinAndSync(id)
    pointing.send({ type: 'highlighted', place: PLACE, selection: SELECTION })
    await other.next()
    await leave(id, pointing, 1)
    expect(await other.next()).toEqual({ type: 'highlight-moved', place: PLACE, selection: [] })
  })

  it('is not cleared again when a Viewer that has cleared leaves', async () => {
    const id = await room()
    const pointing = await joinAndSync(id)
    const other = await joinAndSync(id)
    pointing.send({ type: 'highlighted', place: PLACE, selection: SELECTION })
    pointing.send({ type: 'highlighted', place: PLACE, selection: [] })
    await other.next()
    await other.next()
    await leave(id, pointing, 1)
    expect(await nextAfterAll(other)).toMatchObject({ type: 'state' })
  })

  it('is not cleared when a Viewer that never pointed leaves', async () => {
    const id = await room()
    const idle = await joinAndSync(id)
    const other = await joinAndSync(id)
    await leave(id, idle, 1)
    expect(await nextAfterAll(other)).toMatchObject({ type: 'state' })
  })

  it("is not cleared when a Viewer leaves after another took over the pointing", async () => {
    const id = await room()
    const first = await joinAndSync(id)
    const second = await joinAndSync(id)
    const watching = await joinAndSync(id)
    first.send({ type: 'highlighted', place: PLACE, selection: SELECTION })
    await watching.next()
    second.send({ type: 'highlighted', place: PLACE, selection: SELECTION })
    await watching.next()
    await leave(id, first, 2)
    expect(await nextAfterAll(watching)).toMatchObject({ type: 'state' })
  })
})
