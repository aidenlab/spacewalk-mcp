import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Runs inside workerd with the Worker from wrangler.toml.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: { bindings: { SESSION_HMAC_SECRET: 'test-session-hmac-secret' } },
    }),
  ],
  test: {
    name: 'server',
    include: ['test/**/*.test.ts'],
  },
})
