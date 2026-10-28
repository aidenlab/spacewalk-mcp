import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'viewer',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
