/**
 * Session strings: Spacewalk's compressed session payload, here only at the edges of the Room,
 * written for a shareable URL and read when a session is loaded. The shapes are spacewalk's
 * `development-notes/spacewalk-mcp/session-format.md`; the spelling is igv-utils' `BGZip`.
 */
import {
  Camera,
  Color,
  RADIUS_LADDER_LENGTH,
  SceneFixture,
  type Proposal,
  type RenderStyle,
  type StructureAppearance,
  type ViewerSettingsPatch,
  type ViewerState,
} from '@aidenlab/spacewalk-remote/protocol'
import { z } from 'zod'
import { emptyViewerState } from './viewerState.ts'

/** The network, as the tools reach for it. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** The full app's shortener (spacewalk `workers/sw-shortlink`). */
const SHORTENER_URL = 'https://spacewalk.aidenlab.org/shorten'

/** How long a shortener, or a short URL, gets to answer. */
const NETWORK_TIMEOUT_MS = 5000

/** The hosts of the short URLs the full app has given out. */
const SHORT_LINK_HOSTS = ['t.3dg.io', 'tinyurl.com']

/** Marks a real data URI, as distinct from a `data:`-prefixed BGZip payload. */
const GZIP_DATA_URI_MARKER = '/gzip;base64'

const RENDER_STYLE_IN_SESSION = {
  'ball-and-stick': 'render-style-ball-stick',
  ribbon: 'render-style-ribbon',
} as const

/**
 * A value as a session string. Spacewalk reads the inflated bytes one to a character, so anything
 * beyond ASCII travels as a JSON escape.
 */
export async function writeSessionString(value: unknown): Promise<string> {
  const json = JSON.stringify(value).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  const bytes = Uint8Array.from(json, (c) => c.charCodeAt(0))
  const deflated = await piped(bytes, new CompressionStream('deflate-raw'))
  const encoded = btoa(String.fromCharCode(...deflated))
  return `blob:${encoded.replace(/\+/g, '.').replace(/\//g, '_').replace(/=/g, '-')}`
}

/** What a session string holds; it throws on anything that is not one. */
export async function readSessionString(sessionString: string): Promise<unknown> {
  if (sessionString.includes(GZIP_DATA_URI_MARKER)) {
    const base64 = sessionString.slice(sessionString.indexOf(',') + 1)
    return parsedBytes(await piped(fromBase64(base64), new DecompressionStream('gzip')))
  }
  const prefix = ['blob:', 'data:'].find((candidate) => sessionString.startsWith(candidate))
  if (prefix === undefined) throw new Error('Not a session string.')
  const payload = sessionString.slice(prefix.length).replace(/\./g, '+').replace(/_/g, '/').replace(/-/g, '=')
  return parsedBytes(await piped(fromBase64(payload), new DecompressionStream('deflate-raw')))
}

function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
}

function parsedBytes(bytes: Uint8Array): unknown {
  return JSON.parse(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))
}

