/**
 * Cloudflare Worker entry point for spacewalk-mcp.
 *
 * Routes:
 *   GET     /ws?room=<id> - a Viewer's WebSocket to its Room, from an origin in VIEWER_ORIGINS
 *   POST    /mcp          - MCP (stateless Streamable HTTP, JSON responses)
 *   GET     /mcp          - 405 (no SSE stream)
 *   OPTIONS /mcp          - CORS preflight
 *   GET     /*            - 404 (the Viewer is hosted on its own origin, not by this Worker)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { deriveRoomId } from './roomId.ts'
import { registerTools } from './tools.ts'

export { Room } from './room.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, mcp-session-id, mcp-protocol-version',
  'Access-Control-Expose-Headers': 'mcp-session-id',
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/ws') return connectViewer(request, env, url)
    if (url.pathname === '/mcp') return serveMcp(request, env)
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

/** The MCP endpoint: CORS for browser-based Hosts, and POST only. */
async function serveMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })
  if (request.method !== 'POST') {
    return new Response('Method not allowed. Use Streamable HTTP (POST).', {
      status: 405,
      headers: { ...CORS_HEADERS, Allow: 'POST, OPTIONS' },
    })
  }
  return withCors(await handleMcpRequest(request, env))
}

function withCors(response: Response): Response {
  const patched = new Response(response.body, response)
  for (const [key, value] of Object.entries(CORS_HEADERS)) patched.headers.set(key, value)
  return patched
}

interface JsonRpcMessage {
  id?: string | number | null
}

function jsonRpcError(status: number, code: number, message: string, id: JsonRpcMessage['id'] = null) {
  return Response.json({ jsonrpc: '2.0', error: { code, message }, id }, { status })
}

/**
 * Workers are stateless, so every request gets a fresh McpServer and transport. The model names
 * its Room on every tool call. ChatGPT also sends `x-openai-session` on every request, and its
 * conversation's Room id is derived from that by HMAC under SESSION_HMAC_SECRET.
 */
async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  let body: JsonRpcMessage | JsonRpcMessage[]
  try {
    body = await request.json()
  } catch {
    return jsonRpcError(400, -32700, 'Parse error')
  }
  const id = Array.isArray(body) ? null : (body.id ?? null)

  try {
    let hostRoomId: string | null = null
    const openaiSession = request.headers.get('x-openai-session')
    if (openaiSession) {
      // No secret, no Room: there is no fallback key.
      if (!env.SESSION_HMAC_SECRET) {
        console.error('[mcp] SESSION_HMAC_SECRET is not set; refusing an x-openai-session request')
        return jsonRpcError(500, -32603, 'Server misconfigured: SESSION_HMAC_SECRET is not set', id)
      }
      hostRoomId = await deriveRoomId(openaiSession, env.SESSION_HMAC_SECRET)
    }

    const mcpServer = new McpServer({ name: 'spacewalk', version: '0.0.0' })
    registerTools(mcpServer, {
      viewerUrl: env.VIEWER_URL,
      room: (roomId) => env.ROOM.getByName(roomId),
      hostRoomId,
    })
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await mcpServer.connect(transport)
    return await transport.handleRequest(request, { parsedBody: body })
  } catch (error) {
    console.error('[mcp] error handling a request:', error)
    return jsonRpcError(500, -32603, 'Internal server error', id)
  }
}
