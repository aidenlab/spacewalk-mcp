import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachRemote, type AttachOptions } from '../src/index.ts'
import { PROTOCOL_VERSION } from '../src/protocol.ts'
import { FakeSocket, STATE } from './fakeSocket.ts'

const URL = 'wss://spacewalk-mcp.example/ws'

/** Let the Viewer's queued work run: drawing a state and reporting it are asynchronous. */
const settle = () => vi.advanceTimersByTimeAsync(0)

const PLACE = { url: 'https://example.com/a.sw', groupKey: null, traceKey: '7' }
const POSE = { place: PLACE, camera: { position: { x: 0, y: 0, z: 10 }, target: { x: 0, y: 0, z: 0 } } }
const CAMERA_PORT = { read: vi.fn(), follow: vi.fn(), reset: vi.fn() }

function attach(options: Partial<AttachOptions> = {}) {
  const draw = vi.fn<AttachOptions['draw']>(() => ({ kind: 'trace' }))
  const onStatus = vi.fn<NonNullable<AttachOptions['onStatus']>>()
  const remote = attachRemote({
    url: URL,
    room: 'room-1',
    draw,
    camera: CAMERA_PORT,
    onStatus,
    createSocket: (url) => new FakeSocket(url),
    ...options,
  })
  return { remote, draw, onStatus }
}

/** Attach, open the socket and hear the first sync at `version`. */
async function joined(options: Partial<AttachOptions> = {}, version = 1) {
  const attached = attach(options)
  const socket = FakeSocket.latest()
  socket.open()
  socket.receive({ type: 'state', version, state: STATE, loaded: null })
  await settle()
  return { ...attached, socket }
}

