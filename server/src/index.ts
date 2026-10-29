/**
 * Cloudflare Worker entry point for spacewalk-mcp.
 *
 * Routes:
 *   GET  /* - 404 (the Viewer is hosted on its own origin, not by this Worker)
 */
export { Room } from './room.ts'

export default {
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
