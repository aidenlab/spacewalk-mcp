// What a Deployment runs: the Worker's version in an MCP initialize, and at GET /version the
// Worker's and the Viewer page's together. The page's version.json is fetched beside VIEWER_URL
// (http://localhost:5173/ in the tests) and stubbed here.
import { SELF } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rpc } from './mcp.ts'

const WORKER = 'main (a1b2c3d)'
const PAGE_VERSION_URL = 'http://localhost:5173/version.json'

it('reports the build it runs as its serverInfo version', async () => {
  const response = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  })
  const { result } = await response.json<{ result: { serverInfo: { name: string; version: string } } }>()
  expect(result.serverInfo).toEqual({ name: 'spacewalk', version: WORKER })
})

describe('GET /version', () => {
  function servePage(response: () => Response | Promise<Response>) {
    const realFetch = globalThis.fetch
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      return url === PAGE_VERSION_URL ? response() : realFetch(input, init)
    })
  }

  afterEach(() => vi.restoreAllMocks())

  it("answers the Worker's version, the protocol and the page's version.json with its url", async () => {
    servePage(() => Response.json({ version: 'main (9e1d2b7)', 'spacewalk-remote': '0.3.1', protocol: 2 }))
    const response = await SELF.fetch('https://example.com/version')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('application/json')
    expect(await response.json()).toEqual({
      worker: WORKER,
      protocol: 2,
      viewer: { url: PAGE_VERSION_URL, version: 'main (9e1d2b7)', 'spacewalk-remote': '0.3.1', protocol: 2 },
    })
  })

  it('still answers 200 when the page has no version.json, naming what failed', async () => {
    servePage(() => new Response('Not found', { status: 404 }))
    const response = await SELF.fetch('https://example.com/version')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      worker: WORKER,
      protocol: 2,
      viewer: { url: PAGE_VERSION_URL, error: 'HTTP 404' },
    })
  })

  it('still answers 200 when the page cannot be reached', async () => {
    servePage(() => Promise.reject(new TypeError('Network connection lost.')))
    const response = await SELF.fetch('https://example.com/version')
    expect(response.status).toBe(200)
    const { viewer } = await response.json<{ viewer: { url: string; error: string } }>()
    expect(viewer).toEqual({ url: PAGE_VERSION_URL, error: expect.stringContaining('Network connection lost.') })
  })

  it("keeps the page's url when its version.json names one of its own", async () => {
    servePage(() => Response.json({ version: 'main (9e1d2b7)', url: 'https://elsewhere.example/' }))
    const { viewer } = await (await SELF.fetch('https://example.com/version')).json<{ viewer: object }>()
    expect(viewer).toEqual({ url: PAGE_VERSION_URL, version: 'main (9e1d2b7)' })
  })
})