beforeEach(() => {
  FakeSocket.instances = []
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('attaching a Viewer to a Room', () => {
  it('connects to the Room and joins it with the protocol version', () => {
    attach()
    const socket = FakeSocket.latest()
    expect(socket.url).toBe(`${URL}?room=room-1`)
    socket.open()
    expect(socket.sent).toEqual([{ type: 'join', protocol: PROTOCOL_VERSION }])
  })

  it('draws a broadcast viewer state and reports it realized, with the kind', async () => {
    const { draw, socket } = await joined({}, 3)
    expect(draw).toHaveBeenCalledWith(STATE, 3, null)
    expect(socket.sentOf('realized')).toEqual([
      { type: 'realized', version: 3, kind: 'trace', result: { outcome: 'drawn' } },
    ])
  })
})

describe('proposing a hand change', () => {
  it('proposes a step, or a choice, at once: each click its own proposal', async () => {
    const { remote, socket } = await joined()
    remote.propose({ type: 'step-ball-radius', direction: 'up' })
    remote.propose({ type: 'step-ball-radius', direction: 'up' })
    remote.propose({ type: 'select-trace', key: '7' })
    expect(socket.sentOf('propose')).toEqual([
      { type: 'propose', proposal: { type: 'step-ball-radius', direction: 'up' } },
      { type: 'propose', proposal: { type: 'step-ball-radius', direction: 'up' } },
      { type: 'propose', proposal: { type: 'select-trace', key: '7' } },
    ])
  })

  it('proposes a dragged appearance once the gesture ends, as one change', async () => {
    const { remote, socket } = await joined()
    remote.propose({ type: 'set-structure-appearance', patch: { pointOpacity: 0.9 } })
    await vi.advanceTimersByTimeAsync(200)
    remote.propose({ type: 'set-structure-appearance', patch: { pointOpacity: 0.5 } })
    remote.propose({ type: 'set-structure-appearance', patch: { colorRamp: 'viridis' } })
    await vi.advanceTimersByTimeAsync(249)
    expect(socket.sentOf('propose')).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(socket.sentOf('propose')).toEqual([
      {
        type: 'propose',
        proposal: { type: 'set-structure-appearance', patch: { pointOpacity: 0.5, colorRamp: 'viridis' } },
      },
    ])
  })

  it('proposes dragged viewer settings once the gesture ends, merged fixture by fixture', async () => {
    const { remote, socket } = await joined()
    remote.propose({ type: 'set-viewer-settings', patch: { background: { r: 0.1, g: 0.1, b: 0.1 } } })
    remote.propose({ type: 'set-viewer-settings', patch: { gnomon: { r: 1 } } })
    remote.propose({ type: 'set-viewer-settings', patch: { gnomon: { visible: false } } })
    remote.propose({ type: 'set-viewer-settings', patch: { background: { r: 0.2, g: 0.2, b: 0.2 } } })
    await vi.advanceTimersByTimeAsync(250)
    expect(socket.sentOf('propose')).toEqual([
      {
        type: 'propose',
        proposal: {
          type: 'set-viewer-settings',
          patch: { background: { r: 0.2, g: 0.2, b: 0.2 }, gnomon: { r: 1, visible: false } },
        },
      },
    ])
  })

  it('waits as long as the Viewer asks for a gesture to end', async () => {
    const { remote, socket } = await joined({ gestureEndMs: 50 })
    remote.propose({ type: 'set-structure-appearance', patch: { pointOpacity: 0.5 } })
    await vi.advanceTimersByTimeAsync(50)
    expect(socket.sentOf('propose')).toHaveLength(1)
  })

  it('proposes a pending dragged change before a later click, keeping their order', async () => {
    const { remote, socket } = await joined()
    remote.propose({ type: 'set-structure-appearance', patch: { pointOpacity: 0.5 } })
    remote.propose({ type: 'step-ball-radius', direction: 'down' })
    expect(socket.sentOf('propose').map((message) => message.proposal.type)).toEqual([
      'set-structure-appearance',
      'step-ball-radius',
    ])
    await vi.advanceTimersByTimeAsync(250)
    expect(socket.sentOf('propose')).toHaveLength(2)
  })

  it('does not echo back what the Viewer changes in drawing the Room’s state', async () => {
    let remote: ReturnType<typeof attachRemote> | undefined
    const state = STATE
    const draw = vi.fn(async () => {
      remote?.propose({ type: 'set-render-style', style: state.renderStyle })
      await Promise.resolve()
      remote?.propose({ type: 'set-structure-appearance', patch: { pointOpacity: 1, sticksVisible: true } })
      remote?.propose({ type: 'set-viewer-settings', patch: { gnomon: { visible: true } } })
      remote?.propose({ type: 'load-ensemble', url: state.ensemble!.url })
      return { kind: 'trace' as const }
    })
    const attached = attach({ draw })
    remote = attached.remote
    const socket = FakeSocket.latest()
    socket.open()
    socket.receive({ type: 'state', version: 1, state, loaded: null })
    await vi.advanceTimersByTimeAsync(1000)
    expect(socket.sentOf('propose')).toEqual([])

    // Drawn, the same change is a hand's.
    remote.propose({ type: 'set-render-style', style: state.renderStyle })
    expect(socket.sentOf('propose')).toHaveLength(1)
  })

  it('proposes a hand change made while a long draw runs', async () => {
    let finish = () => {}
    const draw = vi.fn(() => new Promise<{ kind: 'trace' }>((resolve) => (finish = () => resolve({ kind: 'trace' }))))
    const { remote, socket } = await joined({ draw })
    remote.propose({ type: 'set-render-style', style: 'ribbon' })
    remote.propose({ type: 'set-structure-appearance', patch: { pointOpacity: 0.4 } })
    remote.propose({ type: 'set-structure-appearance', patch: { pointOpacity: 0.3 } })
    await vi.advanceTimersByTimeAsync(250)
    expect(socket.sentOf('propose')).toEqual([
      { type: 'propose', proposal: { type: 'set-render-style', style: 'ribbon' } },
      { type: 'propose', proposal: { type: 'set-structure-appearance', patch: { pointOpacity: 0.3 } } },
    ])
    finish()
  })

  it('refuses at once a Room endpoint that is not a URL', () => {
    expect(() => attach({ url: '/ws' })).toThrow()
  })

  it('proposes nothing while disconnected: the resync on rejoining puts the Viewer back', async () => {
    const { remote, socket } = await joined()
    socket.drop()
    remote.propose({ type: 'step-ball-radius', direction: 'up' })
    remote.propose({ type: 'set-structure-appearance', patch: { pointOpacity: 0.5 } })
    await vi.advanceTimersByTimeAsync(1000)
    FakeSocket.latest().open()
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeSocket.instances.flatMap((s) => s.sentOf('propose'))).toEqual([])
  })

})

describe('the camera', () => {
  beforeEach(() => vi.clearAllMocks())

  it('hands the draw the latest load', async () => {
    const { draw } = attach()
    const socket = FakeSocket.latest()
    socket.open()
    const loaded = { version: 1, camera: POSE.camera }
    socket.receive({ type: 'state', version: 1, state: STATE, loaded })
    await settle()
    expect(draw).toHaveBeenCalledWith(STATE, 1, loaded)
  })

  it('tells the Room when a person takes hold, lets go, resets, or wants the holder\'s pose', async () => {
    const { remote, socket } = await joined()
    remote.tookCamera()
    remote.releasedCamera(POSE)
    remote.resetCamera()
    remote.wantCamera()
    expect(socket.sent.slice(-4)).toEqual([
      { type: 'took-camera' },
      { type: 'camera-released', ...POSE },
      { type: 'camera-reset' },
      { type: 'want-camera' },
    ])
  })

  it('answers the Room with a reading of the camera now, never a kept one', async () => {
    const { socket } = await joined()
    CAMERA_PORT.read.mockReturnValueOnce(POSE).mockReturnValueOnce(null)
    socket.receive({ type: 'ask-camera', requestId: 'a' })
    socket.receive({ type: 'ask-camera', requestId: 'b' })
    expect(socket.sentOf('camera-answer')).toEqual([
      { type: 'camera-answer', requestId: 'a', pose: POSE },
      { type: 'camera-answer', requestId: 'b', pose: null },
    ])
  })

  it('shares its pose when asked, and nothing with nothing shown', async () => {
    const { socket } = await joined()
    CAMERA_PORT.read.mockReturnValueOnce(null).mockReturnValueOnce(POSE)
    socket.receive({ type: 'share-camera' })
    socket.receive({ type: 'share-camera' })
    expect(socket.sentOf('camera-shared')).toEqual([{ type: 'camera-shared', ...POSE }])
  })

  it('follows another Viewer\'s pose', async () => {
    const { socket } = await joined()
    socket.receive({ type: 'camera-moved', ...POSE })
    expect(CAMERA_PORT.follow).toHaveBeenCalledWith(POSE)
  })

  it('resets when told, confirming only if the Room asked it to', async () => {
    const { socket } = await joined()
    socket.receive({ type: 'reset-camera' })
    socket.receive({ type: 'reset-camera', requestId: 'r' })
    expect(CAMERA_PORT.reset).toHaveBeenCalledTimes(2)
    expect(socket.sentOf('camera-reset-done')).toEqual([{ type: 'camera-reset-done', requestId: 'r' }])
  })
})

describe('a dropped connection', () => {
  it('reconnects, joins again and draws the version it is resynced to', async () => {
    const { draw, onStatus, socket: first } = await joined({}, 5)
    first.drop()
    expect(onStatus).toHaveBeenLastCalledWith({ type: 'closed' })

    await vi.advanceTimersByTimeAsync(1000)
    const second = FakeSocket.latest()
    expect(second).not.toBe(first)
    second.open()
    expect(second.sent).toEqual([{ type: 'join', protocol: PROTOCOL_VERSION }])

    // The same version again: the Viewer puts back whatever it changed by hand meanwhile.
    second.receive({ type: 'state', version: 5, state: STATE, loaded: null })
    await settle()
    expect(draw.mock.calls.map(([, version]) => version)).toEqual([5, 5])
    expect(second.sentOf('realized').map((realized) => realized.version)).toEqual([5])
  })

  it('waits longer between attempts, up to five seconds', async () => {
    attach()
    for (const delay of [1000, 2000, 3000, 4000, 5000, 5000]) {
      const before = FakeSocket.instances.length
      FakeSocket.latest().drop()
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(FakeSocket.instances.length).toBe(before)
      await vi.advanceTimersByTimeAsync(1)
      expect(FakeSocket.instances.length).toBe(before + 1)
    }
  })

  it('waits one second again once a connection has opened', async () => {
    attach()
    FakeSocket.latest().drop()
    await vi.advanceTimersByTimeAsync(1000)
    FakeSocket.latest().drop()
    await vi.advanceTimersByTimeAsync(2000)
    FakeSocket.latest().open()
    FakeSocket.latest().drop()
    const before = FakeSocket.instances.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeSocket.instances.length).toBe(before + 1)
  })

  it('is not reconnected once detached', async () => {
    const { remote, onStatus, socket } = await joined()
    remote.detach()
    socket.drop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(onStatus).not.toHaveBeenCalledWith({ type: 'closed' })
  })
})

