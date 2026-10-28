# The Room is authoritative

Each Room holds one structured, versioned **viewer state**: the ensemble (URL, group, trace, kind), the render style and structure appearance, the viewer settings, and the camera. Tool calls and Viewers only make **proposals**; the Room orders them, applies them, bumps the version and broadcasts the result to every Viewer. Viewers are replicas: a reconnect is a resync, and a late joiner's first sync is the same thing. Relative steps (bigger balls, a darker background) are applied by the Room to the current value, so they need no read-then-write and cannot race a hand change. A tool reply waits for a Viewer to report the new version **realized** (drawn, or failed), with a timeout.

The viewer state is not a session string. Spacewalk's session string is written only at the edges, for a shareable URL, and read only by `load_session`; holding it opaquely would leave the Room unable to apply a single change without a Viewer present.

## Considered Options

- **Relay commands between pages, as juicebox-mcp does.** Rejected for its documented costs: async completions escaping the echo guard, position-based identity, drift on reconnect, unordered concurrent edits, and failures hidden behind the first ack.
- **Push commands to the page and wait for an ack, as igvjs-mcp does.** Rejected: nothing happens without a page open, and the server never knows the state it reports.
- **Store the session string opaquely.** Rejected as above.

## Consequences

- With no Viewer open, a tool call still takes effect; the reply says it is not shown yet.
- Knowledge Spacewalk owns, such as the radius ladder, is copied into the Worker as data.
- Whether an ensemble is a point cloud is known only once a Viewer reports it; until then the Room cannot refuse `set_render_style` and the Viewer reports the failure instead.
