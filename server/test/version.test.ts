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

  it('answers JSON to curl and scripts, which do not ask for HTML', async () => {
    servePage(() => Response.json({ version: 'main (9e1d2b7)' }))
    const response = await SELF.fetch('https://example.com/version', { headers: { Accept: '*/*' } })
    expect(response.headers.get('Content-Type')).toContain('application/json')
  })

  describe('opened in a browser', () => {
    // What a browser sends when the address is opened.
    const BROWSER = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    const open = async () => SELF.fetch('https://example.com/version', { headers: BROWSER })

    it('answers a page naming both versions, where each runs, and what else each reports', async () => {
      servePage(() => Response.json({ version: 'main (9e1d2b7)', 'spacewalk-remote': '0.3.1', protocol: 2 }))
      const response = await open()
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      const html = await response.text()
      expect(html).toMatch(/^<!doctype html>/)
      expect(html).toContain(WORKER)
      expect(html).toContain('main (9e1d2b7)')
      expect(html).toContain('example.com')
      expect(html).toContain('localhost:5173')
      expect(html).toContain('spacewalk-remote')
      expect(html).toContain('0.3.1')
    })

    it("shows why the page's version could not be read", async () => {
      servePage(() => new Response('Not found', { status: 404 }))
      const html = await (await open()).text()
      expect(html).toContain('could not be read: HTTP 404')
    })

    it("escapes what the page's file says", async () => {
      servePage(() => Response.json({ version: '<script>alert(1)</script>', '<b>': '<i>' }))
      const html = await (await open()).text()
      expect(html).not.toContain('<script>alert(1)</script>')
      expect(html).not.toContain('<b>')
      expect(html).toContain('&#60;script&#62;')
    })
  })
})
