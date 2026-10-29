# @aidenlab/spacewalk-remote

Attach a [Spacewalk](https://github.com/aidenlab/spacewalk) Viewer to a Room on the
[spacewalk-mcp](https://github.com/aidenlab/spacewalk-mcp) server, so a model connected over MCP
can drive it. The vocabulary is defined in spacewalk-mcp's
[`GLOSSARY.md`](https://github.com/aidenlab/spacewalk-mcp/blob/main/GLOSSARY.md).

```sh
npm install @aidenlab/spacewalk-remote
```

The package is TypeScript source with no build step. Its consumers bundle it: the Spacewalk
viewer page with Vite, the spacewalk-mcp Worker with wrangler.

## Exports

- `@aidenlab/spacewalk-remote`: the attach library. Empty for now.
- `@aidenlab/spacewalk-remote/protocol`: the wire protocol between a Viewer and a Room. It holds
  `PROTOCOL_VERSION` and the [zod](https://zod.dev) schemas of every message: `ViewerMessage`
  (Viewer → Room) and `RoomMessage` (Room → Viewer). The spacewalk-mcp Worker imports it from
  this workspace, so the two ends cannot disagree about it.

## Releasing

Publishing a GitHub release tagged `v<version>` publishes this package at that version
(`.github/workflows/publish-remote.yml`). Bump `version` in `remote/package.json` first, since
the tag must match it. A pre-release goes to the `next` dist-tag.
