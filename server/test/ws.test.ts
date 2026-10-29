import { env, runDurableObjectAlarm } from 'cloudflare:test'
import { PROTOCOL_VERSION } from '@aidenlab/spacewalk-remote/protocol'
import { describe, expect, it } from 'vitest'
import type { Result } from '../src/room.ts'
import { connect, join, joinAndSync, report, upgrade, VIEWER_ORIGIN } from './viewer.ts'

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
    expect(await viewer.next()).toEqual({ type: 'state', ...versioned(await room.read()) })
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
    await room.propose({ type: 'reset-camera' })
    for (const viewer of viewers) expect(await viewer.next()).toMatchObject({ version: 1 })
  })

  it('hears nothing until it joins', async () => {
    const { id, room } = await openRoom()
    const early = await connect(id)
    await room.propose({ type: 'reset-camera' })
    await room.propose({ type: 'reset-camera' })
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
    await room.propose({ type: 'reset-camera' })
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
    await room.propose({ type: 'reset-camera' })
    const [first, second] = [await joinAndSync(id), await joinAndSync(id)]
    await report(first, { version: 1, kind: null, result: drawn })
    await report(second, { version: 1, kind: null, result: failed('out of memory') })
    expect(await room.realized()).toMatchObject({ latest: { version: 1, result: drawn } })
  })

  it('keeps the failures from every Viewer, even when another drew the version', async () => {
    const { id, room } = await openRoom()
    await room.propose({ type: 'reset-camera' })
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
    await room.propose({ type: 'reset-camera' })
    await room.propose({ type: 'reset-camera' })
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
    await room.propose({ type: 'reset-camera' })
    const viewer = await joinAndSync(id)
    await report(viewer, { version: 1, kind: null, result: { outcome: 'failed', reason: 'out of memory' } })
    expect(await room.look()).toMatchObject({
      news: [{ type: 'failure', version: 1, reason: 'out of memory' }],
    })
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
    await room.propose({ type: 'reset-camera' })
    expect(await room.settle(1, 5000)).toEqual({ outcome: 'no-viewer' })
  })

  it('answers drawn when the first Viewer reports it drawn', async () => {
    const { id, room } = await openRoom()
    const viewer = await joinAndSync(id)
    await room.propose({ type: 'reset-camera' })
    await viewer.next()
    const settling = room.settle(1, 5000)
    await report(viewer, { version: 1, kind: null, result: drawn })
    expect(await settling).toEqual({ outcome: 'drawn' })
  })

  it('answers failed, with why, when the first Viewer reports it failed', async () => {
    const { id, room } = await openRoom()
    const viewer = await joinAndSync(id)
    await room.propose({ type: 'reset-camera' })
    await viewer.next()
    const settling = room.settle(1, 5000)
    await report(viewer, { version: 1, kind: null, result: { outcome: 'failed', reason: 'out of memory' } })
    expect(await settling).toEqual({ outcome: 'failed', reason: 'out of memory' })
  })

  it('answers at once for a version already realized', async () => {
    const { id, room } = await openRoom()
    const viewer = await joinAndSync(id)
    await room.propose({ type: 'reset-camera' })
    await viewer.next()
    await report(viewer, { version: 1, kind: null, result: drawn })
    expect(await room.settle(1, 5000)).toEqual({ outcome: 'drawn' })
  })

  it('takes a later version realized as standing for it', async () => {
    const { id, room } = await openRoom()
    const viewer = await joinAndSync(id)
    await room.propose({ type: 'reset-camera' })
    await room.propose({ type: 'reset-camera' })
    const settling = room.settle(1, 5000)
    await report(viewer, { version: 2, kind: null, result: drawn })
    expect(await settling).toEqual({ outcome: 'drawn' })
  })

  it('gives up, still drawing, when no Viewer reports in time', async () => {
    const { id, room } = await openRoom()
    await joinAndSync(id)
    await room.propose({ type: 'reset-camera' })
    expect(await room.settle(1, 50)).toEqual({ outcome: 'still-drawing' })
  })
})

/** A Room's answer as the state message a Viewer would hear. */
function versioned(result: Result) {
  if (!result.ok) throw new Error(result.message)
  return { version: result.version, state: result.state }
}