async function piped(bytes: Uint8Array<ArrayBuffer>, through: CompressionStream | DecompressionStream) {
  const stream = new Blob([bytes]).stream().pipeThrough(through)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * The snapshot URL of a viewer state with an ensemble: the viewer page with the session block and,
 * beside it, the viewer settings (ADR 0002). Both raw, as the full app writes its parameters.
 */
export async function snapshotUrl(viewerUrl: string, state: ViewerState): Promise<string> {
  const url = new URL(viewerUrl)
  const session = await writeSessionString(sessionBlock(state))
  const settings = await writeSessionString(state.viewerSettings)
  url.search = `?spacewalkSessionURL=${session}&viewerSettings=${settings}`
  return url.toString()
}

/**
 * The `spacewalk` block of a viewer state. The Room has no locus and no panels: only the full app
 * reads those, and a snapshot opens on the viewer page. Nor has it a camera projection: Spacewalk
 * keeps the one it framed the ensemble with, and warns that it could not read the camera's.
 */
function sessionBlock({ ensemble, renderStyle, structureAppearance, camera }: ViewerState) {
  return {
    url: ensemble?.url,
    // Spacewalk reads the trace with parseInt: it must be there, and the default is the first.
    traceKey: ensemble?.traceKey ?? '0',
    ensembleGroupKey: ensemble?.groupKey ?? undefined,
    renderStyle: RENDER_STYLE_IN_SESSION[renderStyle],
    structureAppearance,
    // Spacewalk spells a camera's target tx, ty, tz.
    cameraLightingRig: camera
      ? {
          position: camera.position,
          target: { tx: camera.target.x, ty: camera.target.y, tz: camera.target.z },
        }
      : undefined,
  }
}

/**
 * A URL shortened as the full app does, asking from the URL's own origin, which is all the shortener
 * answers. Any failure hands the long URL back: it still works.
 */
export async function shorten(url: string, fetch: Fetch): Promise<string> {
  try {
    const response = await fetch(SHORTENER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: new URL(url).origin },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const short = ((await response.json()) as { data?: { tiny_url?: unknown } }).data?.tiny_url
    if (typeof short !== 'string') throw new Error('No short URL in the answer')
    return short
  } catch (error) {
    console.warn('[mcp] shortening failed, giving the long URL:', error)
    return url
  }
}

/** A session as the Room can load it, and what to tell the model about it; or why it cannot. */
export type ReadSession =
  | { ok: true; proposal: Extract<Proposal, { type: 'load-session' }>; notes: string[] }
  | { ok: false; message: string }

const NO_SESSION =
  'That URL carries no Spacewalk session: no spacewalkSessionURL parameter. To load a .sw file, use load_ensemble.'

/**
 * Read what load_session is given: a shareable URL from either app, short or long, or a bare session
 * string. Only the Spacewalk block is read. A short URL is the one thing fetched, and only for where
 * it leads; a session is never fetched from a URL.
 */
export async function readSession(given: string, fetch: Fetch): Promise<ReadSession> {
  const text = given.trim()
  if (!isWebUrl(text)) {
    if (!/^(blob|data):/.test(text)) {
      return { ok: false, message: 'That is neither a shareable URL nor a session string.' }
    }
    return readParts({ session: text })
  }
  const followed = isShortLink(text) ? await followShortLink(text, fetch) : text
  if (followed === null) {
    return { ok: false, message: `Could not follow the short URL ${text}. Ask the user for the long URL.` }
  }
  const parameters = launchParameters(followed)
  // As in the full app, a file wins over any session.
  const session = parameters.has('file') ? undefined : parameters.get('spacewalkSessionURL')
  if (!session) return { ok: false, message: NO_SESSION }
  return readParts({
    session,
    settings: parameters.get('viewerSettings'),
    hasIgv: parameters.has('sessionURL'),
    hasHicMap: parameters.has('session'),
  })
}

function isWebUrl(text: string): boolean {
  return /^https?:\/\//i.test(text)
}

function isShortLink(url: string): boolean {
  try {
    const { hostname, search } = new URL(url)
    return SHORT_LINK_HOSTS.includes(hostname) && search === ''
  } catch {
    return false
  }
}

/** Where a short URL leads, from its redirect, without going there; null when it does not say. */
async function followShortLink(url: string, fetch: Fetch): Promise<string | null> {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) })
    return response.status >= 300 && response.status < 400 ? response.headers.get('Location') : null
  } catch (error) {
    console.warn('[mcp] following a short URL failed:', error)
    return null
  }
}

/**
 * The parameters of a launch URL, read as Spacewalk's `launchIntent.js` reads them: the query
 * decoded once, whole, and then split, so that old percent-encoded links read too.
 */
function launchParameters(url: string): Map<string, string> {
  const query = url.split('#')[0].split('?').slice(1).join('?')
  let decoded = query
  try {
    decoded = decodeURIComponent(query)
  } catch {
    // Not percent-encoded after all; the parameters are as they stand.
  }
  const pairs = decoded.split('&').map((pair) => {
    const at = pair.indexOf('=')
    return at === -1 ? ([pair, ''] as const) : ([pair.slice(0, at), pair.slice(at + 1)] as const)
  })
  return new Map(pairs)
}

interface SessionParts {
  session: string
  settings?: string
  hasIgv?: boolean
  hasHicMap?: boolean
}

async function readParts({ session, settings, hasIgv, hasHicMap }: SessionParts): Promise<ReadSession> {
  if (isWebUrl(session)) {
    return { ok: false, message: `Spacewalk does not fetch a session from a URL: ${session}. Ask the user for a shareable URL or a session string.` }
  }
  let json: unknown
  try {
    json = await readSessionString(session)
  } catch (error) {
    console.warn('[mcp] reading a session string failed:', error)
    return { ok: false, message: 'That session string could not be read.' }
  }
  const record = asRecord(json)
  // A saved session file holds { spacewalk, igv?, juicebox? }; a launch URL, the block alone.
  const whole = asRecord(record.spacewalk) !== NOTHING
  const block = whole ? asRecord(record.spacewalk) : record
  if (!z.url().safeParse(block.url).success) return { ok: false, message: 'That session names no ensemble.' }

  const { patch, note } = await readViewerSettings(settings)
  const notes = [
    ignored(hasIgv || (whole && 'igv' in record), hasHicMap || (whole && 'juicebox' in record)),
    note,
  ].filter((line) => line !== null)
  return {
    ok: true,
    notes,
    proposal: {
      type: 'load-session',
      ensemble: {
        url: block.url as string,
        groupKey: typeof block.ensembleGroupKey === 'string' ? block.ensembleGroupKey : null,
        traceKey: typeof block.traceKey === 'string' ? block.traceKey : null,
      },
      renderStyle: readRenderStyle(block.renderStyle),
      structureAppearance: readStructureAppearance(asRecord(block.structureAppearance)),
      viewerSettings: patch,
      camera: readCamera(block.cameraLightingRig),
    },
  }
}

