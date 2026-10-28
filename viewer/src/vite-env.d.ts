interface ImportMetaEnv {
  /** The spacewalk-mcp server the Viewer talks to. */
  readonly VITE_SERVER_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
