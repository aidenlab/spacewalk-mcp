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
