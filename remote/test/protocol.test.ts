import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, RoomMessage, ViewerMessage } from '../src/protocol.ts'

describe('a Viewer joining a Room', () => {
  it('sends a join carrying the protocol version', () => {
    const result = ViewerMessage.safeParse({ type: 'join', protocol: PROTOCOL_VERSION })
    expect(result.success).toBe(true)
  })

  it('cannot join without saying which protocol version it speaks', () => {
    expect(ViewerMessage.safeParse({ type: 'join' }).success).toBe(false)
    expect(ViewerMessage.safeParse({ type: 'join', protocol: '1' }).success).toBe(false)
  })
})

describe('a Room refusing a Viewer', () => {
  it('says the Viewer speaks another protocol version, with a message to show', () => {
    const result = RoomMessage.safeParse({
      type: 'error',
      code: 'protocol-mismatch',
      message: 'Reload the viewer.',
    })
    expect(result.success).toBe(true)
  })

  it('says the Room has expired', () => {
    expect(RoomMessage.safeParse({ type: 'error', code: 'room-expired' }).success).toBe(true)
  })

  it('names only a reason the protocol knows', () => {
    expect(RoomMessage.safeParse({ type: 'error', code: 'teapot' }).success).toBe(false)
  })
})

describe('a Viewer reporting a version realized', () => {
  it('says it drew it, and the kind of ensemble it shows', () => {
    const report = { type: 'realized', version: 3, kind: 'trace', result: { outcome: 'drawn' } }
    expect(ViewerMessage.safeParse(report).success).toBe(true)
  })

  it('cannot report a failure without a reason', () => {
    const report = { type: 'realized', version: 3, kind: null, result: { outcome: 'failed' } }
    expect(ViewerMessage.safeParse(report).success).toBe(false)
  })
})

describe('a highlight', () => {
  const place = { url: 'https://example.com/a.sw', groupKey: null, traceKey: '1' }

  it('names a place and up to two points along its trace, an index missing over a gap', () => {
    const selection = [{ index: 4, interpolant: 0.25 }, { interpolant: 1 }]
    expect(ViewerMessage.safeParse({ type: 'highlighted', place, selection }).success).toBe(true)
    expect(RoomMessage.safeParse({ type: 'highlight-moved', place, selection }).success).toBe(true)
  })

  it('is cleared with an empty selection', () => {
    expect(ViewerMessage.safeParse({ type: 'highlighted', place, selection: [] }).success).toBe(true)
  })

  it('holds no more than two points, each between the ends of its segment', () => {
    const three = [{ interpolant: 0 }, { interpolant: 0.5 }, { interpolant: 1 }]
    expect(ViewerMessage.safeParse({ type: 'highlighted', place, selection: three }).success).toBe(false)
    const beyond = [{ index: 2, interpolant: 1.5 }]
    expect(ViewerMessage.safeParse({ type: 'highlighted', place, selection: beyond }).success).toBe(false)
  })
})
