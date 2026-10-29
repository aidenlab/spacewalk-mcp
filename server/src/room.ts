import { DurableObject } from 'cloudflare:workers'
import {
  PROTOCOL_VERSION,
  Proposal,
  ViewerMessage,
  type EnsembleKind,
  type ErrorCode,
  type Realization,
  type RealizedMessage,
  type RoomMessage,
  type StateMessage,
  type ViewerState,
} from '@aidenlab/spacewalk-remote/protocol'
import { apply, emptyViewerState, withKind } from './viewerState.ts'

/** A Room unused for this long expires. */
const IDLE_LIFETIME_MS = 24 * 60 * 60 * 1000

/** The viewer state at a version. */
export interface Versioned {
  version: number
  state: ViewerState
}

/**
 * Why a Room did not do what it was asked: it was never opened, it has expired (only opening it
 * again helps, and that starts it empty), or the proposal does not apply to the current state.
 */
export type Reason = 'room-unknown' | 'room-expired' | 'refused'

/** The Room did not do what it was asked, and says why. */
export interface Refusal {
  ok: false
  reason: Reason
  message: string
}

export type Result = ({ ok: true } & Versioned) | Refusal

/** A version some Viewer has realized, as its first report of it said. */
export interface Realized {
  version: number
  result: Realization
}

/** A Viewer's report that it failed to draw a version. */
export interface Failure {
  version: number
  reason: string
}

export type RealizedResult = { ok: true; latest: Realized | null; failures: Failure[] } | Refusal

/** What a live Room stores: its current version, and the version that loaded its ensemble. */
interface Current extends Versioned {
  loadedAt: number | null
}

/** What a Viewer shows when its Room has expired. */
const EXPIRED_MESSAGE = 'This Room has expired.'

/** What the Room keeps on each socket, surviving hibernation. */
interface Attachment {
  joined: boolean
}

// Storage keys. A live Room holds CURRENT, and REALIZED and FAILURES once Viewers report; an
// expired one holds only EXPIRED, its last version.
const CURRENT = 'current'
const REALIZED = 'realized'
const FAILURES = 'failures'
const EXPIRED = 'expired'

/** The most failures a Room keeps; older ones are dropped. */
const FAILURES_KEPT = 100

/**
 * A Room: ties one conversation to the Viewers showing its 3D view, and holds its viewer state
 * (ADR 0001). The Room is the state's only author: it applies proposals in the order they
 * arrive, gives each result a new version and broadcasts it to every Viewer. A day without use
 * and it expires, losing its contents for good.
 */
export class Room extends DurableObject<Env> {
  /**
   * Open the Room: a live Room keeps what it holds; a Room never opened starts empty at version
   * 0, and an expired one starts empty at the version after its last, so that no Viewer takes
   * the new state for one it has already seen. Only `open_viewer` calls this.
   */
  async open(): Promise<Result> {
    let current = await this.ctx.storage.get<Current>(CURRENT)
    if (!current) {
      const expiredAt = await this.ctx.storage.get<number>(EXPIRED)
      const version = expiredAt === undefined ? 0 : expiredAt + 1
      current = { version, state: emptyViewerState(), loadedAt: null }
      await this.ctx.storage.delete(EXPIRED)
      await this.ctx.storage.put(CURRENT, current)
    }
    await this.touch()
    return versioned(current)
  }

  /**
   * Apply a proposal to the current viewer state, giving the result a new version. The Room
   * checks the proposal itself: hand changes arrive from Viewers.
   */
  async propose(proposal: Proposal): Promise<Result> {
    const current = await this.live()
    if (!current.ok) return current
    await this.touch()

    const parsed = Proposal.safeParse(proposal)
    if (!parsed.success) {
      const message = `Malformed proposal: ${parsed.error.message}`
      return { ok: false, reason: 'refused', message }
    }
    const result = apply(current.state, parsed.data)
    if (!result.ok) return { ok: false, reason: 'refused', message: result.refusal }
    const version = current.version + 1
    const loadedAt = parsed.data.type === 'load-ensemble' ? version : current.loadedAt
    const next: Current = { version, state: result.state, loadedAt }
    await this.ctx.storage.put(CURRENT, next)
    this.broadcast(next)
    return versioned(next)
  }

