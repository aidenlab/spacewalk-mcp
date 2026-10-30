import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Proposal } from '@aidenlab/spacewalk-remote/protocol'
import { z } from 'zod'
import { COMMAND_TOOLS, ENSEMBLE_POINTER, type CommandTool } from './commandTools.ts'
import { exampleEnsembles, exampleListReply, type ExampleEnsembles } from './exampleEnsembles.ts'
import {
  JOIN_CARD_HTML,
  JOIN_CARD_META,
  JOIN_CARD_MIME_TYPE,
  JOIN_CARD_TOOL_META,
  JOIN_CARD_URI,
  type JoinCardContent,
} from './joinCard.ts'
import { changeReply, lookReply } from './reply.ts'
import type { Refusal, Room } from './room.ts'
import { mintRoomId, parseRoomId } from './roomId.ts'
import { readSession, shorten, snapshotUrl, type Fetch } from './session.ts'

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
  /** How long a change waits for a Viewer to report it realized; 20 s unless a test says less. */
  realizeTimeoutMs?: number
  /** The example ensembles; R2's list, kept a few minutes, unless a test gives its own. */
  exampleEnsembles?: ExampleEnsembles
  /** The network, for shortening a URL and following a short one; the Worker's unless a test says. */
  fetch?: Fetch
}

/** How long a change waits for the first Viewer to report it realized. */
const REALIZE_TIMEOUT_MS = 20_000

/**
 * The example list from R2. Every request gets a fresh McpServer, so the list is kept here, for
 * as long as the isolate lives.
 */
const EXAMPLE_ENSEMBLES = exampleEnsembles()

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
    'Only when Spacewalk was already opened in this conversation: the Room id from that reply of open_viewer, to get the same Room back. Leave it out the first time: Spacewalk then opens in a new Room, empty. A Room id that was never opened is refused.',
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

/** The Room a tool acts on: the one the model named, or the Host's own; or an error reply. */
function roomToActOn(room: string | undefined, hostRoomId: string | null) {
  const given = givenRoomId(room)
  if (given !== null && typeof given === 'object') return given
  const roomId = given ?? hostRoomId
  if (roomId === null) return { refusal: errorReply('Pass room: the Room id from the reply of open_viewer.') }
  return { roomId }
}

function roomLinkFor(viewerUrl: string, roomId: string): string {
  const roomLink = new URL(viewerUrl)
  roomLink.searchParams.set('room', roomId)
  return roomLink.toString()
}

/**
 * Register the Join card, `open_viewer`, the tools that only read, `load_session`, and a tool for
 * each row of `commandTools`.
 */
