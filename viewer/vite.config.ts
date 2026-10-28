import { defineConfig } from 'vite'

// The port is fixed: the local Worker's VIEWER_URL names it.
export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
  },
})
