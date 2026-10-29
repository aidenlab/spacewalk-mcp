import { PROTOCOL_VERSION, ViewerMessage } from '@aidenlab/spacewalk-remote/protocol'
import { expect, it } from 'vitest'

// The Worker takes the protocol from the remote workspace, so the two cannot disagree (ADR 0003).
it('reads a join in the protocol the remote package defines', () => {
  const join = ViewerMessage.parse({ type: 'join', protocol: PROTOCOL_VERSION })
  expect(join).toEqual({ type: 'join', protocol: PROTOCOL_VERSION })
})
