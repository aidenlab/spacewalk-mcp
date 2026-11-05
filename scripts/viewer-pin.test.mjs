// viewer.pin (scripts/viewer-pin.sh): the spacewalk commit the production Viewer page is built from.
// deploy-prod.sh checks spacewalk out at the pin its tag carries, and pin-viewer.sh writes the pin.
// Run in bash against a throwaway spacewalk clone whose origin is a bare repo on disk.
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const LIB = join(import.meta.dirname, 'viewer-pin.sh')
const TAG = 'prod-2026-11-05.1'

let root, origin, spacewalk, mcp, dest, commits

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    encoding: 'utf8',
  }).trim()

function commit(message) {
  writeFileSync(join(spacewalk, 'page.txt'), `${message}\n`)
  git(spacewalk, 'add', '.')
  git(spacewalk, 'commit', '-q', '-m', message)
  return git(spacewalk, 'rev-parse', 'HEAD')
}

// origin/main has `first` (tagged TAG) then `second`; `local` is committed in the clone but never pushed.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'viewer-pin-'))
  origin = join(root, 'origin.git')
  spacewalk = join(root, 'spacewalk')
  mcp = join(root, 'mcp')
  dest = join(root, 'work/spacewalk')
  mkdirSync(mcp)
  mkdirSync(join(root, 'work'))
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['clone', '-q', origin, spacewalk], { stdio: 'ignore' })
  commits = { first: commit('first') }
  git(spacewalk, 'tag', TAG)
  commits.second = commit('second')
  git(spacewalk, 'push', '-q', 'origin', 'main', TAG)
  commits.local = commit('local')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const pin = (text) => writeFileSync(join(mcp, 'viewer.pin'), text)

function bash(body) {
  return new Promise((resolve) =>
    execFile('bash', ['-c', `set -euo pipefail; source "${LIB}"; ${body}`], (error, stdout, stderr) =>
      resolve({ status: error ? error.code : 0, stdout, stderr }),
    ),
  )
}

const checkoutViewer = () => bash(`checkout_viewer "${spacewalk}" "${mcp}" ${TAG} "${dest}"`)
const checkedOut = () => git(dest, 'rev-parse', 'HEAD')

describe('checkout_viewer', () => {
  it('checks spacewalk out at the commit viewer.pin names', async () => {
    pin(`${commits.first}\n`)
    const run = await checkoutViewer()
    expect(run.status).toBe(0)
    expect(checkedOut()).toBe(commits.first)
  })

  it('fetches a pinned commit that was pushed to origin since this clone last fetched', async () => {
    const other = join(root, 'other')
    execFileSync('git', ['clone', '-q', origin, other], { stdio: 'ignore' })
    writeFileSync(join(other, 'page.txt'), 'elsewhere\n')
    git(other, 'commit', '-q', '-am', 'elsewhere')
    git(other, 'push', '-q', 'origin', 'main')
    const elsewhere = git(other, 'rev-parse', 'HEAD')
    pin(`${elsewhere}\n`)
    const run = await checkoutViewer()
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(checkedOut()).toBe(elsewhere)
  })

  it('notes, without stopping, that a pin behind origin/main ships an older Viewer page', async () => {
    pin(`${commits.first}\n`)
    const run = await checkoutViewer()
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('1 commit behind spacewalk origin/main')
  })

  it('says nothing about the pin when it is origin/main', async () => {
    pin(`${commits.second}\n`)
    const run = await checkoutViewer()
    expect(run.status).toBe(0)
    expect(checkedOut()).toBe(commits.second)
    expect(run.stdout).not.toContain('behind')
  })

  it('stops, checking nothing out, when the pinned commit is not on origin', async () => {
    pin(`${commits.local}\n`)
    const run = await checkoutViewer()
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain(`${commits.local} is not on origin`)
    expect(existsSync(dest)).toBe(false)
  })

  it('stops when viewer.pin does not hold a full sha', async () => {
    pin(`${commits.first.slice(0, 7)}\n`)
    const run = await checkoutViewer()
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('40-character sha')
    expect(existsSync(dest)).toBe(false)
  })

  it('checks out the spacewalk tag of the same name when the release has no viewer.pin, as tags before the pin do', async () => {
    const run = await checkoutViewer()
    expect(run.status).toBe(0)
    expect(checkedOut()).toBe(commits.first)
  })

  it('stops when the release has no viewer.pin and spacewalk has no tag of that name on origin', async () => {
    git(spacewalk, 'push', '-q', 'origin', `:refs/tags/${TAG}`)
    const run = await checkoutViewer()
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain(`tag ${TAG} is not on origin`)
    expect(existsSync(dest)).toBe(false)
  })
})

describe('pin_viewer', () => {
  const pinFile = () => join(mcp, 'viewer.pin')
  const pinViewer = (ref = '') => bash(`pin_viewer "${spacewalk}" "${pinFile()}" ${ref}`)

  it("writes the full sha of spacewalk's origin/main, not of the local main", async () => {
    const run = await pinViewer()
    expect(run.status).toBe(0)
    expect(readFileSync(pinFile(), 'utf8')).toBe(`${commits.second}\n`)
  })

  it('writes the full sha of a ref it is given, when origin has that commit', async () => {
    const run = await pinViewer(TAG)
    expect(run.status).toBe(0)
    expect(readFileSync(pinFile(), 'utf8')).toBe(`${commits.first}\n`)
  })

  it('refuses, leaving viewer.pin as it was, a commit that is not on origin', async () => {
    pin(`${commits.first}\n`)
    const run = await pinViewer('main')
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('is not on origin')
    expect(readFileSync(pinFile(), 'utf8')).toBe(`${commits.first}\n`)
  })
})
