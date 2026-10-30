#!/usr/bin/env node
// Call one MCP tool on the dev Worker, aimed at a Room, and print the reply text.
//
//   node scripts/dev-check.mjs <room> <tool> ['<json args>']
//   node scripts/dev-check.mjs new open_viewer
//   node scripts/dev-check.mjs 7ZQH4M2K9X read_viewer_state
//   node scripts/dev-check.mjs 7ZQH4M2K9X set_render_style '{"style":"ribbon"}'
//
// A Room id cannot be made up: a Room must have been opened. `new` calls the tool without `room`,
// which is how open_viewer opens a new Room; its reply names the Room link and the Room id. See
// docs/dev-check.md.
//
// MCP_URL points the script at another Worker, such as the local one at
// http://localhost:8787/mcp. The Worker is stateless, so there is no MCP session to set up first: the one
// call is the whole conversation. Exits 1 if the tool answers with an error, 2 on bad usage.
const [roomArgument, tool, argsJson = '{}'] = process.argv.slice(2)
if (!roomArgument || !tool) {
  console.error('usage: node scripts/dev-check.mjs <room|new> <tool> [json-args]')
  process.exit(2)
}
const room = roomArgument.trim().toUpperCase()
const isNewRoom = roomArgument === 'new'
if (!isNewRoom && !/^[0-9A-HJKMNP-TV-Z]{10}$/.test(room)) {
  console.error(
    `"${roomArgument}" is not a Room id: it takes 10 characters from 0-9 and A-Z without I, L, O or U. To open a new Room: node scripts/dev-check.mjs new open_viewer`,
  )
  process.exit(2)
}
let args
try {
  args = JSON.parse(argsJson)
} catch {
  console.error(`The arguments are not JSON: ${argsJson}`)
  process.exit(2)
}
const url = process.env.MCP_URL || 'https://spacewalk-mcp-dev.3dg.io/mcp'

let response
try {
  response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: isNewRoom ? args : { ...args, room } },
    }),
  })
} catch (error) {
  console.error(`Could not reach ${url}: ${error.cause?.message ?? error.message}`)
  process.exit(1)
}
const body = await response.text()
let reply
try {
  reply = JSON.parse(body)
} catch {
  console.error(`${url} answered HTTP ${response.status}, not MCP: ${body}`)
  process.exit(1)
}
const text = (reply.result?.content ?? [])
  .filter((c) => c.type === 'text')
  .map((c) => c.text)
  .join('\n')
console.log(text || JSON.stringify(reply, null, 2))
if (reply.result?.isError || reply.error) process.exit(1)
