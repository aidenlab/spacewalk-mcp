/**
 * A WebSocket as `attachRemote` uses it, driven by a test: open it, have the Room send it
 * messages, close it, and read what the Viewer sent.
 */
import type { RoomMessage, ViewerState } from '../src/protocol.ts'

export class FakeSocket {
  static instances: FakeSocket[] = []

  /** The latest socket `attachRemote` created. */
  static latest(): FakeSocket {
    const socket = FakeSocket.instances.at(-1)
    if (!socket) throw new Error('No socket was created')
    return socket
  }

  readyState = 0
  /** What the Viewer sent, parsed, in order. */
  sent: any[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.readyState = 3
  }

  open() {
    this.readyState = 1
    this.onopen?.()
  }

  /** The Room sends a message. */
  receive(message: RoomMessage | object | string) {
    const data = typeof message === 'string' ? message : JSON.stringify(message)
    this.onmessage?.({ data })
  }

  /** The connection drops, or the Room ends it. */
  drop() {
    this.readyState = 3
    this.onclose?.()
  }

  /** What the Viewer sent of one type. */
  sentOf(type: string): any[] {
    return this.sent.filter((message) => message.type === type)
  }
}

export const STATE: ViewerState = {
  ensemble: { url: 'https://example.com/a.sw', groupKey: null, traceKey: null, kind: null },
  renderStyle: 'ball-and-stick',
  structureAppearance: {
    ballRadiusIndex: 5,
    stickRadiusIndex: 5,
    sticksVisible: true,
    pointSizeRadiusFraction: null,
    pointOpacity: 1,
    colorRamp: 'spectral',
    isCircular: false,
  },
  viewerSettings: {
    background: { r: 1, g: 1, b: 1 },
    gnomon: { r: 0, g: 0, b: 0, visible: true },
    groundPlane: { r: 0.5, g: 0.5, b: 0.5, visible: true },
    referenceRuler: { r: 0, g: 0, b: 0, visible: false },
  },
  camera: null,
}
