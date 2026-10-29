/**
 * A Viewer's end of `/ws`, as a test drives it: connect, join, hear the Room's messages in order,
 * and report versions realized.
 */
import { SELF } from 'cloudflare:test'
import { PROTOCOL_VERSION } from '@aidenlab/spacewalk-remote/protocol'

// An origin wrangler.toml lists in VIEWER_ORIGINS.
export const VIEWER_ORIGIN = 'http://localhost:5173'

export function upgrade(room: string, origin: string | null) {
  const headers: Record<string, string> = { Upgrade: 'websocket' }
  if (origin !== null) headers.Origin = origin
  return SELF.fetch(`https://example.com/ws?room=${room}`, { headers })
}

/** Connect to a Room, join it and hear the first sync. */
export async function joinAndSync(room: string) {
  const viewer = await join(room)
  await viewer.next()
  return viewer
}

/**
 * Send a realized report, then wait until the Room has handled it: a socket's messages are
 * handled in order, so once a later join is answered, the report has been too.
 */
export async function report(viewer: Connection, realized: object) {
  viewer.send({ type: 'realized', ...realized })
  viewer.send({ type: 'join', protocol: PROTOCOL_VERSION })
  await viewer.next()
}

/** Connect to a Room and join it. */
export async function join(room: string) {
  const viewer = await connect(room)
  viewer.send({ type: 'join', protocol: PROTOCOL_VERSION })
  return viewer
}

export type Connection = Awaited<ReturnType<typeof connect>>

// A Viewer's end of a /ws connection: what it sends, and the messages it hears, in order.
export async function connect(room: string) {
  const response = await upgrade(room, VIEWER_ORIGIN)
  const socket = response.webSocket
  if (!socket) throw new Error(`No WebSocket: ${response.status}`)
  socket.accept()
  const heard: unknown[] = []
  const waiting: ((message: unknown) => void)[] = []
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data as string)
    const resolve = waiting.shift()
    if (resolve) resolve(message)
    else heard.push(message)
  })
  const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener('close', resolve))
  return {
    send(message: unknown) {
      socket.send(JSON.stringify(message))
    },
    /** The next message this Viewer hears. */
    next(): Promise<unknown> {
      if (heard.length > 0) return Promise.resolve(heard.shift())
      return new Promise((resolve) => waiting.push(resolve))
    },
    closed,
    close() {
      socket.close()
    },
  }
}
