import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'roundtrip',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
