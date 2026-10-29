/**
 * `attachRemote`: connects a Viewer to its Room over `/ws?room=`. The Room is authoritative
 * (ADR 0001): the Viewer draws every viewer state the Room broadcasts, proposes hand changes,
 * and reports each version realized. How to draw is the Viewer's own: it passes `draw`, and the
 * library never touches the scene or the DOM.
 */
import {
  PROTOCOL_VERSION,
  RoomMessage,
  type EnsembleKind,
  type ErrorCode,
  type Proposal,
  type RealizedMessage,
  type StateMessage,
  type ViewerMessage,
  type ViewerState,
} from './protocol.ts'

/** How the Viewer's attempt to draw a version went, and the kind of ensemble it shows. */
export interface Drawing {
  /** The ensemble's kind, once the Viewer knows it; null when it does not, or nothing is loaded. */
  kind: EnsembleKind | null
  /** Why the Viewer could not draw the version; absent when it was drawn. */
  failure?: string
}

/** A WebSocket as the library uses it: the platform's, or a test's fake. */
export interface Socket {
  readonly readyState: number
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
}

export interface AttachOptions {
  /** The Room's `/ws` endpoint, an absolute URL, e.g. `wss://spacewalk-mcp.3dg.io/ws`. */
  url: string
  /** The Room id, from the Room link. */
  room: string
  /**
   * Draw the viewer state at `version`. Resolve when it is drawn, or failed: a throw is a failure
   * too. Every state the Room sends is drawn, the same version again on a resync, so the Viewer
   * puts back what it shows by hand.
   */
  draw(state: ViewerState, version: number): Drawing | Promise<Drawing>
  /** Told how the connection stands; see `Status`. */
  onStatus?(status: Status): void
  /**
   * How long a dragged change (structure appearance, viewer settings) must stay still before the
   * gesture counts as ended and the change is proposed. Default 250 ms.
   */
  gestureEndMs?: number
  /** Defaults to the platform WebSocket. */
  createSocket?(url: string): Socket
}

/**
 * How the connection stands. `closed` is passing: the library reconnects. `ended` is for good:
 * the Viewer shows `message` in place of the Room.
 */
export type Status =
  | { type: 'connecting' }
  | { type: 'open' }
  | { type: 'closed' }
  | { type: 'ended'; reason: EndReason; message: string }

/** Why a Room let a Viewer go for good. */
export type EndReason = Extract<ErrorCode, 'protocol-mismatch' | 'room-expired' | 'room-unknown'>

/** What the Viewer shows when its Room lets it go, the library's words whatever the Room said. */
export const END_MESSAGES: Record<EndReason, string> = {
  'protocol-mismatch': 'This viewer is out of date: reload the viewer.',
  'room-expired': 'This Room has expired.',
  'room-unknown': 'There is no such Room.',
}

/** A Viewer attached to a Room. */
export interface Remote {
  /**
   * Offer a hand change for the Room to apply. A dragged change, to structure appearance or viewer
   * settings, waits for the gesture to end and goes as one, the patches merged; any other goes at
   * once, after whatever dragged change is waiting. The Viewer proposes the camera at orbit end,
   * not on every frame of it. While a state is being drawn, a proposal that would change nothing
   * in it is the Viewer's change listeners echoing the Room's change, and is dropped; a listener
   * that fires after `draw` resolves is the Viewer's to quiet. Dropped while disconnected, since
   * the resync on rejoining wins.
   */
  propose(proposal: Proposal): void
  /** Close the connection for good: no reconnect, and no further calls to the Viewer. */
  detach(): void
}

const OPEN = 1

const GESTURE_END_MS = 250

/** The wait before reconnecting grows a second each attempt, to this most. */
const MAX_RECONNECT_DELAY_MS = 5000

