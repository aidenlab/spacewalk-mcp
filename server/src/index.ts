/**
 * Cloudflare Worker entry point for spacewalk-mcp.
 *
 * Routes:
 *   GET  /ws?room=<id> - a Viewer's WebSocket to its Room, from an origin in VIEWER_ORIGINS
 *   GET  /*            - 404 (the Viewer is hosted on its own origin, not by this Worker)
 */
export { Room } from './room.ts'

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/ws') return connectViewer(request, env, url)
    return new Response('Not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>

/** Hand a Viewer's WebSocket upgrade to its Room, if it comes from a Viewer origin. */
function connectViewer(request: Request, env: Env, url: URL): Response | Promise<Response> {
  const origin = request.headers.get('Origin')
  if (origin === null || !viewerOrigins(env).includes(origin)) {
    return new Response('Forbidden', { status: 403 })
  }
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected a WebSocket upgrade', { status: 426 })
  }
  const room = url.searchParams.get('room')
  if (!room) return new Response('Missing room', { status: 400 })
  return env.ROOM.getByName(room).fetch(request)
}

/** The origins in VIEWER_ORIGINS, as a browser sends them: no path, no trailing slash. */
function viewerOrigins(env: Env): string[] {
  return env.VIEWER_ORIGINS.split(',').map((origin) => new URL(origin.trim()).origin)
}
