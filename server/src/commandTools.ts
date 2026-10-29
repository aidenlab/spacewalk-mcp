import type { ZodRawShape } from 'zod'
import type { Proposal } from '@aidenlab/spacewalk-remote/protocol'

/**
 * A tool whose whole job is one proposal to the Room. It is registered with a `room` argument
 * beside its own, and its proposal is made from its own arguments.
 */
export interface CommandTool {
  name: string
  title: string
  description: string
  inputSchema: ZodRawShape
  proposal: (args: Record<string, unknown>) => Proposal
}

/**
 * The command tools, one row each. Adding one is adding a row here; the Room already applies
 * every proposal the protocol has. The ensemble, rendering and scene tools arrive as rows.
 */
export const COMMAND_TOOLS: CommandTool[] = []
