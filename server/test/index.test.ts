import { SELF } from 'cloudflare:test'
import { expect, it } from 'vitest'

it('answers an unknown path with 404', async () => {
  const response = await SELF.fetch('https://example.com/nowhere')
  expect(response.status).toBe(404)
})
