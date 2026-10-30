/**
 * The command tools, driven by a table of their own through an MCP client: the real table's rows
 * arrive with the tools they serve.
 */
import { env, runDurableObjectAlarm } from 'cloudflare:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ViewerState } from '@aidenlab/spacewalk-remote/protocol'
import type { CommandTool } from '../src/commandTools.ts'
import { registerTools } from '../src/tools.ts'
import type { ToolResult } from './mcp.ts'
import { joinAndSync, report, type Connection } from './viewer.ts'

const TABLE: CommandTool[] = [
  {
    name: 'set_render_style',
    title: 'Set the render style',
    description: 'Draw the structure as ball-and-stick or ribbon.',
    inputSchema: { style: z.enum(['ball-and-stick', 'ribbon']) },
    proposal: ({ style }) => ({ type: 'set-render-style', style: style as 'ball-and-stick' | 'ribbon' }),
  },
]

/**
 * A Host's MCP session; `hostRoomId` is the Room ChatGPT's conversation gives it. A change waits
 * a second for a Viewer to realize it, unless a test says otherwise.
 */
async function connect(hostRoomId: string | null = null, realizeTimeoutMs = 1000) {
  const server = new McpServer({ name: 'spacewalk', version: '0.0.0' })
  registerTools(
    server,
    {
      viewerUrl: 'http://localhost:5173/',
      roomById: (id) => env.ROOM.getByName(id),
      hostRoomId,
      realizeTimeoutMs,
    },
    TABLE,
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

async function call(
  name: string,
  args: Record<string, unknown>,
  hostRoomId: string | null = null,
  realizeTimeoutMs?: number,
): Promise<ToolResult> {
  const client = await connect(hostRoomId, realizeTimeoutMs)
  return (await client.callTool({ name, arguments: args })) as ToolResult
}

async function openRoom(): Promise<string> {
  const opened = await call('open_viewer', {})
  return (opened.structuredContent as { room: string }).room
}

describe('listing a command tool', () => {
  it('lists its own arguments and a room, which only ChatGPT may leave out', async () => {
    const { tools } = await (await connect()).listTools()
    const tool = tools.find(({ name }) => name === 'set_render_style')
    expect(tool).toMatchObject({ title: 'Set the render style' })
    expect(Object.keys(tool!.inputSchema.properties!)).toEqual(['style', 'room'])
    expect(tool!.inputSchema.required).toEqual(['style'])
  })
})

describe('calling a command tool', () => {
  it("proposes its change to the Room and replies with the version reached", async () => {
    const room = await openRoom()

    const result = await call('set_render_style', { room, style: 'ribbon' })

    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toMatch(/^Applied, not shown yet — no viewer is open\. Version 1\./)
    expect(await env.ROOM.getByName(room).read()).toMatchObject({ version: 1, state: { renderStyle: 'ribbon' } })
  })

  it('reads the room as a model may write it', async () => {
    const room = await openRoom()
    const result = await call('set_render_style', { room: ` ${room.toLowerCase()} `, style: 'ribbon' })
    expect(result.isError).toBeFalsy()
  })

  it('refuses a room that is not a Room id', async () => {
    const result = await call('set_render_style', { room: 'nope', style: 'ribbon' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^Error: "nope" is not a Room id\./)
  })

  it('passes on why the Room refused the change', async () => {
    const room = await openRoom()
    const stub = env.ROOM.getByName(room)
    await stub.propose({ type: 'load-ensemble', url: 'https://example.com/cloud.sw' })
    await stub.recordKind(1, 'point-cloud')

    const result = await call('set_render_style', { room, style: 'ribbon' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^Error: .*point cloud/i)
  })

  it('with a refusal, still shows the viewer state', async () => {
    const room = await openRoom()
    const stub = env.ROOM.getByName(room)
    await stub.propose({ type: 'load-ensemble', url: 'https://example.com/cloud.sw' })
    await stub.recordKind(1, 'point-cloud')

    const result = await call('set_render_style', { room, style: 'ribbon' })

    expect(result.content[0].text).toContain('Viewers connected: 0.')
    expect(result.content[0].text).toContain('"url": "https://example.com/cloud.sw"')
  })

  it('on a Room never opened, tells the model to call open_viewer', async () => {
    const result = await call('set_render_style', { room: '7ZQH4M2K9X', style: 'ribbon' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^Error: .*No such Room.*call open_viewer/is)
  })

  it('on an expired Room, tells the model to call open_viewer with it, to start it again empty', async () => {
    const room = await openRoom()
    await runDurableObjectAlarm(env.ROOM.getByName(room))

    const result = await call('set_render_style', { room, style: 'ribbon' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/expired/)
    expect(result.content[0].text).toContain(`call open_viewer with room ${room}`)
    expect(result.content[0].text).toMatch(/empty/)
  })
})

describe('calling a command tool without a room', () => {
  it("under ChatGPT, acts on the conversation's Room", async () => {
    const opened = await call('open_viewer', {}, '4DQ8TW1BNX')
    expect(opened.structuredContent).toMatchObject({ room: '4DQ8TW1BNX' })

    const result = await call('set_render_style', { style: 'ribbon' }, '4DQ8TW1BNX')

    expect(result.isError).toBeFalsy()
    expect(await env.ROOM.getByName('4DQ8TW1BNX').read()).toMatchObject({ state: { renderStyle: 'ribbon' } })
  })

  it('under ChatGPT, still acts on the room it is given', async () => {
    const room = await openRoom()
    await call('set_render_style', { room, style: 'ribbon' }, '5EWJ0Y7RCP')
    expect(await env.ROOM.getByName(room).read()).toMatchObject({ state: { renderStyle: 'ribbon' } })
  })

  it.each([undefined, ' '])('elsewhere, asks the model to pass room (%j)', async (room) => {
    const result = await call('set_render_style', { room, style: 'ribbon' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('Error: Pass room: the Room id from the reply of open_viewer.')
  })
})

describe('the reply to a command tool', () => {
  /** Call set_render_style while a Viewer hears its version and reports it realized so. */
  async function callWhileRealizing(room: string, viewer: Connection, result: object) {
    const replying = call('set_render_style', { room, style: 'ribbon' })
    const { version } = (await viewer.next()) as { version: number }
    await report(viewer, { version, kind: null, result })
    return text(await replying)
  }

  it('says the change is not shown yet when no viewer is open', async () => {
    const room = await openRoom()
    const reply = text(await call('set_render_style', { room, style: 'ribbon' }))
    expect(reply).toMatch(/^Applied, not shown yet — no viewer is open\. Version 1\./)
    expect(reply).toContain('Viewers connected: 0.')
  })

  it('carries the full viewer state', async () => {
    const room = await openRoom()
    const reply = text(await call('set_render_style', { room, style: 'ribbon' }))
    const state = JSON.parse(reply.slice(reply.indexOf('{')))
    const { viewerSettings: _, ...rest } = (await env.ROOM.getByName(room).read() as { state: ViewerState }).state
    expect(state).toMatchObject(rest)
    expect(state).toMatchObject({ renderStyle: 'ribbon', viewerSettings: { background: '#ffffff' } })
  })

  it('says the change was drawn once the first Viewer reports it drawn', async () => {
    const room = await openRoom()
    const viewer = await joinAndSync(room)
    const reply = await callWhileRealizing(room, viewer, { outcome: 'drawn' })
    expect(reply).toMatch(/^Applied and drawn\. Version 1\./)
    expect(reply).toContain('Viewers connected: 1.')
  })

  it('says why, once, when the first Viewer reports it failed', async () => {
    const room = await openRoom()
    const viewer = await joinAndSync(room)
    const reply = await callWhileRealizing(room, viewer, { outcome: 'failed', reason: 'out of memory' })
    expect(reply).toMatch(/^Applied, but the Viewer failed to draw it: out of memory\. Version 1\./)
    expect(reply.match(/out of memory/g)).toHaveLength(1)
  })

  it('says still drawing when no Viewer reports in time, and tells a later failure in a later reply', async () => {
    const room = await openRoom()
    const viewer = await joinAndSync(room)
    const reply = text(await call('set_render_style', { room, style: 'ribbon' }, null, 50))
    expect(reply).toMatch(/^Applied, still drawing\. Version 1\./)

    await viewer.next()
    await report(viewer, { version: 1, kind: null, result: { outcome: 'failed', reason: 'out of memory' } })
    const later = await callWhileRealizing(room, viewer, { outcome: 'drawn' })
    expect(later).toContain('a Viewer failed to draw version 1: out of memory')
  })

  it('tells a change drawn after the reply gave up on it in a later reply', async () => {
    const room = await openRoom()
    const viewer = await joinAndSync(room)
    await call('set_render_style', { room, style: 'ribbon' }, null, 50)
    await viewer.next()
    await report(viewer, { version: 1, kind: null, result: { outcome: 'drawn' } })

    const later = text(await call('open_viewer', { room }))
    expect(later).toContain('A Viewer has realized up to version 1, drawn.')
  })

  it("does not take a later version's failure for its own change's", async () => {
    const room = await openRoom()
    const viewer = await joinAndSync(room)
    const replying = call('set_render_style', { room, style: 'ribbon' })
    await viewer.next()
    viewer.send({ type: 'propose', proposal: { type: 'step-ball-radius', direction: 'up' } })
    await viewer.next()
    await report(viewer, { version: 2, kind: null, result: { outcome: 'failed', reason: 'out of memory' } })

    const reply = text(await replying)
    expect(reply).toMatch(/^Applied, then a later change failed to draw\. Version 1\./)
    expect(reply).toContain('made the balls bigger; a Viewer failed to draw version 2: out of memory')
  })

  it('tells the hand changes since the previous reply, once', async () => {
    const room = await openRoom()
    const viewer = await joinAndSync(room)
    const camera = { position: { x: 0, y: 0, z: 9 }, target: { x: 0, y: 0, z: 0 } }
    for (const proposal of [
      { type: 'step-ball-radius', direction: 'up' },
      { type: 'set-camera', camera },
      { type: 'set-camera', camera },
    ]) {
      viewer.send({ type: 'propose', proposal })
      await viewer.next()
    }

    const reply = await callWhileRealizing(room, viewer, { outcome: 'drawn' })
    expect(reply).toContain(
      'Changed since your last reply, not by you: made the balls bigger; the camera was moved.',
    )
    const next = await callWhileRealizing(room, viewer, { outcome: 'drawn' })
    expect(next).toContain('Nothing changed since your last reply that you did not cause.')
  })
})

function text(result: ToolResult): string {
  expect(result.isError).toBeFalsy()
  return result.content[0].text!
}
