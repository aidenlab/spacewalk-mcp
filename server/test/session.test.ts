/**
 * Session strings at the edges of the Room: read against strings Spacewalk's own `BGZip` wrote, and
 * written so that Spacewalk's reader gets what the snapshot URL promises (spacewalk
 * `development-notes/spacewalk-mcp/session-format.md`).
 */
import { describe, expect, it } from 'vitest'
import { readSessionString, writeSessionString } from '../src/session.ts'

// Written by igv-utils' BGZip.compressString, as `blob:` + that, from these objects.
const SETTINGS_FROM_SPACEWALK = 'blob:q1ZKSkzOTi_KL81LUbKqVipSsjLQUUoHk0lAshbIycvPzc8DSZZlFmcm5aQqWZUUlabqgNQagtUagtUagtSCDQrIScxLRdGQlphTDNFhoGcKMR9EJ4FpoL6i1LTUotS85NSg0pzUInx2wdxVCwA-'
const SETTINGS = {
  background: { r: 0, g: 0, b: 0 },
  gnomon: { visible: true, r: 1, g: 1, b: 1 },
  groundPlane: { visible: false, r: 0.5, g: 0.5, b: 0.5 },
  referenceRuler: { visible: true, r: 1, g: 0, b: 0 },
}

describe('a session string', () => {
  it('reads as Spacewalk wrote it', async () => {
    expect(await readSessionString(SETTINGS_FROM_SPACEWALK)).toEqual(SETTINGS)
  })

  it('reads under the data: prefix too', async () => {
    expect(await readSessionString(`data:${SETTINGS_FROM_SPACEWALK.slice('blob:'.length)}`)).toEqual(SETTINGS)
  })

  it('reads as a gzipped data URI', async () => {
    // gzip of {"a":1}, base64.
    const dataUri = 'data:application/gzip;base64,H4sIAAAAAAAC/6tWSlSyMqwFAK+sG1YHAAAA'
    expect(await readSessionString(dataUri)).toEqual({ a: 1 })
  })

  it('is written in the URL-safe spelling, and reads back', async () => {
    const written = await writeSessionString(SETTINGS)
    expect(written).toMatch(/^blob:[A-Za-z0-9._-]+$/)
    expect(await readSessionString(written)).toEqual(SETTINGS)
  })

  it('keeps characters beyond a byte, which Spacewalk reads one byte at a time', async () => {
    const written = await writeSessionString({ url: 'https://example.org/β.sw' })
    expect(await readSessionString(written)).toEqual({ url: 'https://example.org/β.sw' })
    // Plain ASCII once inflated: the first and only escape is in the JSON itself.
    const raw = atob(written.slice('blob:'.length).replace(/\./g, '+').replace(/_/g, '/').replace(/-/g, '='))
    const inflated = new Response(
      new Blob([Uint8Array.from(raw, (c) => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('deflate-raw')),
    )
    expect(await inflated.text()).toContain('\\u03b2')
  })

  it.each(['blob:not-a-session', 'blob:', 'https://example.org/s.json', 'hello'])('throws on %j', async (string) => {
    await expect(readSessionString(string)).rejects.toThrow()
  })
})