/** Attach a Viewer to its Room. Throws at once if `url` is not an absolute URL. */
export function attachRemote(options: AttachOptions): Remote {
  const { draw, onStatus, gestureEndMs = GESTURE_END_MS } = options
  const url = new URL(options.url)
  url.searchParams.set('room', options.room)
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as Socket)
  let socket: Socket | null = null
  let detached = false
  // Attempts since a connection last opened: the wait before the next grows with them.
  let attempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  function connect() {
    onStatus?.({ type: 'connecting' })
    const current = createSocket(url.toString())
    socket = current
    current.onopen = () => {
      if (current !== socket) return
      attempts = 0
      onStatus?.({ type: 'open' })
      send({ type: 'join', protocol: PROTOCOL_VERSION })
    }
    current.onmessage = (event) => {
      if (current !== socket) return
      const message = parseRoomMessage(event.data)
      if (message === null) return
      if (message.type === 'state') return receive(message)
      if (isEndReason(message.code)) end(message.code)
      // A refused hand change, or a message the Room did not know: the resync that follows
      // puts the Viewer right.
    }
    // A close event follows every error.
    current.onerror = () => {}
    current.onclose = () => {
      if (current !== socket) return
      socket = null
      onStatus?.({ type: 'closed' })
      reconnect()
    }
  }

  /** Connect again, after a wait; the Room resyncs the Viewer when it joins. */
  function reconnect() {
    attempts += 1
    const delay = Math.min(1000 * attempts, MAX_RECONNECT_DELAY_MS)
    reconnectTimer = setTimeout(connect, delay)
  }

  // The latest state the Room sent that is not yet being drawn, and the one being drawn.
  let next: StateMessage | null = null
  let drawing: ViewerState | null = null

  /** Draw a state the Room sent once the one being drawn is done; one sent later replaces it. */
  function receive(message: StateMessage) {
    next = message
    if (drawing === null) void realizeAll()
  }

  async function realizeAll() {
    while (next !== null && !detached) {
      const { state, version } = next
      next = null
      drawing = state
      await realize(state, version)
    }
    drawing = null
  }

  /** Draw a version and report it realized: drawn, or failed. */
  async function realize(state: ViewerState, version: number) {
    const drawn = await tryDraw(state, version)
    const realized: RealizedMessage = {
      type: 'realized',
      version,
      kind: drawn.kind,
      result:
        drawn.failure === undefined
          ? { outcome: 'drawn' }
          : { outcome: 'failed', reason: drawn.failure },
    }
    send(realized)
  }

  /** How the Viewer's `draw` went, a throw counted as a failure. */
  async function tryDraw(state: ViewerState, version: number): Promise<Drawing> {
    try {
      return await draw(state, version)
    } catch (error) {
      return { kind: null, failure: error instanceof Error ? error.message : String(error) }
    }
  }

  function send(message: ViewerMessage): boolean {
    if (socket === null || socket.readyState !== OPEN) return false
    socket.send(JSON.stringify(message))
    return true
  }

  /** Stop for good: no reconnect, and nothing more to the Viewer. */
  function stop() {
    detached = true
    clearTimeout(reconnectTimer)
    clearTimeout(gestureTimer)
    dragged = null
    const current = socket
    socket = null
    current?.close()
  }

  /** The Room has let the Viewer go for good. */
  function end(reason: EndReason) {
    stop()
    onStatus?.({ type: 'ended', reason, message: END_MESSAGES[reason] })
  }

  // A dragged change waiting for its gesture to end.
  let dragged: Dragged | null = null
  let gestureTimer: ReturnType<typeof setTimeout> | undefined

  function propose(proposal: Proposal) {
    if (detached) return
    if (drawing !== null && changesNothing(proposal, drawing)) return
    if (!isDragged(proposal)) {
      endGesture()
      send({ type: 'propose', proposal })
      return
    }
    if (dragged !== null && dragged.type !== proposal.type) endGesture()
    dragged = dragged === null ? proposal : merge(dragged, proposal)
    clearTimeout(gestureTimer)
    gestureTimer = setTimeout(endGesture, gestureEndMs)
  }

  /** Propose the dragged change waiting, if there is one. */
  function endGesture() {
    clearTimeout(gestureTimer)
    if (dragged === null) return
    const proposal = dragged
    dragged = null
    send({ type: 'propose', proposal })
  }

  connect()
  return { propose, detach: stop }
}

/** A change a person makes by dragging: it waits for the gesture to end. */
type Dragged = Extract<Proposal, { type: 'set-structure-appearance' | 'set-viewer-settings' }>

function isDragged(proposal: Proposal): proposal is Dragged {
  return proposal.type === 'set-structure-appearance' || proposal.type === 'set-viewer-settings'
}

/** Two dragged changes of one type as one, the later winning field by field. */
function merge(earlier: Dragged, later: Dragged): Dragged {
  if (earlier.type === 'set-structure-appearance' && later.type === 'set-structure-appearance') {
    return { type: earlier.type, patch: { ...earlier.patch, ...later.patch } }
  }
  if (earlier.type === 'set-viewer-settings' && later.type === 'set-viewer-settings') {
    const a = earlier.patch
    const b = later.patch
    const patch: typeof a = { ...a, ...b }
    for (const fixture of ['gnomon', 'groundPlane', 'referenceRuler'] as const) {
      if (a[fixture] !== undefined && b[fixture] !== undefined) {
        patch[fixture] = { ...a[fixture], ...b[fixture] }
      }
    }
    return { type: earlier.type, patch }
  }
  return later
}

/**
 * Whether a proposal would leave `state` as it is: what a Viewer's change listeners propose as
 * it draws `state`. A step or a reset always changes something.
 */
function changesNothing(proposal: Proposal, state: ViewerState): boolean {
  switch (proposal.type) {
    case 'load-ensemble':
      return state.ensemble?.url === proposal.url
    case 'select-ensemble-group':
      return state.ensemble?.groupKey === proposal.key
    case 'select-trace':
      return state.ensemble?.traceKey === proposal.key
    case 'set-render-style':
      return state.renderStyle === proposal.style
    case 'set-structure-appearance':
      return within(proposal.patch, state.structureAppearance)
    case 'set-viewer-settings':
      return within(proposal.patch, state.viewerSettings)
    case 'set-camera':
      return state.camera !== null && within(proposal.camera, state.camera)
    default:
      return false
  }
}

/** Whether every field of `patch`, however deep, has its value in `whole`. */
function within(patch: object, whole: object): boolean {
  return Object.entries(patch).every(([key, value]) => {
    const current = (whole as Record<string, unknown>)[key]
    if (typeof value === 'object' && value !== null) {
      return typeof current === 'object' && current !== null && within(value, current)
    }
    return value === undefined || value === current
  })
}

function isEndReason(code: ErrorCode): code is EndReason {
  return code in END_MESSAGES
}

/** A Room's message, or null for one this protocol version does not know. */
function parseRoomMessage(data: unknown): RoomMessage | null {
  if (typeof data !== 'string') return null
  let json: unknown
  try {
    json = JSON.parse(data)
  } catch {
    return null
  }
  const parsed = RoomMessage.safeParse(json)
  return parsed.success ? parsed.data : null
}
