import { defineConfig } from 'vitest/config'

// The deploy scripts' own checks, run in bash against a fake Deployment on localhost.
export default defineConfig({
  test: {
    name: 'scripts',
    include: ['**/*.test.mjs'],
  },
})