export function registerTools(
  mcpServer: McpServer,
  {
    viewerUrl,
    roomById,
    hostRoomId,
    realizeTimeoutMs = REALIZE_TIMEOUT_MS,
    exampleEnsembles: examples = EXAMPLE_ENSEMBLES,
    fetch = (url, init) => globalThis.fetch(url, init),
  }: ToolDeps,
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
      // A live Room keeps what it holds; an expired one starts empty. A room the model gives must
      // have been opened before, but the Host's own Room and a new one need not.
      const roomId = given ?? hostRoomId ?? mintRoomId()
      const opened = given === null ? await roomById(roomId).open() : await roomById(roomId).reopen()
      if (!opened.ok) {
        return errorReply(
          `No Room ${roomId} was ever opened. Check the Room id against the reply of open_viewer, or call open_viewer without room to open a new Room.`,
        )
      }
      console.log(`[mcp] open_viewer | Room ${roomId}`)
      const look = await roomById(roomId).look()

      const roomLink = roomLinkFor(viewerUrl, roomId)
      const structuredContent: JoinCardContent = { room: roomId, roomLink: roomLink }
      // A bare URL on its own line: Hosts render it clickable, which a code block would not be.
      return {
        content: [
          {
            type: 'text',
            text: `Spacewalk Room link:\n${roomLink}\n\nRoom id: ${roomId}. Pass it as room on every later Spacewalk tool call in this conversation.\n\nThe user already sees a card for this. Next step: if you have the Claude desktop app's built-in browser, open this link in it now so Spacewalk shows in the panel beside the conversation. Never use Claude in Chrome or another browser tool, and if the built-in browser is unavailable do not attempt to open the link at all. Then reply in one short sentence and ask what to look at. Do not repeat the link or the Room id in your reply.${look.ok ? `\n\n${lookReply(look)}` : ''}`,
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

  // Not a change: the list is R2's, not the Room's, so no room is needed.
  mcpServer.registerTool(
    'list_example_ensembles',
    {
      title: 'List the example ensembles',
      description:
        `List example ensembles to load into Spacewalk: the hosted .sw files of the full Spacewalk app's Load From List, by group, each with its name and URL. ${ENSEMBLE_POINTER} Use this when the user asks what there is to look at, or names an example without its URL; then pass the URL to load_ensemble.`,
      inputSchema: {},
    },
    async () => {
      try {
        return { content: [{ type: 'text' as const, text: exampleListReply(await examples()) }] }
      } catch (error) {
        console.error('[mcp] list_example_ensembles:', error)
        return errorReply(
          'Could not get the list of example ensembles just now. Try again later, or ask the user for the URL of a .sw file to pass to load_ensemble.',
        )
      }
    },
  )

  // Not a change: the Room as it is, and an error only when there is no Room to read.
  mcpServer.registerTool(
    'read_viewer_state',
    {
      title: 'Read the viewer state',
      description:
        'Read what Spacewalk shows now, without changing it: the viewer state, how many Viewers are connected, and what changed since your last reply that you did not cause. An error only when the Room is unknown or expired.',
      inputSchema: { room: ROOM_ARGUMENT },
    },
    async ({ room }) => {
      const acting = roomToActOn(room, hostRoomId)
      if ('refusal' in acting) return acting.refusal
      const look = await roomById(acting.roomId).look()
      if (!look.ok) return refusalReply(acting.roomId, look)
      return { content: [{ type: 'text' as const, text: lookReply(look) }] }
    },
  )

  // Not a change: a Room-free snapshot of what the Room shows now.
  mcpServer.registerTool(
    'get_shareable_url',
    {
      title: 'Get a shareable URL',
      description:
        'Get a URL that opens a frozen snapshot of what Spacewalk shows now: the ensemble, its place, the structure appearance, the viewer settings and the camera. It has no Room: whoever opens it sees that snapshot and later changes do not reach it. To bring someone into the Room itself, give them the Room link instead.',
      inputSchema: { room: ROOM_ARGUMENT },
    },
    async ({ room }) => {
      const acting = roomToActOn(room, hostRoomId)
      if ('refusal' in acting) return acting.refusal
      const look = await roomById(acting.roomId).look()
      if (!look.ok) return refusalReply(acting.roomId, look)
      if (!look.state.ensemble) {
        return errorReply(`No ensemble is loaded, so there is nothing to share.\n${lookReply(look)}`)
      }
      const url = await shorten(await snapshotUrl(viewerUrl, look.state), fetch)
      console.log(`[mcp] get_shareable_url | Room ${acting.roomId}`)
      return { content: [{ type: 'text' as const, text: `Shareable URL:\n${url}\n\n${lookReply(look)}` }] }
    },
  )

  /**
   * The round trip of a change: one proposal to the Room, a wait for a Viewer to realize it, and a
   * look at the Room; or why it refused, which becomes the reply. `told` goes before the outcome.
   */
  const change = async (name: string, roomId: string, proposal: Proposal, told: string[] = []) => {
    const stub = roomById(roomId)
    const result = await stub.propose(proposal)
    console.log(`[mcp] ${name} | Room ${roomId} | ${result.ok ? `version ${result.version}` : result.reason}`)
    if (!result.ok) return refusedReply(roomId, result)
    const settled = await stub.settle(result.version, realizeTimeoutMs)
    const look = await stub.look()
    if (!look.ok) return refusalReply(roomId, look)
    const text = [...told, changeReply(result.version, settled, look)].join('\n')
    return { content: [{ type: 'text' as const, text }] }
  }

  /** Why a change did not happen; in a live Room, the model still sees what it holds and what changed. */
  const refusedReply = async (roomId: string, refusal: Refusal) => {
    if (refusal.reason === 'refused') {
      const look = await roomById(roomId).look()
      if (look.ok) return errorReply(`${refusal.message}\n${lookReply(look)}`)
    }
    return refusalReply(roomId, refusal)
  }

  mcpServer.registerTool(
    'load_session',
    {
      title: 'Load a session',
      description:
        'Load a Spacewalk session into the Room: what it shows, from a shareable URL of the full Spacewalk app or of this viewer, or from a bare session string. Only the Spacewalk part is read; the reply says what was ignored, such as IGV tracks and the Hi-C map. A URL that merely points at a session file to fetch is refused. To load a .sw file, use load_ensemble.',
      inputSchema: {
        session: z.string().min(1).describe('A shareable URL, or a session string (blob:…).'),
        room: ROOM_ARGUMENT,
      },
    },
    async ({ session, room }) => {
      const acting = roomToActOn(room, hostRoomId)
      if ('refusal' in acting) return acting.refusal
      const read = await readSession(session, fetch)
      if (!read.ok) return refusedReply(acting.roomId, { ok: false, reason: 'refused', message: read.message })
      return change('load_session', acting.roomId, read.proposal, read.notes)
    },
  )

  for (const tool of commandTools) {
    mcpServer.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: { ...tool.inputSchema, room: ROOM_ARGUMENT },
      },
      async ({ room, ...args }: { room?: string } & Record<string, unknown>) => {
        const acting = roomToActOn(room, hostRoomId)
        if ('refusal' in acting) return acting.refusal
        return change(tool.name, acting.roomId, tool.proposal(args))
      },
    )
  }
}
