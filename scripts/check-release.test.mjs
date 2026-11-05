// check_release (scripts/deploy-common.sh), the last thing deploy-prod.sh does: the live Deployment
// reports the release, lists the Spacewalk tools, and its Room link loads on the Viewer page. It is
// run in bash against a fake Deployment on localhost, whose Worker and Viewer page are one server.
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const COMMON = join(import.meta.dirname, 'deploy-common.sh')
const RELEASE = 'prod-2026-11-05 (a1b2c3d)'
const TOOLS = ['open_viewer', 'list_example_ensembles', 'read_viewer_state', 'load_session']

let server, base, deployment

beforeEach(async () => {
  deployment = { version: RELEASE, tools: TOOLS, viewerPage: null, pageStatus: 200 }
  server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/mcp') {
      let body = ''
      req.on('data', (d) => (body += d)).on('end', () => {
        const { id, method } = JSON.parse(body)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: answer(method) }))
      })
    } else if (req.url.startsWith('/viewer.html')) {
      res.statusCode = deployment.pageStatus
      res.end('<!doctype html>')
    } else {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
afterEach(() => new Promise((resolve) => server.close(resolve)))

function answer(method) {
  if (method === 'initialize') return { serverInfo: { name: 'spacewalk', version: deployment.version } }
  if (method === 'tools/list') return { tools: deployment.tools.map((name) => ({ name })) }
  if (method === 'tools/call') {
    const roomLink = `${deployment.viewerPage ?? `${base}/viewer.html`}?room=7ZQH4M2K9X`
    return { content: [{ type: 'text', text: `Spacewalk Room link:\n${roomLink}` }], structuredContent: { room: '7ZQH4M2K9X', roomLink } }
  }
  return {}
}

// Runs check_release, then finish_checks as deploy-prod.sh does, with this Deployment standing in for the Worker and the Viewer page.
function checkRelease() {
  const script = `
    SERVER_DIR=/nonexistent CLOUDFLARE_ACCOUNT_ID=test
    source "${COMMON}"
    BASE_URL="${base}" VERSION="${RELEASE}"
    viewer_url() { printf '%s/viewer.html' "${base}"; }
    check_release && finish_checks
  `
  return new Promise((resolve) =>
    execFile('bash', ['-c', script], (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr })),
  )
}

describe('check_release', () => {
  it('passes when the Deployment reports the release, lists the tools and its Room link loads', async () => {
    const run = await checkRelease()
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.stdout).toContain(RELEASE)
  })

  it('fails when the Deployment reports another version', async () => {
    deployment.version = 'main (0000000)'
    const run = await checkRelease()
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain("got 'main (0000000)'")
  })

  it('fails when the Deployment does not list open_viewer', async () => {
    deployment.tools = ['read_viewer_state']
    const run = await checkRelease()
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('open_viewer')
  })

  it('fails when the Room link is not on the Viewer page', async () => {
    deployment.viewerPage = 'https://spacewalk-viewer-dev.pages.dev/viewer.html'
    const run = await checkRelease()
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('spacewalk-viewer-dev.pages.dev')
  })

  it('fails when the Room link does not load', async () => {
    deployment.pageStatus = 404
    const run = await checkRelease()
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain("got '404'")
  })
})
