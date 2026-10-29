/**
 * The model's side of `/mcp`: JSON-RPC over POST on the Worker under test, as a Host sends it.
 */
import { SELF } from 'cloudflare:test'

let rpcId = 0
export function rpc(method: string, params: object, headers: Record<string, string> = {}) {
  return SELF.fetch('https://example.com/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
}

export interface ToolResult {
  content: Array<{ type: string; text?: string; uri?: string; name?: string; mimeType?: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export async function callTool(name: string, args: object = {}, headers?: Record<string, string>) {
  const response = await rpc('tools/call', { name, arguments: args }, headers)
  return (await response.json<{ result: ToolResult }>()).result
}
