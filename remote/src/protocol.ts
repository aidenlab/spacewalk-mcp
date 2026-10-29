/**
 * The wire protocol between a Viewer (`@aidenlab/spacewalk-remote`) and a Room on the
 * spacewalk-mcp server. The Worker imports it from the workspace through
 * `@aidenlab/spacewalk-remote/protocol`, so the two ends cannot disagree about it (ADR 0003).
 * No DOM.
 */
import { z } from 'zod'

/**
 * The protocol version. A Viewer sends it when it joins, and a Room refuses a Viewer that
 * speaks another one. Bump it on any change a Viewer and a Room could not both survive.
 */
export const PROTOCOL_VERSION = 1

/** Viewer → Room, first on every connection: the protocol version the Viewer speaks. */
export const JoinMessage = z.object({
  type: z.literal('join'),
  protocol: z.int(),
})
export type JoinMessage = z.infer<typeof JoinMessage>

/** Every message a Viewer sends a Room. */
export const ViewerMessage = z.discriminatedUnion('type', [JoinMessage])
export type ViewerMessage = z.infer<typeof ViewerMessage>

/** Why a Room refused a Viewer. */
export const ErrorCode = z.enum([
  // The Viewer speaks another protocol version: reload the viewer.
  'protocol-mismatch',
  // The Room has expired and never gets its contents back.
  'room-expired',
])
export type ErrorCode = z.infer<typeof ErrorCode>

/** Room → Viewer: a refusal, with an optional message for a person to read. */
export const ErrorMessage = z.object({
  type: z.literal('error'),
  code: ErrorCode,
  message: z.string().optional(),
})
export type ErrorMessage = z.infer<typeof ErrorMessage>

/** Every message a Room sends a Viewer. */
export const RoomMessage = z.discriminatedUnion('type', [ErrorMessage])
export type RoomMessage = z.infer<typeof RoomMessage>