  /**
   * Record the kind of ensemble a Viewer drew at `version`, from its realized report. It counts
   * only if that version shows the ensemble loaded now: a report on an earlier load, even of the
   * same URL, changes nothing. Not a proposal, so no new version: the Viewer has already drawn
   * this one, and a new one would only ask it to draw the same thing again.
   */
  async recordKind(version: number, kind: EnsembleKind): Promise<Result> {
    const current = await this.live()
    if (!current.ok) return current
    await this.touch()

    const { loadedAt } = current
    if (loadedAt === null || version < loadedAt || version > current.version) {
      return versioned(current)
    }
    const next: Current = { ...current, state: withKind(current.state, kind) }
    await this.ctx.storage.put(CURRENT, next)
    return versioned(next)
  }

  /** The viewer state at its current version. */
  async read(): Promise<Result> {
    const current = await this.live()
    if (!current.ok) return current
    await this.touch()
    return versioned(current)
  }

  /** A Viewer's WebSocket upgrade, from `/ws`: accept it and wait for it to join. */
  async fetch(): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * A message from a Viewer's socket. Until it has joined, a socket is heard only to join: it has
   * not yet shown it speaks this protocol.
   */
  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    const message = parseViewerMessage(data)
    if (!message.ok) {
      send(socket, { type: 'error', code: 'malformed-message', message: message.error })
      // It may have been a hand change: put it back.
      return hasJoined(socket) ? this.resync(socket) : undefined
    }
    if (message.data.type === 'join') return this.join(socket, message.data.protocol)
    if (!hasJoined(socket)) return
    switch (message.data.type) {
      case 'propose':
        return this.proposeByHand(socket, message.data.proposal)
      case 'realized':
        return this.realize(message.data)
    }
  }

  /** A Viewer joins: it gets the current version, as every resync does. */
  private async join(socket: WebSocket, protocol: number) {
    if (protocol !== PROTOCOL_VERSION) {
      return refuse(socket, 'protocol-mismatch', 'This viewer is out of date: reload the viewer.')
    }
    const current = await this.read()
    if (current.ok) {
      socket.serializeAttachment({ joined: true } satisfies Attachment)
      return socket.send(stateMessage(current))
    }
    this.refuseGone(socket, current.reason)
  }

  /**
   * The Room has expired or was never opened: tell the Viewer which, and let it go. Only a
   * proposal is ever 'refused', so for the Room itself that reason never arises.
   */
  private refuseGone(socket: WebSocket, reason: Reason) {
    if (reason === 'room-expired') return refuse(socket, 'room-expired', EXPIRED_MESSAGE)
    refuse(socket, 'room-unknown', 'No such Room.')
  }

  /**
   * A Viewer's hand change. Applied, it reaches every Viewer by broadcast; refused, only its Viewer
   * hears why, and is resynced to put the change back.
   */
  private async proposeByHand(socket: WebSocket, proposal: Proposal) {
    const result = await this.propose(proposal)
    if (result.ok) return
    if (result.reason !== 'refused') return this.refuseGone(socket, result.reason)
    send(socket, { type: 'error', code: 'proposal-refused', message: result.message })
    await this.resync(socket)
  }

  /** Send a joined Viewer the current version, putting back whatever it has changed by hand. */
  private async resync(socket: WebSocket) {
    const current = await this.read()
    if (current.ok) socket.send(stateMessage(current))
  }

  /**
   * A Viewer's realized report. The first report of a version wins, and stands for every version
   * before it; a later one, or one on an older version, changes nothing. A failure is kept
   * whichever Viewer reports it, as is the ensemble's kind. A report on a version the Room has
   * not reached is ignored.
   */
  private async realize({ version, kind, result }: RealizedMessage) {
    const current = await this.live()
    if (!current.ok || version > current.version) return

    const latest = await this.latestRealized()
    if (latest === null || version > latest.version) {
      await this.ctx.storage.put(REALIZED, { version, result } satisfies Realized)
    }
    if (result.outcome === 'failed') {
      const failures = await this.failures()
      failures.push({ version, reason: result.reason })
      await this.ctx.storage.put(FAILURES, failures.slice(-FAILURES_KEPT))
    }
    if (kind !== null) await this.recordKind(version, kind)
    else await this.touch()
  }

  /**
   * What Viewers have reported realized: the latest version realized, with its first report, and
   * the failures any Viewer has reported, oldest first.
   */
  async realized(): Promise<RealizedResult> {
    const current = await this.live()
    if (!current.ok) return current
    await this.touch()
    return { ok: true, latest: await this.latestRealized(), failures: await this.failures() }
  }

  private async latestRealized(): Promise<Realized | null> {
    return (await this.ctx.storage.get<Realized>(REALIZED)) ?? null
  }

  private async failures(): Promise<Failure[]> {
    return (await this.ctx.storage.get<Failure[]>(FAILURES)) ?? []
  }

  /** A day has passed without use: expire, and let every Viewer go. */
  async alarm(): Promise<void> {
    const current = await this.ctx.storage.get<Current>(CURRENT)
    if (!current) return
    await this.ctx.storage.deleteAll()
    await this.ctx.storage.put(EXPIRED, current.version)
    for (const socket of this.ctx.getWebSockets()) {
      refuse(socket, 'room-expired', EXPIRED_MESSAGE)
    }
  }

  /** The current version, or why there is none. */
  private async live(): Promise<({ ok: true } & Current) | Refusal> {
    const current = await this.ctx.storage.get<Current>(CURRENT)
    if (current) return { ok: true, ...current }
    if ((await this.ctx.storage.get<number>(EXPIRED)) !== undefined) {
      return {
        ok: false,
        reason: 'room-expired',
        message: 'This Room has expired. Call open_viewer to start it again, empty.',
      }
    }
    return { ok: false, reason: 'room-unknown', message: 'No such Room. Call open_viewer.' }
  }

  /** The Room has been used: it expires a day from now. */
  private async touch() {
    await this.ctx.storage.setAlarm(Date.now() + IDLE_LIFETIME_MS)
  }

  /** Send a version to every Viewer in the Room. */
  private broadcast({ version, state }: Versioned) {
    const message = stateMessage({ version, state })
    for (const socket of this.viewers()) socket.send(message)
  }

  /** The sockets that have joined: those that speak this protocol and have had a first sync. */
  private viewers(): WebSocket[] {
    return this.ctx.getWebSockets().filter(hasJoined)
  }
}

