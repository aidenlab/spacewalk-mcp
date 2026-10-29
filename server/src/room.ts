import { DurableObject } from 'cloudflare:workers'
import {
  Proposal,
  type EnsembleKind,
  type ErrorMessage,
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

export type Result = ({ ok: true } & Versioned) | { ok: false; reason: Reason; message: string }

// Storage keys. A live Room holds CURRENT; an expired one holds only EXPIRED.
const CURRENT = 'current'
const EXPIRED = 'expired'

/**
 * A Room: ties one conversation to the Viewers showing its 3D view, and holds its viewer state
 * (ADR 0001). The Room is the state's only author: it applies proposals in the order they
 * arrive, gives each result a new version and broadcasts it to every Viewer. A day without use
 * and it expires, losing its contents for good.
 */
export class Room extends DurableObject<Env> {
  /**
   * Open the Room: a live Room keeps what it holds; a Room never opened, or expired, starts
   * empty at version 0. Only `open_viewer` calls this.
   */
  async open(): Promise<Result> {
    let current = await this.ctx.storage.get<Versioned>(CURRENT)
    if (!current) {
      current = { version: 0, state: emptyViewerState() }
      await this.ctx.storage.delete(EXPIRED)
      await this.ctx.storage.put(CURRENT, current)
    }
    await this.touch()
    return { ok: true, ...current }
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
      return { ok: false, reason: 'refused', message: `Malformed proposal: ${parsed.error.message}` }
    }
    const result = apply(current.state, parsed.data)
    if (!result.ok) return { ok: false, reason: 'refused', message: result.refusal }
    const next: Versioned = { version: current.version + 1, state: result.state }
    await this.ctx.storage.put(CURRENT, next)
    this.broadcast(next)
    return { ok: true, ...next }
  }

  /**
   * Record the kind of the ensemble at `url`, from a Viewer's realized report. Not a proposal, so
   * no new version: the Viewer that reported it has already realized this version, and a new one
   * would only ask it to realize the same drawing again.
   */
  async recordKind(url: string, kind: EnsembleKind): Promise<Result> {
    const current = await this.live()
    if (!current.ok) return current
    await this.touch()

    const next: Versioned = { version: current.version, state: withKind(current.state, url, kind) }
    await this.ctx.storage.put(CURRENT, next)
    return { ok: true, ...next }
  }

  /** The viewer state at its current version. */
  async read(): Promise<Result> {
    const current = await this.live()
    if (!current.ok) return current
    await this.touch()
    return current
  }

  /** A day has passed without use: expire, and let every Viewer go. */
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll()
    await this.ctx.storage.put(EXPIRED, true)

    const message = JSON.stringify({
      type: 'error',
      code: 'room-expired',
      message: 'This Room has expired.',
    } satisfies ErrorMessage)
    for (const socket of this.ctx.getWebSockets()) {
      socket.send(message)
      socket.close(1000, 'room-expired')
    }
  }

  /** The current version, or why there is none. */
  private async live(): Promise<Result> {
    const current = await this.ctx.storage.get<Versioned>(CURRENT)
    if (current) return { ok: true, ...current }
    if (await this.ctx.storage.get<boolean>(EXPIRED)) {
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
    const message = JSON.stringify({ type: 'state', version, state } satisfies StateMessage)
    for (const socket of this.ctx.getWebSockets()) socket.send(message)
  }
}
