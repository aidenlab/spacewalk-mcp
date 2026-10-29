import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'remote',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
