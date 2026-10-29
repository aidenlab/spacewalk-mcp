import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { COMMAND_TOOLS, type CommandTool } from './commandTools.ts'
import {
  JOIN_CARD_HTML,
  JOIN_CARD_META,
  JOIN_CARD_MIME_TYPE,
  JOIN_CARD_TOOL_META,
  JOIN_CARD_URI,
  type JoinCardContent,
} from './joinCard.ts'
import type { Refusal, Result, Room } from './room.ts'
import { mintRoomId, parseRoomId } from './roomId.ts'

export interface ToolDeps {
  /** The Viewer's address; a Room link is this URL carrying `?room=`. */
  viewerUrl: string
  /** The Room with this id. */
  roomById: (roomId: string) => DurableObjectStub<Room>
  /**
   * The Room id this conversation's Host gives it, if any: under ChatGPT, derived from
   * `x-openai-session`. `open_viewer` without `room` opens it instead of a new one, and a tool
   * called without `room` acts on it.
   */
  hostRoomId: string | null
}

/**
 * Every tool but `open_viewer` names its Room: the model is told the id by `open_viewer`. Only
 * under ChatGPT may it be left out, for the conversation's own Room.
 */
const ROOM_ARGUMENT = z
  .string()
  .optional()
  .describe('The Room id Spacewalk was opened with, as given in the reply of open_viewer. Pass it on every call.')

/** `open_viewer`'s own `room`: the first time there is none to pass. */
const REOPEN_ROOM_ARGUMENT = z
  .string()
  .optional()
  .describe(
    'Only when Spacewalk was already opened in this conversation: the Room id from that reply of open_viewer, to get the same Room back. Leave it out the first time: Spacewalk then opens in a new Room, empty.',
  )

function errorReply(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true }
}

/**
 * The Room id the model passed as `room`, read as it may write it; null when it left `room` out
 * or passed it empty; or an error reply when it is not a Room id.
 */
function givenRoomId(room: string | undefined): string | null | { refusal: ReturnType<typeof errorReply> } {
  if (room === undefined || room.trim() === '') return null
  const roomId = parseRoomId(room)
  if (roomId !== null) return roomId
  return { refusal: errorReply(`"${room}" is not a Room id. Pass the Room id from the reply of open_viewer.`) }
}

/** Why a proposal did not take effect, told so the model knows what to do next. */
function refusalReply(roomId: string, { reason, message }: Refusal) {
  switch (reason) {
    case 'room-unknown':
      return errorReply(
        `No such Room as ${roomId}. Call open_viewer to open Spacewalk, then pass the Room id from its reply.`,
      )
    case 'room-expired':
      return errorReply(
        `Room ${roomId} has expired and what it showed is gone. To go on, call open_viewer with room ${roomId} to start it again, empty, then try again.`,
      )
    case 'refused':
      return errorReply(message)
  }
}

function roomLinkFor(viewerUrl: string, roomId: string): string {
  const roomLink = new URL(viewerUrl)
  roomLink.searchParams.set('room', roomId)
  return roomLink.toString()
}

/** The reply to an applied proposal: the version the Room has reached, and its viewer state. */
function stateReply(result: Result & { ok: true }) {
  const text = `Done. Version ${result.version}.\n\nViewer state:\n${JSON.stringify(result.state, null, 2)}`
  return { content: [{ type: 'text' as const, text }] }
}

/** Register the Join card, `open_viewer`, and a tool for each row of `commandTools`. */
export function registerTools(
  mcpServer: McpServer,
  { viewerUrl, roomById, hostRoomId }: ToolDeps,
  commandTools: CommandTool[] = COMMAND_TOOLS,
): void {
  mcpServer.registerResource(
    'Spacewalk Join card',
    JOIN_CARD_URI,
    {
      description: 'MCP App view for open_viewer: one line of status and an Open Spacewalk button',
      mimeType: JOIN_CARD_MIME_TYPE,
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: JOIN_CARD_MIME_TYPE, text: JOIN_CARD_HTML, _meta: JOIN_CARD_META }],
    }),
  )

  // Hosts that render MCP Apps show the Join card, fed from structuredContent; the others get
  // the text link.
  mcpServer.registerTool(
    'open_viewer',
    {
      title: 'Open Spacewalk',
      description:
        'Get the Room link that opens Spacewalk, a 3D viewer of chromatin structure, connected to a Room. Use this when the user asks to open Spacewalk or a 3D chromatin viewer, or says things like "open Spacewalk" or "show me the structure". A card is shown to the user with an Open Spacewalk button. If, and only if, you have the built-in browser of the Claude desktop app (the browser panel beside the conversation), open the Room link in it right away. Never use Claude in Chrome or any other browser tool for this. Do not repeat the link or the Room id in your reply. The result of this tool names the Room id: pass it as room on every later Spacewalk tool call in this conversation. A Room unused for a day expires; calling this again with its room starts it over, empty.',
      inputSchema: { room: REOPEN_ROOM_ARGUMENT },
      _meta: JOIN_CARD_TOOL_META,
    },
    async ({ room }) => {
      const given = givenRoomId(room)
      if (given !== null && typeof given === 'object') return given.refusal
      const roomId = given ?? hostRoomId ?? mintRoomId()
      // A live Room keeps what it holds; an unknown or expired one starts empty.
      await roomById(roomId).open()
      console.log(`[mcp] open_viewer | Room ${roomId}`)

      const roomLink = roomLinkFor(viewerUrl, roomId)
      const structuredContent: JoinCardContent = { room: roomId, roomLink: roomLink }
      // A bare URL on its own line: Hosts render it clickable, which a code block would not be.
      return {
        content: [
          {
            type: 'text',
            text: `Spacewalk Room link:\n${roomLink}\n\nRoom id: ${roomId}. Pass it as room on every later Spacewalk tool call in this conversation.\n\nThe user already sees a card for this. Next step: if you have the Claude desktop app's built-in browser, open this link in it now so Spacewalk shows in the panel beside the conversation. Never use Claude in Chrome or another browser tool, and if the built-in browser is unavailable do not attempt to open the link at all. Then reply in one short sentence and ask what to look at. Do not repeat the link or the Room id in your reply.`,
          },
          {
            type: 'resource_link',
            uri: roomLink,
            name: 'Open Spacewalk',
            description: 'Room link for Spacewalk',
            mimeType: 'text/html',
          },
        ],
        structuredContent,
      }
    },
  )

  // Every command tool is the same round trip: one proposal to the Room, and the version it
  // reaches, or why it refused, becomes the reply.
  for (const tool of commandTools) {
    mcpServer.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: { ...tool.inputSchema, room: ROOM_ARGUMENT },
      },
      async ({ room, ...args }: { room?: string } & Record<string, unknown>) => {
        const given = givenRoomId(room)
        if (given !== null && typeof given === 'object') return given.refusal
        const roomId = given ?? hostRoomId
        if (roomId === null) {
          return errorReply('Pass room: the Room id from the reply of open_viewer.')
        }
        const result = await roomById(roomId).propose(tool.proposal(args))
        console.log(`[mcp] ${tool.name} | Room ${roomId} | ${result.ok ? `version ${result.version}` : result.reason}`)
        if (!result.ok) return refusalReply(roomId, result)
        return stateReply(result)
      },
    )
  }
}
