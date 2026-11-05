// What the deploy scripts write and check about versions (scripts/deploy-common.sh): the Viewer
// page's version.json, written into the built page from git before it is uploaded, and the checks
// that the Deployment's GET /version reports the Worker and the page just deployed. Run in bash
// against a fake page checkout and a fake Deployment on localhost.
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const COMMON = join(import.meta.dirname, 'deploy-common.sh')

// Sources deploy-common.sh as the deploy scripts do, then runs `body`.
function bash(body, env = {}) {
  const script = `
    SERVER_DIR=/nonexistent CLOUDFLARE_ACCOUNT_ID=test
    source "${COMMON}"
    ${body}
  `
  return new Promise((resolve) =>
    execFile('bash', ['-c', script], { env: { ...process.env, ...env } }, (error, stdout, stderr) =>
      resolve({ status: error ? error.code : 0, stdout, stderr }),
    ),
  )
}

describe('write_viewer_version', () => {
  let page

  const git = (...args) => execFileSync('git', ['-C', page, ...args], { encoding: 'utf8' }).trim()

  beforeEach(() => {
    page = mkdtempSync(join(tmpdir(), 'spacewalk-page-'))
    const remote = join(page, 'node_modules/@aidenlab/spacewalk-remote')
    mkdirSync(join(remote, 'src'), { recursive: true })
    mkdirSync(join(page, 'dist'))
    writeFileSync(join(remote, 'package.json'), JSON.stringify({ name: '@aidenlab/spacewalk-remote', version: '0.3.1' }))
    writeFileSync(join(remote, 'src/protocol.ts'), "import { z } from 'zod'\n\nexport const PROTOCOL_VERSION = 2\n")
    writeFileSync(join(page, '.gitignore'), 'node_modules/\ndist/\n')
    writeFileSync(join(page, 'index.html'), '<!doctype html>\n')
    git('init', '-q', '-b', 'main')
    git('add', '.')
    git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'page')
  })
  afterEach(() => rmSync(page, { recursive: true, force: true }))

  const versionFile = () => JSON.parse(readFileSync(join(page, 'dist/version.json'), 'utf8'))

  it("writes the page's branch and commit, its pinned spacewalk-remote and that package's protocol", async () => {
    const run = await bash(`write_viewer_version "${page}" && echo "VIEWER_VERSION=$VIEWER_VERSION"`)
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    const sha = git('rev-parse', '--short', 'HEAD')
    expect(versionFile()).toEqual({ version: `main (${sha})`, 'spacewalk-remote': '0.3.1', protocol: 2 })
    expect(run.stdout).toContain(`VIEWER_VERSION=main (${sha})`)
  })

  it('names the release tag it is given, as deploy-prod.sh does from a detached worktree', async () => {
    git('checkout', '-q', '--detach')
    const run = await bash(`write_viewer_version "${page}" prod-2026-11-05`)
    expect(run.status).toBe(0)
    expect(versionFile().version).toBe(`prod-2026-11-05 (${git('rev-parse', '--short', 'HEAD')})`)
  })

  it('marks a page built with uncommitted changes -dirty', async () => {
    writeFileSync(join(page, 'index.html'), '<!doctype html><title>changed</title>\n')
    await bash(`write_viewer_version "${page}"`)
    expect(versionFile().version).toBe(`main (${git('rev-parse', '--short', 'HEAD')}-dirty)`)
  })

  it('fails, writing nothing, when the page has no spacewalk-remote installed', async () => {
    rmSync(join(page, 'node_modules'), { recursive: true })
    const run = await bash(`write_viewer_version "${page}"`)
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('spacewalk-remote')
    expect(() => versionFile()).toThrow()
  })
})

describe('the /version checks', () => {
  let server, base, deployed

  beforeEach(async () => {
    deployed = {
      worker: 'main (a1b2c3d)',
      protocol: 2,
      viewer: { url: 'x/version.json', version: 'main (9e1d2b7)', 'spacewalk-remote': '0.3.1', protocol: 2 },
    }
    server = createServer((req, res) => {
      if (req.url === '/version') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(deployed))
      } else {
        res.statusCode = req.url === '/viewer.html' ? 200 : 404
        res.end()
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterEach(() => new Promise((resolve) => server.close(resolve)))

  // One look at /version, not a minute of them: what the fake Deployment says will not change.
  const check = (fn, vars) =>
    bash(`BASE_URL="${base}" ${vars}; viewer_url() { printf '%s/viewer.html' "${base}"; }; ${fn} && finish_checks`, {
      VERSION_POLLS: '1',
    })

  it('check_viewer passes when /version reports the page just uploaded', async () => {
    const run = await check('check_viewer', 'VIEWER_VERSION="main (9e1d2b7)"')
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
  })

  it('check_viewer fails when /version reports another page', async () => {
    deployed.viewer.version = 'main (0000000)'
    const run = await check('check_viewer', 'VIEWER_VERSION="main (9e1d2b7)"')
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain("got 'main (0000000)'")
  })

  it("check_viewer fails, saying why, when the Worker could not read the page's version.json", async () => {
    deployed.viewer = { url: 'x/version.json', error: 'HTTP 404' }
    const run = await check('check_viewer', 'VIEWER_VERSION="main (9e1d2b7)"')
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('HTTP 404')
  })

  it('check_worker_version passes when /version reports the Worker just deployed', async () => {
    const run = await check('check_worker_version', 'VERSION="main (a1b2c3d)"')
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
  })

  it('check_worker_version fails when /version reports another Worker', async () => {
    const run = await check('check_worker_version', 'VERSION="main (fffffff)"')
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain("got 'main (a1b2c3d)'")
  })
})