describe('a Room that refuses the Viewer', () => {
  it.each([
    ['protocol-mismatch', 'This viewer is out of date: reload the viewer.'],
    ['room-expired', 'This Room has expired.'],
    ['room-unknown', 'There is no such Room.'],
  ] as const)('on %s, tells the Viewer to show "%s" and stops for good', async (code, message) => {
    const { draw, onStatus, socket } = await joined()
    socket.receive({ type: 'error', code, message: 'What the Room said.' })
    socket.drop()
    expect(onStatus).toHaveBeenLastCalledWith({ type: 'ended', reason: code, message })

    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeSocket.instances).toHaveLength(1)
    socket.receive({ type: 'state', version: 9, state: STATE, loaded: null })
    await settle()
    expect(draw).toHaveBeenCalledTimes(1)
  })

  it('keeps going after refusing a hand change: the resync that follows puts it back', async () => {
    const { draw, onStatus, socket } = await joined({}, 2)
    socket.receive({ type: 'error', code: 'proposal-refused', message: 'No such trace.' })
    socket.receive({ type: 'state', version: 2, state: STATE, loaded: null })
    await settle()
    expect(draw).toHaveBeenCalledTimes(2)
    expect(onStatus).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ended' }))
  })
})

describe('reporting a version realized', () => {
  it('reports a version the Viewer could not draw as failed, with the kind it learned', async () => {
    const draw = vi.fn(() => ({ kind: 'point-cloud' as const, failure: 'A point cloud has no ribbon.' }))
    const { socket } = await joined({ draw }, 4)
    expect(socket.sentOf('realized')).toEqual([
      {
        type: 'realized',
        version: 4,
        kind: 'point-cloud',
        result: { outcome: 'failed', reason: 'A point cloud has no ribbon.' },
      },
    ])
  })

  it('draws one version at a time, skipping to the latest that came meanwhile', async () => {
    let finish = () => {}
    const draw = vi.fn(
      (_state, version: number) =>
        version === 1
          ? new Promise<{ kind: 'trace' }>((resolve) => (finish = () => resolve({ kind: 'trace' })))
          : { kind: 'trace' as const },
    )
    const { socket } = await joined({ draw }, 1)
    socket.receive({ type: 'state', version: 2, state: STATE, loaded: null })
    socket.receive({ type: 'state', version: 3, state: STATE, loaded: null })
    await settle()
    expect(draw.mock.calls.map(([, version]) => version)).toEqual([1])

    finish()
    await settle()
    expect(draw.mock.calls.map(([, version]) => version)).toEqual([1, 3])
    expect(socket.sentOf('realized').map((realized) => realized.version)).toEqual([1, 3])
  })

  it('reports a version failed when drawing it throws, kind unknown', async () => {
    const draw = vi.fn(async () => {
      throw new Error('No such file.')
    })
    const { socket } = await joined({ draw }, 2)
    expect(socket.sentOf('realized')).toEqual([
      { type: 'realized', version: 2, kind: null, result: { outcome: 'failed', reason: 'No such file.' } },
    ])
  })
})
