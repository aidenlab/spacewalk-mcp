/**
 * The ensemble and rendering tools, through an MCP client: what each proposes to the Room, and
 * what its reply tells the model.
 */
import { env } from 'cloudflare:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it } from 'vitest'
import { exampleEnsembles, EXAMPLE_ENSEMBLES_URL, type ExampleEnsembles } from '../src/exampleEnsembles.ts'
import { registerTools } from '../src/tools.ts'
import LOAD_FROM_LIST from './fixtures/load-from-list.json'
import type { ToolResult } from './mcp.ts'

const URL_A549 = 'https://pub-398373e8d1204c57beab2ae62ef6cc91.r2.dev/A549_chr21-28-30Mb.sw'

/** The example list as R2 serves it, from the fixture. */
const fromFixture = exampleEnsembles({ fetch: async () => Response.json(LOAD_FROM_LIST) })

async function call(
  name: string,
  args: Record<string, unknown>,
  examples: ExampleEnsembles = fromFixture,
): Promise<ToolResult> {
  const server = new McpServer({ name: 'spacewalk', version: '0.0.0' })
  registerTools(server, {
    viewerUrl: 'http://localhost:5173/',
    roomById: (id) => env.ROOM.getByName(id),
    hostRoomId: null,
    realizeTimeoutMs: 1000,
    exampleEnsembles: examples,
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return (await client.callTool({ name, arguments: args })) as ToolResult
}

async function openRoom(): Promise<string> {
  const opened = await call('open_viewer', {})
  return (opened.structuredContent as { room: string }).room
}

async function stateOf(room: string) {
  return ((await env.ROOM.getByName(room).read()) as { state: Record<string, unknown> }).state
}

describe('load_ensemble', () => {
  it('loads the ensemble at the URL, at its default group and trace', async () => {
    const room = await openRoom()

    const reply = text(await call('load_ensemble', { room, url: URL_A549 }))

    expect(reply).toMatch(/^Applied, not shown yet — no viewer is open\. Version 1\./)
    expect(await stateOf(room)).toMatchObject({
      ensemble: { url: URL_A549, groupKey: null, traceKey: null, kind: null },
    })
  })
})

describe('select_ensemble_group', () => {
  it('makes the ensemble group with that key current, at its default trace', async () => {
    const room = await openRoom()
    await call('load_ensemble', { room, url: URL_A549 })

    const reply = text(await call('select_ensemble_group', { room, key: 'cell-cycle-G1' }))

    expect(reply).toMatch(/^Applied, not shown yet — no viewer is open\. Version 2\./)
    expect(await stateOf(room)).toMatchObject({
      ensemble: { url: URL_A549, groupKey: 'cell-cycle-G1', traceKey: null },
    })
  })

  it('is refused when no ensemble is loaded', async () => {
    const room = await openRoom()

    const result = await call('select_ensemble_group', { room, key: 'cell-cycle-G1' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^Error: No ensemble is loaded\./)
    expect(await stateOf(room)).toMatchObject({ ensemble: null })
  })
})

describe('set_render_style', () => {
  it.each([
    ['ribbon', 'ribbon', 'ball-and-stick'],
    ['ball_and_stick', 'ball-and-stick', 'ribbon'],
  ] as const)('draws the structure as %s', async (style, renderStyle, before) => {
    const room = await openRoom()
    await env.ROOM.getByName(room).propose({ type: 'set-render-style', style: before })

    const reply = text(await call('set_render_style', { room, style }))

    expect(reply).toMatch(/^Applied, not shown yet — no viewer is open\. Version 2\./)
    expect(await stateOf(room)).toMatchObject({ renderStyle })
  })

  it('is refused on an ensemble a Viewer reported to be a point cloud', async () => {
    const room = await openRoom()
    const stub = env.ROOM.getByName(room)
    await stub.propose({ type: 'load-ensemble', url: URL_A549 })
    await stub.recordKind(1, 'point-cloud')

    const result = await call('set_render_style', { room, style: 'ribbon' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^Error: The ensemble is a point cloud/)
    expect(await stateOf(room)).toMatchObject({ renderStyle: 'ball-and-stick' })
  })
})

describe('the radius steps', () => {
  // Spacewalk's defaults put both radii at rung 5 of the radius ladder.
  it.each([
    ['step_ball_radius', 'up', { ballRadiusIndex: 6, stickRadiusIndex: 5 }],
    ['step_ball_radius', 'down', { ballRadiusIndex: 4, stickRadiusIndex: 5 }],
    ['step_stick_radius', 'up', { ballRadiusIndex: 5, stickRadiusIndex: 6 }],
    ['step_stick_radius', 'down', { ballRadiusIndex: 5, stickRadiusIndex: 4 }],
  ])('%s %s moves one radius step', async (tool, direction, structureAppearance) => {
    const room = await openRoom()

    const reply = text(await call(tool, { room, direction }))

    expect(reply).toMatch(/^Applied, not shown yet — no viewer is open\. Version 1\./)
    expect(await stateOf(room)).toMatchObject({ structureAppearance })
  })
})

describe('list_example_ensembles', () => {
  it("lists the full app's Load From List: each group, and each ensemble's name and URL", async () => {
    const reply = text(await call('list_example_ensembles', {}))

    expect(reply).toBe(
      [
        'The example ensembles, by group. Load one by passing its URL to load_ensemble.',
        '',
        'Traces — bucket root:',
        '- A549_chr21-28-30Mb: https://pub-398373e8d1204c57beab2ae62ef6cc91.r2.dev/A549_chr21-28-30Mb.sw',
        '- H1-hESC_chr1-0-249Mb: https://pub-398373e8d1204c57beab2ae62ef6cc91.r2.dev/H1-hESC_chr1-0-249Mb.sw',
        '- H1-hESC_chr10-0-135Mb: https://pub-398373e8d1204c57beab2ae62ef6cc91.r2.dev/H1-hESC_chr10-0-135Mb.sw',
        '',
        'Large ensembles — olga-dudchenko:',
        '- GSE268050_Woolly_Mammoth_Direct_Inv: https://pub-398373e8d1204c57beab2ae62ef6cc91.r2.dev/olga-dudchenko/GSE268050_Woolly_Mammoth_Direct_Inv.sw',
        '- Woolly_Mammoth_Direct_Inv: https://pub-398373e8d1204c57beab2ae62ef6cc91.r2.dev/olga-dudchenko/Woolly_Mammoth_Direct_Inv.sw',
        '',
        'Point clouds — pointcloud:',
        '- guy-nir-chr9-walk: https://pub-398373e8d1204c57beab2ae62ef6cc91.r2.dev/pointcloud/guy-nir-chr9-walk.sw',
        '- guy-nir-chr22-walk: https://pub-398373e8d1204c57beab2ae62ef6cc91.r2.dev/pointcloud/guy-nir-chr22-walk.sw',
        '- guy-nir-egfr: https://pub-398373e8d1204c57beab2ae62ef6cc91.r2.dev/pointcloud/guy-nir-egfr.sw',
      ].join('\n'),
    )
  })

  it('fetches the list R2 serves', async () => {
    const asked: string[] = []
    const examples = exampleEnsembles({
      fetch: async (url) => (asked.push(url), Response.json(LOAD_FROM_LIST)),
    })
    await call('list_example_ensembles', {}, examples)
    expect(asked).toEqual([EXAMPLE_ENSEMBLES_URL])
    expect(EXAMPLE_ENSEMBLES_URL).toBe('https://pub-398373e8d1204c57beab2ae62ef6cc91.r2.dev/load-from-list.json')
  })

  it('keeps the list a few minutes, then fetches it again', async () => {
    let fetches = 0
    let now = 0
    const examples = exampleEnsembles({
      fetch: async () => (fetches++, Response.json(LOAD_FROM_LIST)),
      now: () => now,
    })

    await call('list_example_ensembles', {}, examples)
    now += 4 * 60_000
    await call('list_example_ensembles', {}, examples)
    expect(fetches).toBe(1)

    now += 2 * 60_000
    await call('list_example_ensembles', {}, examples)
    expect(fetches).toBe(2)
  })

  it.each([
    ['R2 answers with an error', async () => new Response('gone', { status: 503 })],
    ['the list is not the manifest', async () => Response.json([{ name: 'x', url: 'y' }])],
    ['the fetch fails', async () => Promise.reject(new TypeError('network down'))],
  ])('when %s, says so and fetches again next time', async (_, failing) => {
    let fail = true
    const examples = exampleEnsembles({
      fetch: () => (fail ? failing() : Promise.resolve(Response.json(LOAD_FROM_LIST))),
    })

    const result = await call('list_example_ensembles', {}, examples)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^Error: Could not get the list of example ensembles.*load_ensemble/)

    fail = false
    expect(text(await call('list_example_ensembles', {}, examples))).toContain('A549_chr21-28-30Mb')
  })
})

function text(result: ToolResult): string {
  expect(result.isError).toBeFalsy()
  return result.content[0].text!
}
