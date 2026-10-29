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

- `@aidenlab/spacewalk-remote`: the attach library, `attachRemote`.
- `@aidenlab/spacewalk-remote/protocol`: the wire protocol between a Viewer and a Room. It holds
  `PROTOCOL_VERSION` and the [zod](https://zod.dev) schemas of every message: `ViewerMessage`
  (Viewer → Room) and `RoomMessage` (Room → Viewer). The spacewalk-mcp Worker imports it from
  this workspace, so the two ends cannot disagree about it.

## Attaching a Viewer

```ts
import { attachRemote } from '@aidenlab/spacewalk-remote'

const remote = attachRemote({
  url: 'wss://spacewalk-mcp.3dg.io/ws',
  room, // from the Room link's ?room=
  // Draw the Room's viewer state; resolve once drawn. Say the ensemble's kind once known.
  async draw(state, version) {
    await viewer.show(state)
    return { kind: viewer.isPointCloud() ? 'point-cloud' : 'trace' }
    // or, when it cannot be drawn: return { kind, failure: 'why' } (a throw counts too)
  },
  onStatus(status) {
    // 'connecting' | 'open' | 'closed' (it reconnects) | 'ended' (for good: show status.message)
  },
})

slider.oninput = () => remote.propose({ type: 'set-structure-appearance', patch: { pointOpacity } })
controls.addEventListener('end', () => remote.propose({ type: 'set-camera', camera }))
```

The Room is authoritative: the Viewer shows only what `draw` is given, and every change by hand
is a `propose`. The library reports each version realized (drawn or failed, with the ensemble's
kind), draws one version at a time and skips to the latest, and reconnects after a drop, when the
Room resyncs it. A dragged change (structure appearance, viewer settings) is proposed once the
gesture has been still for `gestureEndMs` (250 ms), its patches merged; any other change, the
camera included, goes at once, so the Viewer proposes the camera at orbit end. While `draw` runs,
a proposal that would change nothing in the state being drawn is the Viewer's change listeners
echoing the Room, and is dropped; a listener that fires later is the Viewer's to quiet. On a
protocol mismatch, an expired Room or an unknown one, the library stops and `onStatus` gets
`ended` with the message to show ("reload the viewer", "this Room has expired").

## Releasing

Publishing a GitHub release tagged `v<version>` publishes this package at that version
(`.github/workflows/publish-remote.yml`). Bump `version` in `remote/package.json` first, since
the tag must match it. A pre-release goes to the `next` dist-tag.
