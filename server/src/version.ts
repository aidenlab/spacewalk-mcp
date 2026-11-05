/**
 * GET /version: what this Deployment runs, at one address. The shape is the one geenee reads from
 * every Upstream: `worker` is this Worker's MCP serverInfo.version, and `viewer` is the Viewer
 * page's own version.json (written by the deploy scripts beside viewer.html), fetched now, not
 * cached, and passed through with its `url` added. Spacewalk adds `protocol`, since a Room refuses a
 * Viewer whose protocol version differs from the Worker's. A request whose Accept names text/html
 * (a browser opening the address) gets the same answer as a page; everything else (the deploy
 * scripts, curl) gets the JSON.
 */
import { PROTOCOL_VERSION } from '@aidenlab/spacewalk-remote/protocol'
import { versionPage } from './versionPage.ts'

/** Longer than this and the page counts as unreachable: /version answers either way. */
const PAGE_TIMEOUT_MS = 5000

export async function serveVersion(request: Request, env: Env): Promise<Response> {
  const body = { worker: env.VERSION, protocol: PROTOCOL_VERSION, viewer: await viewerVersion(env.VIEWER_URL) }
  const headers = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }
  if ((request.headers.get('Accept') ?? '').includes('text/html')) {
    return new Response(versionPage(new URL(request.url).origin, body), {
      headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
    })
  }
  return Response.json(body, { headers })
}

type ViewerVersion = { url: string; error?: string; [key: string]: unknown }

/** The page's version.json beside VIEWER_URL with its url, or what kept it from being read. */
async function viewerVersion(viewerUrl: string): Promise<ViewerVersion> {
  const url = new URL('version.json', viewerUrl).href
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) })
    if (!response.ok) return { url, error: `HTTP ${response.status}` }
    const file: unknown = await response.json()
    if (typeof file !== 'object' || file === null || Array.isArray(file)) {
      return { url, error: 'version.json is not a JSON object' }
    }
    // url first, as geenee shows it, and the page's own file cannot replace it.
    return { ...{ url }, ...file, url }
  } catch (error) {
    return { url, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
  }
}