/** A successful result: the version and its viewer state, and nothing the Room keeps to itself. */
function versioned({ version, state }: Versioned): Result {
  return { ok: true, version, state }
}

/** A version as the message that tells a Viewer about it. */
function stateMessage({ version, state }: Versioned): string {
  return JSON.stringify({ type: 'state', version, state } satisfies StateMessage)
}

/** Tell a Viewer why the Room will not have it, and let it go. */
function refuse(socket: WebSocket, code: ErrorCode, message: string) {
  send(socket, { type: 'error', code, message })
  socket.close(1000, code)
}

function send(socket: WebSocket, message: RoomMessage) {
  socket.send(JSON.stringify(message))
}

/** Whether a socket has joined the Room. */
function hasJoined(socket: WebSocket): boolean {
  const attachment = socket.deserializeAttachment() as Attachment | null
  return attachment?.joined === true
}

/** A Viewer's message, or what is wrong with it. */
function parseViewerMessage(
  data: string | ArrayBuffer,
): { ok: true; data: ViewerMessage } | { ok: false; error: string } {
  let json: unknown
  try {
    json = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data))
  } catch {
    return { ok: false, error: 'Not JSON.' }
  }
  const parsed = ViewerMessage.safeParse(json)
  if (!parsed.success) return { ok: false, error: parsed.error.message }
  return { ok: true, data: parsed.data }
}
