/**
 * The scene and state tools, through an MCP client: what each proposes to the Room, and what its
 * reply tells the model.
 */
import { env, runDurableObjectAlarm } from 'cloudflare:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it } from 'vitest'
import { readSessionString, writeSessionString } from '../src/session.ts'
import { registerTools } from '../src/tools.ts'
import type { ToolResult } from './mcp.ts'

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** The network the tools see; a tool that reaches for it without a test saying so fails. */
const noNetwork: Fetch = async (url) => {
  throw new Error(`Unexpected fetch of ${url}`)
}

async function connect(fetch: Fetch = noNetwork) {
  const server = new McpServer({ name: 'spacewalk', version: '0.0.0' })
  registerTools(server, {
    viewerUrl: 'http://localhost:5173/',
    roomById: (id) => env.ROOM.getByName(id),
    hostRoomId: null,
    realizeTimeoutMs: 1000,
    fetch,
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

async function call(name: string, args: Record<string, unknown>, fetch?: Fetch): Promise<ToolResult> {
  return (await (await connect(fetch)).callTool({ name, arguments: args })) as ToolResult
}

async function openRoom(): Promise<string> {
  const opened = await call('open_viewer', {})
  return (opened.structuredContent as { room: string }).room
}

async function stateOf(room: string) {
  return ((await env.ROOM.getByName(room).read()) as { state: Record<string, any> }).state
}

function text(result: ToolResult): string {
  expect(result.isError).toBeFalsy()
  return result.content[0].text!
}

const CAMERA = { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } }

describe('reset_camera', () => {
  it('leaves the Viewer to frame the structure itself', async () => {
    const room = await openRoom()
    await env.ROOM.getByName(room).propose({ type: 'set-camera', camera: CAMERA })

    const reply = text(await call('reset_camera', { room }))

    expect(reply).toMatch(/^Applied, not shown yet — no viewer is open\. Version 2\./)
    expect(await stateOf(room)).toMatchObject({ camera: null })
  })
})

describe('set_background_color', () => {
  // Viewer settings hold three.js linear components, not sRGB; these are worked by hand from the
  // sRGB transfer function, and agree with THREE.Color.
  it.each([
    ['a hex color', '#808080', { r: 0.2158605, g: 0.2158605, b: 0.2158605 }],
    ['a hex color in capitals', '#FF8000', { r: 1, g: 0.2158605, b: 0 }],
    ['a hex color without its #', '808080', { r: 0.2158605, g: 0.2158605, b: 0.2158605 }],
    ['a short hex color', '#fff', { r: 1, g: 1, b: 1 }],
    ['a crayon', 'iron', { r: 0.0886556, g: 0.0886556, b: 0.0865005 }],
    ['a crayon in capitals', 'Snow', { r: 1, g: 1, b: 1 }],
    ['a crayon holding a color', 'licorice', { r: 0, g: 0, b: 0 }],
  ])('writes %s as its linear components', async (_, color, { r, g, b }) => {
    const room = await openRoom()

    const reply = text(await call('set_background_color', { room, color }))

    expect(reply).toMatch(/^Applied, not shown yet — no viewer is open\. Version 1\./)
    const { background } = (await stateOf(room)).viewerSettings
    expect(background.r).toBeCloseTo(r, 5)
    expect(background.g).toBeCloseTo(g, 5)
    expect(background.b).toBeCloseTo(b, 5)
  })

  it('leaves the rest of the viewer settings alone', async () => {
    const room = await openRoom()
    const before = (await stateOf(room)).viewerSettings

    await call('set_background_color', { room, color: 'lemon' })

    const { background, ...rest } = (await stateOf(room)).viewerSettings
    const { background: _, ...restBefore } = before
    expect(rest).toEqual(restBefore)
  })

  it.each(['chartreuse', '#12345', '#ggg', ''])('refuses %j, which is neither a crayon nor hex', async (color) => {
    const room = await openRoom()

    const result = await call('set_background_color', { room, color })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Apple crayon name or a hex color')
    expect((await stateOf(room)).viewerSettings.background).toEqual({ r: 1, g: 1, b: 1 })
  })

  it('lists every crayon in its description', async () => {
    const { tools } = await (await connect()).listTools()
    const { description } = tools.find(({ name }) => name === 'set_background_color')!
    for (const crayon of ['licorice', 'snow', 'iron', 'maraschino', 'seam_foam', 'carnation']) {
      expect(description).toContain(crayon)
    }
  })
})

describe('adjust_background', () => {
  it.each([
    // Ten points of HSL lightness in sRGB: white goes to 0.9, black to 0.1, each then made linear.
    ['darker', { r: 1, g: 1, b: 1 }, 0.787412],
    ['lighter', { r: 0, g: 0, b: 0 }, 0.0100228],
  ])('makes the background one step %s, moving its linear components', async (direction, background, linear) => {
    const room = await openRoom()
    await env.ROOM.getByName(room).propose({ type: 'set-viewer-settings', patch: { background } })

    const reply = text(await call('adjust_background', { room, direction }))

    expect(reply).toMatch(/Version 2\./)
    expect((await stateOf(room)).viewerSettings.background.r).toBeCloseTo(linear, 5)
  })
})

describe('colors read back to the model', () => {
  it('are hex as a person sees them, not linear components', async () => {
    const room = await openRoom()

    const reply = text(await call('set_background_color', { room, color: '#808080' }))

    expect(reply).toContain('"background": "#808080"')
    expect(reply).toContain('"gnomon": {\n      "visible": false,\n      "color": "#545453"')
    expect(reply).not.toMatch(/"r":/)
  })
})

describe('read_viewer_state', () => {
  it('tells the viewer state, the Viewers connected and what the model did not cause', async () => {
    const room = await openRoom()
    await env.ROOM.getByName(room).propose({ type: 'set-render-style', style: 'ribbon' })

    const reply = text(await call('read_viewer_state', { room }))

    expect(reply).toContain('Viewers connected: 0.')
    expect(reply).toContain('Viewer state (version 1):')
    expect(reply).toContain('"renderStyle": "ribbon"')
  })

  it('changes nothing', async () => {
    const room = await openRoom()
    await call('read_viewer_state', { room })
    expect(await env.ROOM.getByName(room).read()).toMatchObject({ version: 0 })
  })

  it('is an error for a Room never opened', async () => {
    const result = await call('read_viewer_state', { room: 'JT89R774EC' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^Error: No such Room as JT89R774EC\. Call open_viewer/)
  })

  it('is an error for an expired Room', async () => {
    const room = await openRoom()
    await runDurableObjectAlarm(env.ROOM.getByName(room))

    const result = await call('read_viewer_state', { room })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('has expired')
  })
})

const ENSEMBLE_URL = 'https://example.org/ensemble.sw'

/** A shortener that is down: the long URL is what the model gets. */
const shortenerDown: Fetch = async () => new Response('down', { status: 503 })

/** The URL a reply offers, and its session parameters as session strings. */
function shareableUrlIn(reply: string) {
  const url = new URL(reply.match(/https?:\S+/)![0])
  return { url, session: url.searchParams.get('spacewalkSessionURL')!, settings: url.searchParams.get('viewerSettings')! }
}

describe('get_shareable_url', () => {
  it('writes the session block and the viewer settings beside it, on the viewer page, with no Room', async () => {
    const room = await openRoom()
    const stub = env.ROOM.getByName(room)
    await stub.propose({ type: 'load-ensemble', url: ENSEMBLE_URL })
    await stub.propose({ type: 'select-ensemble-group', key: 'groupB' })
    await stub.propose({ type: 'select-trace', key: '12' })
    await stub.propose({ type: 'set-render-style', style: 'ribbon' })
    await stub.propose({ type: 'step-ball-radius', direction: 'up' })
    await stub.propose({ type: 'set-camera', camera: CAMERA })
    await stub.propose({ type: 'set-viewer-settings', patch: { background: { r: 0, g: 0, b: 0 } } })

    const { url, session, settings } = shareableUrlIn(text(await call('get_shareable_url', { room }, shortenerDown)))

    expect(url.origin + url.pathname).toBe('http://localhost:5173/')
    expect(url.searchParams.has('room')).toBe(false)
    expect(url.search).toMatch(/^\?spacewalkSessionURL=blob:[A-Za-z0-9._-]+&viewerSettings=blob:[A-Za-z0-9._-]+$/)
    expect(await readSessionString(session)).toEqual({
      url: ENSEMBLE_URL,
      traceKey: '12',
      ensembleGroupKey: 'groupB',
      renderStyle: 'render-style-ribbon',
      structureAppearance: {
        ballRadiusIndex: 6,
        stickRadiusIndex: 5,
        sticksVisible: true,
        pointSizeRadiusFraction: null,
        pointOpacity: 0.375,
        colorRamp: 'peter_kovesi_rainbow_bgyr_35_85_c72_n256',
        isCircular: false,
      },
      // Spacewalk spells the camera's target tx, ty, tz, as CameraLightingRig.getState does.
      cameraLightingRig: { position: { x: 1, y: 2, z: 3 }, target: { tx: 0, ty: 0, tz: 0 } },
    })
    expect(await readSessionString(settings)).toEqual((await stateOf(room)).viewerSettings)
  })

  it('writes the first trace for a Room at the default, and no group or camera', async () => {
    const room = await openRoom()
    await env.ROOM.getByName(room).propose({ type: 'load-ensemble', url: ENSEMBLE_URL })

    const { session } = shareableUrlIn(text(await call('get_shareable_url', { room }, shortenerDown)))

    // Spacewalk reads the trace with parseInt: a missing one would be NaN, not the default.
    const block = (await readSessionString(session)) as Record<string, unknown>
    expect(block).toMatchObject({ traceKey: '0', renderStyle: 'render-style-ball-stick' })
    expect(block).not.toHaveProperty('ensembleGroupKey')
    expect(block).not.toHaveProperty('cameraLightingRig')
  })

  it('is shortened as the full app does, asking from the viewer page\'s origin', async () => {
    const room = await openRoom()
    await env.ROOM.getByName(room).propose({ type: 'load-ensemble', url: ENSEMBLE_URL })
    const asked: { url: string; init?: RequestInit }[] = []

    const reply = text(
      await call('get_shareable_url', { room }, async (url, init) => {
        asked.push({ url, init })
        return Response.json({ data: { tiny_url: 'https://t.3dg.io/xyz' } })
      }),
    )

    expect(reply).toContain('https://t.3dg.io/xyz')
    expect(asked).toHaveLength(1)
    expect(asked[0].url).toBe('https://spacewalk.aidenlab.org/shorten')
    expect(asked[0].init?.method).toBe('POST')
    // sw-shortlink only answers its own origins, and only for links to the origin asking.
    expect(new Headers(asked[0].init?.headers).get('Origin')).toBe('http://localhost:5173')
    const { url } = JSON.parse(asked[0].init?.body as string)
    expect(url).toMatch(/^http:\/\/localhost:5173\/\?spacewalkSessionURL=blob:/)
  })

  it.each<[string, Fetch]>([
    ['refuses', shortenerDown],
    ['answers something else', async () => Response.json({ data: {} })],
    ['cannot be reached', async () => Promise.reject(new TypeError('network down'))],
  ])('hands back the long URL when the shortener %s', async (_, fetch) => {
    const room = await openRoom()
    await env.ROOM.getByName(room).propose({ type: 'load-ensemble', url: ENSEMBLE_URL })

    const reply = text(await call('get_shareable_url', { room }, fetch))

    expect(reply).toMatch(/http:\/\/localhost:5173\/\?spacewalkSessionURL=blob:/)
  })

  it('tells the Room as every reply does, without changing it', async () => {
    const room = await openRoom()
    await env.ROOM.getByName(room).propose({ type: 'load-ensemble', url: ENSEMBLE_URL })

    const reply = text(await call('get_shareable_url', { room }, shortenerDown))

    expect(reply).toContain('Viewer state (version 1):')
    expect(await env.ROOM.getByName(room).read()).toMatchObject({ version: 1 })
  })

  it('is refused when no ensemble is loaded', async () => {
    const room = await openRoom()

    const result = await call('get_shareable_url', { room })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^Error: No ensemble is loaded/)
  })

  it('is an error for a Room never opened', async () => {
    const result = await call('get_shareable_url', { room: 'JT89R774EC' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^Error: No such Room as JT89R774EC/)
  })
})

// Written by igv-utils' BGZip.compressString, the full app's own writer. The block, whole: a url,
// locus, trace 12 of groupB, ribbon, a structure appearance and a camera with a projection.
const BLOCK_FROM_SPACEWALK =
  'blob:VVFdT8MwDPwved5H1w1G8wYIEAIJtEm8p6mXGdKkctKxbup_x2lhEn1o4jvf.dyeRUtWSLGPsQlyPoejqhsLM09mDi5AXXIRvsVEWK_bIORZ6D2xgN_5gmEDzteot1FRFDK_yfhZLy74g6sYLYpVUSyLfiIiKQ0v0LHDImf534wn8m0z4iZd75hDc3hXDix7R2DCeQcME7gKaBs7m8CxmoZUTgnL0jvuaZLuAwOWaDF2KbYSMlILnCHwqWNLcNs0oEg5DamhVNZuVIVteGbLo5Dr1Ir66x.Y_4JhcE8RdsoG4JEeXdziCcb2R140IoeR2Sxb_NJvjdJDnGx2NRHaW08b_t68xgEJKwxp63CPpFur6BJYqxpIvaLZR3RmgybF9eUn6JhuO38QcsmGDpKIh.2GM8v6NDfgmOMsjgPZDUucWJL.hyIDg0tkdsUA02wVmb_u._4H'
// The same block as a saved session file carries it, beside IGV and Juicebox blocks.
const WHOLE_SESSION_FROM_SPACEWALK =
  'blob:VVFdT.MwEPwvfi5tWnpwyduB4HQ6JFAr8YJ4cNxtuq1rR2unH1T57zd2AOnyEHtndmdn1xcVWm3oqO1OVRfViVWV2sTYhmoyoZPet5bGXpoJuUD7GkE4qpGy3nQhFZiNoAD_2RRwQ87v2Syjlqiq2c8C3.30G39wK6BlOS_L67IfqSho_ZfOUJjOUP7V47f4rh3wJl3vwHFzeNGOLLQjgXDeEWAhtyJZxrNN4BBdhRReCde1d8hpU90rB67Zcjwn21pVUTqCh4DTxE7oV9uSFu0MpYRaW7vQK.7CH0ieVHWbUtns_gNnn2DI6snCWttAaOnZxSV_0JD.iEEjw0xVjIvpJ_2MxWc7xfjHSBlvvSywb4xxYOEVhzR1uGcxndXybdjoPYl.4mYT2TULbpJdX2_JxHRb.4OqriHoKBWh2TqfRdGnvoEHHxd1yuQ5D_GBkvQeWhrKKhHsHABoSEXwN33f51fINObZ4f3f3oFtOzZU.1Nem_hjIBmo_h8-'
const SETTINGS_FROM_SPACEWALK =
  'blob:q1ZKSkzOTi_KL81LUbKqVipSsjLQUUoHk0lAshbIycvPzc8DSZZlFmcm5aQqWZUUlabqgNQagtUagtUagtSCDQrIScxLRdGQlphTDNFhoGcKMR9EJ4FpoL6i1LTUotS85NSg0pzUInx2wdxVCwA-'
const IGV_FROM_SPACEWALK = 'blob:q1YqKUpMzi5WsoqOrQUA'

/** The Room's viewer state once that block is loaded, the furniture aside. */
const LOADED = {
  ensemble: { url: ENSEMBLE_URL, groupKey: 'groupB', traceKey: '12', kind: null },
  renderStyle: 'ribbon',
  structureAppearance: {
    ballRadiusIndex: 7,
    stickRadiusIndex: 2,
    sticksVisible: false,
    pointSizeRadiusFraction: 0.01,
    pointOpacity: 0.5,
    colorRamp: 'viridis',
    isCircular: true,
  },
  camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 4, y: 5, z: 6 } },
}

const FULL_APP = 'https://spacewalk.aidenlab.org/index.html'
const VIEWER = 'https://spacewalk-viewer.3dg.io/'

describe('load_session', () => {
  it('reads a URL from the full app, and says what it ignored', async () => {
    const room = await openRoom()
    const session = `${FULL_APP}?spacewalkSessionURL=${BLOCK_FROM_SPACEWALK}&sessionURL=${IGV_FROM_SPACEWALK}&session=${IGV_FROM_SPACEWALK}`

    const reply = text(await call('load_session', { room, session }))

    expect(reply).toContain('IGV tracks and the Hi-C map in this session were not loaded.')
    expect(reply).toContain('Applied, not shown yet — no viewer is open. Version 1.')
    expect(await stateOf(room)).toMatchObject(LOADED)
  })

  it('says only what the session held', async () => {
    const room = await openRoom()
    const session = `${FULL_APP}?spacewalkSessionURL=${BLOCK_FROM_SPACEWALK}&sessionURL=${IGV_FROM_SPACEWALK}`

    const reply = text(await call('load_session', { room, session }))

    expect(reply).toContain('The IGV tracks in this session were not loaded.')
    expect(reply).not.toContain('Hi-C')
  })

  it('reads a URL from the Viewer, with its viewer settings', async () => {
    const room = await openRoom()
    const session = `${VIEWER}?spacewalkSessionURL=${BLOCK_FROM_SPACEWALK}&viewerSettings=${SETTINGS_FROM_SPACEWALK}`

    const reply = text(await call('load_session', { room, session }))

    expect(reply).not.toContain('were not loaded')
    expect(reply).not.toContain('viewer settings')
    expect(await stateOf(room)).toMatchObject({
      ...LOADED,
      viewerSettings: {
        background: { r: 0, g: 0, b: 0 },
        gnomon: { visible: true, r: 1, g: 1, b: 1 },
        groundPlane: { visible: false, r: 0.5, g: 0.5, b: 0.5 },
        referenceRuler: { visible: true, r: 1, g: 0, b: 0 },
      },
    })
  })

  it('reads a bare session string, keeping the viewer settings and saying so', async () => {
    const room = await openRoom()
    await call('set_background_color', { room, color: 'lemon' })
    const before = (await stateOf(room)).viewerSettings

    const reply = text(await call('load_session', { room, session: ` ${BLOCK_FROM_SPACEWALK}\n` }))

    expect(reply).toContain('This session carries no viewer settings, so they stay as they were.')
    expect(await stateOf(room)).toMatchObject(LOADED)
    expect((await stateOf(room)).viewerSettings).toEqual(before)
  })

  it('reads a bare string holding a whole session file: the Spacewalk block only', async () => {
    const room = await openRoom()

    const reply = text(await call('load_session', { room, session: WHOLE_SESSION_FROM_SPACEWALK }))

    expect(reply).toContain('IGV tracks and the Hi-C map in this session were not loaded.')
    expect(await stateOf(room)).toMatchObject(LOADED)
  })

  it('reads a URL whose parameters were percent-encoded, as old links were', async () => {
    const room = await openRoom()
    const session = `${FULL_APP}?spacewalkSessionURL=${encodeURIComponent(BLOCK_FROM_SPACEWALK)}`

    text(await call('load_session', { room, session }))

    expect(await stateOf(room)).toMatchObject(LOADED)
  })

  it('makes one version, so a Viewer draws the session once', async () => {
    const room = await openRoom()
    await call('load_session', { room, session: BLOCK_FROM_SPACEWALK })
    expect(await env.ROOM.getByName(room).read()).toMatchObject({ version: 1 })
  })

  it('forgets the kind of the ensemble before, and learns the new one from a Viewer', async () => {
    const room = await openRoom()
    const stub = env.ROOM.getByName(room)
    await stub.propose({ type: 'load-ensemble', url: 'https://example.org/before.sw' })
    await stub.recordKind(1, 'point-cloud')

    await call('load_session', { room, session: BLOCK_FROM_SPACEWALK })
    expect(await stateOf(room)).toMatchObject({ ensemble: { kind: null } })

    await stub.recordKind(2, 'trace')
    expect(await stateOf(room)).toMatchObject({ ensemble: { kind: 'trace' } })
  })

  it('takes each field on its own: a missing or malformed one falls back to its default', async () => {
    const room = await openRoom()
    await env.ROOM.getByName(room).propose({ type: 'step-ball-radius', direction: 'up' })
    await env.ROOM.getByName(room).propose({ type: 'set-camera', camera: CAMERA })
    const session = await writeSessionString({
      url: ENSEMBLE_URL,
      renderStyle: 'render-style-point-cloud',
      structureAppearance: { ballRadiusIndex: 40, stickRadiusIndex: 'thick', pointOpacity: 3, isCircular: true },
      cameraLightingRig: { position: { x: 1 } },
    })

    text(await call('load_session', { room, session }))

    expect(await stateOf(room)).toMatchObject({
      ensemble: { url: ENSEMBLE_URL, groupKey: null, traceKey: null, kind: null },
      renderStyle: 'ball-and-stick',
      structureAppearance: { ballRadiusIndex: 10, stickRadiusIndex: 5, pointOpacity: 0.375, isCircular: true },
      camera: null,
    })
  })

  it('takes viewer settings section by section, keeping those it cannot read', async () => {
    const room = await openRoom()
    const settings = await writeSessionString({ background: { r: 0, g: 0, b: 0 }, gnomon: { visible: 'yes', r: 1, g: 1, b: 1 } })
    const session = `${VIEWER}?spacewalkSessionURL=${BLOCK_FROM_SPACEWALK}&viewerSettings=${settings}`

    text(await call('load_session', { room, session }))

    const { background, gnomon } = (await stateOf(room)).viewerSettings
    expect(background).toEqual({ r: 0, g: 0, b: 0 })
    expect(gnomon.visible).toBe(false)
  })

  it('loads the session even when its viewer settings cannot be read, and says so', async () => {
    const room = await openRoom()
    const session = `${VIEWER}?spacewalkSessionURL=${BLOCK_FROM_SPACEWALK}&viewerSettings=blob:nonsense`

    const reply = text(await call('load_session', { room, session }))

    expect(reply).toContain('The viewer settings in this session could not be read, so they stay as they were.')
    expect(await stateOf(room)).toMatchObject(LOADED)
  })

  describe('a short URL', () => {
    const redirect = (location: string): Fetch => async () =>
      new Response(null, { status: 302, headers: { Location: location } })

    it.each(['https://t.3dg.io/xyz', 'https://tinyurl.com/xyz'])('is followed from %s, by its redirect alone', async (short) => {
      const room = await openRoom()
      const asked: { url: string; init?: RequestInit }[] = []
      const session = `${FULL_APP}?spacewalkSessionURL=${BLOCK_FROM_SPACEWALK}&sessionURL=${IGV_FROM_SPACEWALK}`

      const reply = text(
        await call('load_session', { room, session: short }, async (url, init) => {
          asked.push({ url, init })
          return redirect(session)(url, init)
        }),
      )

      expect(asked).toHaveLength(1)
      expect(asked[0].url).toBe(short)
      expect(asked[0].init?.redirect).toBe('manual')
      expect(reply).toContain('The IGV tracks in this session were not loaded.')
      expect(await stateOf(room)).toMatchObject(LOADED)
    })

    it('that leads nowhere is refused', async () => {
      const room = await openRoom()
      const result = await call('load_session', { room, session: 'https://t.3dg.io/gone' }, async () => new Response('', { status: 404 }))
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toMatch(/^Error: Could not follow the short URL/)
    })

    it('that cannot be reached is refused', async () => {
      const room = await openRoom()
      const result = await call('load_session', { room, session: 'https://t.3dg.io/xyz' }, async () => Promise.reject(new TypeError('down')))
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toMatch(/^Error: Could not follow the short URL/)
    })

    it('that leads somewhere with no session is refused', async () => {
      const room = await openRoom()
      const result = await call('load_session', { room, session: 'https://t.3dg.io/xyz' }, redirect('https://example.org/'))
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toMatch(/^Error: That URL carries no Spacewalk session/)
    })
  })

  it('reads back what get_shareable_url wrote', async () => {
    const room = await openRoom()
    await call('load_session', { room, session: `${VIEWER}?spacewalkSessionURL=${BLOCK_FROM_SPACEWALK}&viewerSettings=${SETTINGS_FROM_SPACEWALK}` })
    const before = await stateOf(room)
    const { url } = shareableUrlIn(text(await call('get_shareable_url', { room }, shortenerDown)))

    const other = await openRoom()
    text(await call('load_session', { room: other, session: url.toString() }))

    expect(await stateOf(other)).toEqual(before)
  })

  it.each([
    ['a session URL meant to be fetched, as a parameter', `${FULL_APP}?spacewalkSessionURL=https://example.org/s.json`, /^Error: Spacewalk does not fetch a session from a URL/],
    ['a session URL meant to be fetched, bare', 'https://example.org/s.json', /^Error: That URL carries no Spacewalk session/],
    ['a URL with only an IGV session', `${FULL_APP}?sessionURL=${IGV_FROM_SPACEWALK}`, /^Error: That URL carries no Spacewalk session/],
    ['a launch URL with a file', `${FULL_APP}?file=https://example.org/a.sw`, /load_ensemble/],
    ['a string that is no session', 'hello', /^Error: That is neither a shareable URL nor a session string/],
    ['a session string that cannot be read', 'blob:nonsense', /^Error: That session string could not be read/],
  ])('refuses %s, leaving the Room alone', async (_, session, message) => {
    const room = await openRoom()

    const result = await call('load_session', { room, session })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(message)
    expect(result.content[0].text).toContain('Viewer state (version 0):')
    expect(await env.ROOM.getByName(room).read()).toMatchObject({ version: 0 })
  })

  it('refuses a session with no ensemble in it', async () => {
    const room = await openRoom()
    const result = await call('load_session', { room, session: IGV_FROM_SPACEWALK })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^Error: That session names no ensemble/)
  })

  it('is an error for a Room never opened', async () => {
    const result = await call('load_session', { room: 'JT89R774EC', session: BLOCK_FROM_SPACEWALK })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^Error: No such Room as JT89R774EC/)
  })
})
