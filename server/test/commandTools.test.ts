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
import type { CommandTool } from '../src/commandTools.ts'
import { registerTools } from '../src/tools.ts'
import type { ToolResult } from './mcp.ts'

const TABLE: CommandTool[] = [
  {
    name: 'set_render_style',
    title: 'Set the render style',
    description: 'Draw the structure as ball-and-stick or ribbon.',
    inputSchema: { style: z.enum(['ball-and-stick', 'ribbon']) },
    proposal: ({ style }) => ({ type: 'set-render-style', style: style as 'ball-and-stick' | 'ribbon' }),
  },
]

async function connect() {
  const server = new McpServer({ name: 'spacewalk', version: '0.0.0' })
  registerTools(
    server,
    { viewerUrl: 'http://localhost:5173/', room: (id) => env.ROOM.getByName(id), hostRoomId: null },
    TABLE,
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const client = await connect()
  return (await client.callTool({ name, arguments: args })) as ToolResult
}

async function openRoom(): Promise<string> {
  const opened = await call('open_viewer', {})
  return (opened.structuredContent as { room: string }).room
}

describe('listing a command tool', () => {
  it('lists its own arguments and a room it must be given', async () => {
    const { tools } = await (await connect()).listTools()
    const tool = tools.find(({ name }) => name === 'set_render_style')
    expect(tool).toMatchObject({ title: 'Set the render style' })
    expect(Object.keys(tool!.inputSchema.properties!)).toEqual(['style', 'room'])
    expect(tool!.inputSchema.required).toEqual(['style', 'room'])
  })
})

describe('calling a command tool', () => {
  it("proposes its change to the Room and replies with the version reached", async () => {
    const room = await openRoom()

    const result = await call('set_render_style', { room, style: 'ribbon' })

    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toMatch(/^Done\. Version 1\./)
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
