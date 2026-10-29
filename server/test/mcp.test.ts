import { env, runDurableObjectAlarm, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { callTool, rpc, type ToolResult } from './mcp.ts'

const ROOM_ID = /^[0-9A-HJKMNP-TV-Z]{10}$/ // Crockford base32: no I, L, O, U

/** The Room an open_viewer reply names. */
function roomOf(result: ToolResult): string {
  return (result.structuredContent as { room: string }).room
}

/** VIEWER_URL in wrangler.toml, carrying the Room id. */
function roomLinkFor(room: string) {
  return `http://localhost:5173/?room=${room}`
}

interface ListedTool {
  name: string
  title?: string
  description: string
  inputSchema: { properties?: Record<string, unknown>; required?: string[] }
  _meta?: Record<string, unknown>
}

async function listTools(): Promise<ListedTool[]> {
  const response = await rpc('tools/list', {})
  return (await response.json<{ result: { tools: ListedTool[] } }>()).result.tools
}

describe('listing the tools', () => {
  it('lists open_viewer, its room optional, showing the Join card', async () => {
    const openViewer = (await listTools()).find((tool) => tool.name === 'open_viewer')
    expect(openViewer).toMatchObject({
      title: 'Open Spacewalk',
      inputSchema: { properties: { room: { type: 'string' } } },
      _meta: { ui: { resourceUri: 'ui://spacewalk/join' }, 'ui/resourceUri': 'ui://spacewalk/join' },
    })
    expect(openViewer?.inputSchema.required ?? []).not.toContain('room')
  })
})

describe('the Join card', () => {
  it('is served as an MCP App', async () => {
    const response = await rpc('resources/read', { uri: 'ui://spacewalk/join' })
    const { result } = await response.json<{
      result: { contents: Array<{ mimeType: string; text: string }> }
    }>()
    expect(result.contents[0].mimeType).toBe('text/html;profile=mcp-app')
    expect(result.contents[0].text).toContain('Open Spacewalk')
  })
})

describe('the /mcp endpoint', () => {
  it('answers GET with 405: there is no SSE stream', async () => {
    const response = await SELF.fetch('https://example.com/mcp')
    expect(response.status).toBe(405)
    expect(response.headers.get('Allow')).toBe('POST, OPTIONS')
  })

  it('answers a CORS preflight', async () => {
    const response = await SELF.fetch('https://example.com/mcp', { method: 'OPTIONS' })
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })
})

describe('open_viewer without a room', () => {
  it('opens a new Room, empty, and returns its Room link as text and as a resource link', async () => {
    const result = await callTool('open_viewer')

    const room = roomOf(result)
    expect(room).toMatch(ROOM_ID)
    expect(result.isError).toBeFalsy()
    // On a line of its own, so Hosts render it clickable.
    expect(result.content[0].text).toContain(`\n${roomLinkFor(room)}\n`)
    expect(result.content[1]).toMatchObject({
      type: 'resource_link',
      uri: roomLinkFor(room),
      name: 'Open Spacewalk',
      mimeType: 'text/html',
    })
    expect(result.structuredContent).toEqual({ room, roomLink: roomLinkFor(room) })
    expect(await env.ROOM.getByName(room).read()).toMatchObject({ ok: true, version: 0 })
  })

  it('opens a different Room each time', async () => {
    const first = roomOf(await callTool('open_viewer'))
    const second = roomOf(await callTool('open_viewer', { room: '  ' }))
    expect(second).not.toBe(first)
  })

  it('names the Room id and tells the model to pass it as room on every later call', async () => {
    const result = await callTool('open_viewer')
    const room = roomOf(result)
    expect(result.content[0].text).toContain(
      `Room id: ${room}. Pass it as room on every later Spacewalk tool call in this conversation.`,
    )
  })
})

describe('open_viewer under ChatGPT', () => {
  it('opens the Room whose id is the HMAC of x-openai-session under SESSION_HMAC_SECRET', async () => {
    // HMAC-SHA256('test-session-hmac-secret', 'chatgpt-conversation-1'), its first ten bytes in
    // Crockford base32 by their low five bits, worked out apart from the Worker.
    const headers = { 'x-openai-session': 'chatgpt-conversation-1' }
    expect(roomOf(await callTool('open_viewer', {}, headers))).toBe('ZD7249DHF1')
    expect(roomOf(await callTool('open_viewer', {}, headers))).toBe('ZD7249DHF1')
  })

  it('opens another Room for another conversation', async () => {
    const headers = { 'x-openai-session': 'chatgpt-conversation-2' }
    const room = roomOf(await callTool('open_viewer', {}, headers))
    expect(room).toMatch(ROOM_ID)
    expect(room).not.toBe('ZD7249DHF1')
  })

  it('still opens the room it is given', async () => {
    const headers = { 'x-openai-session': 'chatgpt-conversation-1' }
    expect(roomOf(await callTool('open_viewer', { room: '265EDDEXA6' }, headers))).toBe('265EDDEXA6')
  })
})

describe('open_viewer given a room', () => {
  it('returns the Room link for that Room, read as a model may write it', async () => {
    const result = await callTool('open_viewer', { room: ' 3k9mzq7wcd ' })

    expect(result.structuredContent).toEqual({ room: '3K9MZQ7WCD', roomLink: roomLinkFor('3K9MZQ7WCD') })
    expect(result.content[1].uri).toBe(roomLinkFor('3K9MZQ7WCD'))
  })

  it('keeps what a live Room holds', async () => {
    const room = roomOf(await callTool('open_viewer'))
    await env.ROOM.getByName(room).propose({ type: 'set-render-style', style: 'ribbon' })

    await callTool('open_viewer', { room })

    expect(await env.ROOM.getByName(room).read()).toMatchObject({
      ok: true,
      version: 1,
      state: { renderStyle: 'ribbon' },
    })
  })

  it('starts an expired Room again, empty', async () => {
    const room = roomOf(await callTool('open_viewer'))
    const stub = env.ROOM.getByName(room)
    await stub.propose({ type: 'set-render-style', style: 'ribbon' })
    await runDurableObjectAlarm(stub)

    const result = await callTool('open_viewer', { room })

    expect(result.isError).toBeFalsy()
    expect(await stub.read()).toMatchObject({ ok: true, state: { renderStyle: 'ball-and-stick' } })
  })

  it('refuses a room that is not a Room id, with no link', async () => {
    const result = await callTool('open_viewer', { room: 'nope' })

    expect(result.isError).toBe(true)
    expect(result.content).toHaveLength(1)
    expect(result.content[0].text).toMatch(/^Error: "nope" is not a Room id\./)
  })
})
