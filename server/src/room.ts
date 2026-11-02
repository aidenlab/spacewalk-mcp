import { DurableObject } from 'cloudflare:workers'
import {
  PROTOCOL_VERSION,
  Proposal,
  ViewerMessage,
  isSamePlace,
  type Camera,
  type EnsembleKind,
  type ErrorCode,
  type Place,
  type PlacedCamera,
  type PlacedHighlight,
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

/**
 * Something that happened in the Room that the model did not cause: a hand change the Room
 * applied, or a Viewer's failure to draw a version.
 */
export type News =
  | { type: 'hand'; version: number; proposal: Proposal }
  | ({ type: 'failure' } & Failure)

export type RealizedResult = { ok: true; latest: Realized | null; failures: Failure[] } | Refusal

/**
 * How a change came out: realized by the first Viewer to report it or a later version that stood
 * for it, drawn or failed; still drawing when none did in time; or not shown, when no Viewer is
 * open.
 */
export type Settled =
  | { outcome: 'realized'; realized: Realized }
  | { outcome: 'still-drawing' }
  | { outcome: 'no-viewer' }

/** The Room as the model sees it in a reply: what it shows, to how many, and what is new. */
export interface Look extends Versioned {
  ok: true
  /** The Viewers that have joined. */
  viewers: number
  /** The latest version a Viewer has realized, if any has. */
  realized: Realized | null
  /** What the model did not cause since its last look, oldest first. */
  news: News[]
}

/**
 * What a reading of the camera pose came to (ADR 0005). `camera` is null, for a snapshot to open
 * framed, when `missing` says why: no Viewer is open, the holder did not answer in time or had
 * nothing to answer with, or it answered for a place the Room has moved on from.
 */
export type CameraReading =
  | { camera: Camera; missing: null }
  | { camera: null; missing: 'no-viewer' | 'no-answer' | 'other-place' }

/** How a reset came out: the holder confirmed it, did not in time, or no Viewer is open. */
export type CameraResetOutcome = 'confirmed' | 'no-answer' | 'no-viewer'

/**
 * What a live Room stores: its current version, the version that loaded its ensemble, and that
 * load's camera pose while no Viewer has drawn it. The Room holds no other pose (ADR 0005).
 */
interface Current extends Versioned {
  loadedAt: number | null
  loadedCamera: Camera | null
}

/** What a Viewer shows when its Room has expired. */
const EXPIRED_MESSAGE = 'This Room has expired.'

/** A tool call waiting for `version` to be realized, and how to answer it. */
interface Waiter {
  version: number
  settled: (settled: Settled) => void
}

/**
 * What the Room keeps on each socket, surviving hibernation: that it joined and when, whether
 * it holds the camera, and the place of its highlight if it pointed last. Kept here, each record
 * goes with the socket. With none marked, the longest-connected Viewer holds the camera
 * (ADR 0005); the highlight itself is never kept (ADR 0006).
 */
interface Attachment {
  joined: boolean
  joinedAt: number
  holdsCamera: boolean
  /** Set while this Viewer's highlight is the one shown; absent on a socket that joined before it. */
  highlighted?: Place | null
}

// Storage keys. A live Room holds CURRENT, and REALIZED and FAILURES once Viewers report, and
// NEWS until the model looks; an expired one holds only EXPIRED, its last version.
const CURRENT = 'current'
const REALIZED = 'realized'
const FAILURES = 'failures'
const NEWS = 'news'
const EXPIRED = 'expired'

/** The most failures, and the most news, a Room keeps; older ones are dropped. */
const FAILURES_KEPT = 100
const NEWS_KEPT = 100

/**
 * A Room: ties one conversation to the Viewers showing its 3D view, and holds its viewer state
 * (ADR 0001). The Room is the state's only author: it applies proposals in the order they
 * arrive, gives each result a new version and broadcasts it to every Viewer. A day without use
 * and it expires, losing its contents for good.
 */
export class Room extends DurableObject<Env> {
  /** Those waiting for a version to be realized. In memory: a wait never outlives its call. */
  private waiting: Waiter[] = []

  /** Questions put to the holder, by request id. In memory: a wait never outlives its call. */
  private asked = new Map<string, (answer: PlacedCamera | null) => void>()

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
      current = { version, state: emptyViewerState(), loadedAt: null, loadedCamera: null }
      await this.ctx.storage.delete(EXPIRED)
      await this.ctx.storage.put(CURRENT, current)
    }
    await this.touch()
    return versioned(current)
  }

  /** The model's proposal: applied as any other, but no news to the model. */
  async propose(proposal: Proposal): Promise<Result> {
    return this.applyProposal(proposal, false)
  }

  /**
   * Apply a proposal to the current viewer state, giving the result a new version. The Room
   * checks the proposal itself: hand changes arrive from Viewers, and are news to the model.
   */
  private async applyProposal(proposal: Proposal, byHand: boolean): Promise<Result> {
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
    const next: Current = { version, state: result.state, ...afterLoad(current, parsed.data, version) }
    await this.ctx.storage.put(CURRENT, next)
    if (byHand) await this.tell({ type: 'hand', version, proposal: parsed.data })
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
      case 'took-camera':
        await this.touch()
        return this.giveCameraTo(socket)
      case 'camera-released':
        await this.touch()
        this.giveCameraTo(socket)
        return this.relay(socket, cameraMoved(message.data))
      case 'camera-reset':
        await this.touch()
        this.giveCameraTo(socket)
        await this.forgetLoadedCamera()
        return this.relay(socket, { type: 'reset-camera' })
      case 'want-camera': {
        const holder = this.holder()
        if (holder !== undefined && holder !== socket) send(holder, { type: 'share-camera' })
        return
      }
      case 'camera-shared':
        return this.relay(socket, cameraMoved(message.data))
      case 'camera-answer':
        return this.answered(message.data.requestId, message.data.pose)
      case 'camera-reset-done':
        return this.answered(message.data.requestId, null)
      case 'highlighted':
        return this.relayHighlight(socket, message.data)
    }
  }

  /**
   * Relay a highlight to the others, and remember which Viewer's is shown, so that a clear follows
   * it out if it leaves. Kept nowhere else, and no touch: a highlight comes at pointer speed, and
   * alone does not keep the Room alive (ADR 0006).
   */
  private relayHighlight(socket: WebSocket, { place, selection }: PlacedHighlight) {
    const pointing = selection.length > 0
    for (const viewer of this.viewers()) {
      const attachment = attachmentOf(viewer)
      if (viewer === socket) {
        viewer.serializeAttachment({ ...attachment, highlighted: pointing ? place : null } satisfies Attachment)
      } else if (pointing && attachment.highlighted) {
        // Another Viewer's highlight now shows in place of this one's.
        viewer.serializeAttachment({ ...attachment, highlighted: null } satisfies Attachment)
      }
    }
    this.relay(socket, { type: 'highlight-moved', place, selection })
  }

  /** Make this Viewer the one camera holder. */
  private giveCameraTo(socket: WebSocket) {
    for (const viewer of this.viewers()) {
      const holdsCamera = viewer === socket
      viewer.serializeAttachment({ ...attachmentOf(viewer), holdsCamera } satisfies Attachment)
    }
  }

  /** The camera holder: the one marked, or else the longest-connected Viewer. */
  private holder(): WebSocket | undefined {
    const viewers = this.viewers()
    return (
      viewers.find((viewer) => attachmentOf(viewer).holdsCamera) ??
      viewers.toSorted((a, b) => attachmentOf(a).joinedAt - attachmentOf(b).joinedAt)[0]
    )
  }

  /** Send a message to every Viewer but the one it came from. */
  private relay(from: WebSocket, message: RoomMessage) {
    for (const viewer of this.viewers()) {
      if (viewer !== from) send(viewer, message)
    }
  }

  /** Forget a load's undelivered pose: the camera has moved on from it. */
  private async forgetLoadedCamera() {
    const current = await this.ctx.storage.get<Current>(CURRENT)
    if (current?.loadedCamera) await this.ctx.storage.put(CURRENT, { ...current, loadedCamera: null })
  }

  /** Answer the question put to the holder under this id, if it is still waiting. */
  private answered(requestId: string, pose: PlacedCamera | null) {
    this.asked.get(requestId)?.(pose)
  }

  /** Put a question to the holder and wait for its answer, or undefined after `timeoutMs`. */
  private ask(
    message: (requestId: string) => RoomMessage,
    holder: WebSocket,
    timeoutMs: number,
  ): Promise<PlacedCamera | null | undefined> {
    const requestId = crypto.randomUUID()
    return new Promise((resolve) => {
      const done = (answer: PlacedCamera | null | undefined) => {
        clearTimeout(timeout)
        this.asked.delete(requestId)
        resolve(answer)
      }
      const timeout = setTimeout(() => done(undefined), timeoutMs)
      this.asked.set(requestId, done)
      send(holder, message(requestId))
    })
  }

  /**
   * The camera pose for a snapshot of the place the Room shows now: a load's pose no Viewer has
   * drawn yet, or else a reading from the holder, taken now and kept by nobody (ADR 0005).
   */
  async readCamera(timeoutMs: number): Promise<CameraReading> {
    const current = await this.live()
    if (!current.ok) return { camera: null, missing: 'no-viewer' }
    await this.touch()
    if (current.loadedCamera) return { camera: current.loadedCamera, missing: null }
    const holder = this.holder()
    if (holder === undefined) return { camera: null, missing: 'no-viewer' }
    const pose = await this.ask((requestId) => ({ type: 'ask-camera', requestId }), holder, timeoutMs)
    if (!pose) return { camera: null, missing: 'no-answer' }
    // The Room may have moved on while it asked.
    const latest = await this.live()
    const ensemble = latest.ok ? latest.state.ensemble : null
    if (!ensemble || !isSamePlace(pose.place, ensemble)) return { camera: null, missing: 'other-place' }
    return { camera: pose.camera, missing: null }
  }

  /** Have every Viewer frame the structure, and wait for the holder to confirm. */
  async resetCamera(timeoutMs: number): Promise<CameraResetOutcome> {
    await this.touch()
    await this.forgetLoadedCamera()
    const holder = this.holder()
    if (holder === undefined) return 'no-viewer'
    this.relay(holder, { type: 'reset-camera' })
    const confirmed = await this.ask((requestId) => ({ type: 'reset-camera', requestId }), holder, timeoutMs)
    return confirmed === undefined ? 'no-answer' : 'confirmed'
  }

  /** A Viewer joins: it gets the current version, as every resync does. */
  private async join(socket: WebSocket, protocol: number) {
    if (protocol !== PROTOCOL_VERSION) {
      return refuse(socket, 'protocol-mismatch', 'This viewer is out of date: reload the viewer.')
    }
    const current = await this.live()
    if (!current.ok) return this.refuseGone(socket, current.reason)
    await this.touch()
    if (!hasJoined(socket)) {
      socket.serializeAttachment({
        joined: true,
        joinedAt: Date.now(),
        holdsCamera: false,
        highlighted: null,
      } satisfies Attachment)
    }
    socket.send(stateMessage(current))
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
    const result = await this.applyProposal(proposal, true)
    if (result.ok) {
      // A person who steps to another trace has the framing everyone now follows.
      if (proposal.type === 'select-trace' || proposal.type === 'select-ensemble-group') this.giveCameraTo(socket)
      return
    }
    if (result.reason !== 'refused') return this.refuseGone(socket, result.reason)
    send(socket, { type: 'error', code: 'proposal-refused', message: result.message })
    await this.resync(socket)
  }

  /** Send a joined Viewer the current version, putting back whatever it has changed by hand. */
  private async resync(socket: WebSocket) {
    const current = await this.live()
    if (!current.ok) return
    await this.touch()
    socket.send(stateMessage(current))
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

    // A Viewer has drawn the load, so its pose now lives in that Viewer's rig (ADR 0005).
    if (result.outcome === 'drawn' && current.loadedAt !== null && version >= current.loadedAt) {
      await this.forgetLoadedCamera()
    }

    const latest = await this.latestRealized()
    if (latest === null || version > latest.version) {
      await this.ctx.storage.put(REALIZED, { version, result } satisfies Realized)
      const realized: Settled = { outcome: 'realized', realized: { version, result } }
      this.answer(realized, (waiter) => waiter.version <= version)
    }
    if (result.outcome === 'failed') {
      const failures = await this.failures()
      failures.push({ version, reason: result.reason })
      await this.ctx.storage.put(FAILURES, failures.slice(-FAILURES_KEPT))
      await this.tell({ type: 'failure', version, reason: result.reason })
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

  /**
   * Wait up to `timeoutMs` for the first Viewer to report `version` realized. A report on a later
   * version stands for it, as for every version before it. With no Viewer joined there is nothing
   * to wait for.
   */
  async settle(version: number, timeoutMs: number): Promise<Settled> {
    const latest = await this.latestRealized()
    if (latest !== null && latest.version >= version) return { outcome: 'realized', realized: latest }
    if (this.viewers().length === 0) return { outcome: 'no-viewer' }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        version,
        settled: (settled) => {
          clearTimeout(timeout)
          resolve(settled)
        },
      }
      const timeout = setTimeout(() => this.answer({ outcome: 'still-drawing' }, (w) => w === waiter), timeoutMs)
      this.waiting.push(waiter)
    })
  }

  /** Answer, and stop waiting for, everyone waiting that `which` picks. */
  private answer(settled: Settled, which: (waiter: Waiter) => boolean = () => true) {
    const answered = this.waiting.filter(which)
    this.waiting = this.waiting.filter((waiter) => !which(waiter))
    for (const waiter of answered) waiter.settled(settled)
  }

  /** A Viewer has gone. If it was the last, no change can be shown until another opens. */
  async webSocketClose(socket: WebSocket) {
    const others = this.viewers().filter((viewer) => viewer !== socket)
    if (others.length === 0) this.answer({ outcome: 'no-viewer' })
    // Its highlight would otherwise stay up on every other screen.
    const highlighted = hasJoined(socket) ? attachmentOf(socket).highlighted : null
    if (highlighted) this.relay(socket, { type: 'highlight-moved', place: highlighted, selection: [] })
    // Answer the close, so the socket leaves the Room and cannot be taken for the camera holder.
    try {
      socket.close()
    } catch {
      // Already closed.
    }
  }

  /**
   * The Room as the model sees it: the current version, how many Viewers show it, and what it
   * did not cause since its last look. Looking clears the news: each reply tells it once.
   */
  async look(): Promise<Look | Refusal> {
    const current = await this.live()
    if (!current.ok) return current
    await this.touch()
    const news = await this.news()
    await this.ctx.storage.delete(NEWS)
    const { version, state } = current
    const realized = await this.latestRealized()
    return { ok: true, version, state, viewers: this.viewers().length, realized, news }
  }

  /**
   * How many Viewers have joined: a check that the Room is live and someone is looking. A use of
   * the Room, but not a look, so the news is kept for the model's next one.
   */
  async viewerCount(): Promise<{ ok: true; viewers: number } | Refusal> {
    const current = await this.live()
    if (!current.ok) return current
    await this.touch()
    return { ok: true, viewers: this.viewers().length }
  }

  /** Keep news for the model's next look. */
  private async tell(item: News) {
    const news = await this.news()
    news.push(item)
    await this.ctx.storage.put(NEWS, news.slice(-NEWS_KEPT))
  }

  private async latestRealized(): Promise<Realized | null> {
    return (await this.ctx.storage.get<Realized>(REALIZED)) ?? null
  }

  private async news(): Promise<News[]> {
    return (await this.ctx.storage.get<News[]>(NEWS)) ?? []
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
    // Nothing will be drawn now: stop waiting.
    this.answer({ outcome: 'still-drawing' })
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
  private broadcast(current: Current) {
    const message = stateMessage(current)
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

/** What a proposal makes of the record of the latest load (ADR 0005). */
function afterLoad(current: Current, proposal: Proposal, version: number): Pick<Current, 'loadedAt' | 'loadedCamera'> {
  switch (proposal.type) {
    case 'load-ensemble':
      return { loadedAt: version, loadedCamera: null }
    case 'load-session':
      return { loadedAt: version, loadedCamera: proposal.camera }
    case 'select-trace':
    case 'select-ensemble-group':
      // A pose means nothing in any other place.
      return { loadedAt: current.loadedAt, loadedCamera: null }
    default:
      return { loadedAt: current.loadedAt, loadedCamera: current.loadedCamera }
  }
}

/** A version as the message that tells a Viewer about it. */
function stateMessage({ version, state, loadedAt, loadedCamera }: Current): string {
  const loaded = loadedAt === null ? null : { version: loadedAt, camera: loadedCamera ?? null }
  return JSON.stringify({ type: 'state', version, state, loaded } satisfies StateMessage)
}

/** A Viewer's pose as the message that tells the others. */
function cameraMoved({ place, camera }: PlacedCamera): RoomMessage {
  return { type: 'camera-moved', place, camera }
}

/** Tell a Viewer why the Room will not have it, and let it go. */
function refuse(socket: WebSocket, code: ErrorCode, message: string) {
  send(socket, { type: 'error', code, message })
  socket.close(1000, code)
}

function send(socket: WebSocket, message: RoomMessage) {
  socket.send(JSON.stringify(message))
}

/** What the Room keeps on a joined socket. */
function attachmentOf(socket: WebSocket): Attachment {
  return socket.deserializeAttachment() as Attachment
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