/** A value as a record of its fields; NOTHING when it is not one. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : NOTHING
}
const NOTHING: Record<string, unknown> = {}

/** What the Spacewalk block left behind, for the model to tell the user. */
function ignored(igv: boolean | undefined, hicMap: boolean | undefined): string | null {
  if (igv && hicMap) return 'IGV tracks and the Hi-C map in this session were not loaded.'
  if (igv) return 'The IGV tracks in this session were not loaded.'
  if (hicMap) return 'The Hi-C map in this session was not loaded.'
  return null
}

/**
 * The render style a block names. A point-cloud ensemble is drawn as a point cloud whatever this
 * says, so its render style, like any other this does not know, reads as the default.
 */
function readRenderStyle(value: unknown): RenderStyle {
  return value === RENDER_STYLE_IN_SESSION.ribbon ? 'ribbon' : emptyViewerState().renderStyle
}

/** A block's structure appearance, field by field, as Spacewalk's `structureAppearance.js` reads it. */
function readStructureAppearance(record: Record<string, unknown>): StructureAppearance {
  const values = emptyViewerState().structureAppearance
  const rung = (value: unknown, otherwise: number) =>
    Number.isInteger(value) ? Math.min(Math.max(value as number, 0), RADIUS_LADDER_LENGTH - 1) : otherwise
  const isPositive = (value: unknown): value is number => Number.isFinite(value) && (value as number) > 0
  return {
    ballRadiusIndex: rung(record.ballRadiusIndex, values.ballRadiusIndex),
    stickRadiusIndex: rung(record.stickRadiusIndex, values.stickRadiusIndex),
    sticksVisible: typeof record.sticksVisible === 'boolean' ? record.sticksVisible : values.sticksVisible,
    pointSizeRadiusFraction: isPositive(record.pointSizeRadiusFraction)
      ? record.pointSizeRadiusFraction
      : values.pointSizeRadiusFraction,
    pointOpacity: isPositive(record.pointOpacity) && record.pointOpacity <= 1 ? record.pointOpacity : values.pointOpacity,
    colorRamp: typeof record.colorRamp === 'string' && record.colorRamp !== '' ? record.colorRamp : values.colorRamp,
    isCircular: typeof record.isCircular === 'boolean' ? record.isCircular : values.isCircular,
  }
}

/** A block's camera, from Spacewalk's spelling; null, for the Viewer to frame, when it is malformed. */
function readCamera(value: unknown): Camera | null {
  const { position, target } = asRecord(value)
  const { tx, ty, tz } = asRecord(target)
  const camera = Camera.safeParse({ position, target: { x: tx, y: ty, z: tz } })
  return camera.success ? camera.data : null
}

/**
 * The viewer settings beside a session, whole, as the viewer page reads them: a section missing or
 * malformed is its default. None at all, or none readable, is not a reason to refuse the session:
 * the Room's stay, and the model is told.
 */
async function readViewerSettings(settings: string | undefined): Promise<{ patch: ViewerSettingsPatch; note: string | null }> {
  if (!settings) return { patch: {}, note: 'This session carries no viewer settings, so they stay as they were.' }
  let record: Record<string, unknown>
  try {
    record = asRecord(await readSessionString(settings))
  } catch (error) {
    console.warn('[mcp] reading viewer settings failed:', error)
    return { patch: {}, note: 'The viewer settings in this session could not be read, so they stay as they were.' }
  }
  const defaults = emptyViewerState().viewerSettings
  const fixture = (key: 'gnomon' | 'groundPlane' | 'referenceRuler') => {
    const read = SceneFixture.safeParse(record[key])
    return read.success ? read.data : defaults[key]
  }
  const background = Color.safeParse(record.background)
  return {
    patch: {
      background: background.success ? background.data : defaults.background,
      gnomon: fixture('gnomon'),
      groundPlane: fixture('groundPlane'),
      referenceRuler: fixture('referenceRuler'),
    },
    note: null,
  }
}
