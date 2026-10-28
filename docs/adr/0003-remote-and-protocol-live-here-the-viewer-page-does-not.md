# `spacewalk-remote` and the protocol live here; the Viewer page lives in Spacewalk

The Viewer page is built and deployed from the `spacewalk` repo, where M0 put it beside the bundle check that keeps `igv` and `juicebox.js` out of it. `@aidenlab/spacewalk-remote` — the browser library that attaches a Viewer to a Room — lives in this repo as the `remote/` workspace together with the wire protocol, is published to npm, and is pinned by the page. The Worker imports the protocol from the workspace, so server and remote cannot disagree about it. This is juicebox-mcp's split (`packages/remote` here, `juicebox-view` there), not igvjs-mcp's, whose page lives beside its Worker.

## Considered Options

- **The page in this repo, consuming Spacewalk's viewer assembly as a package.** Rejected for M1: extracting a core package from Spacewalk is a large job M1 does not need.
- **`spacewalk-remote` in the `spacewalk` repo.** Rejected: the protocol would be defined in two repos with nothing keeping them in step.

## Consequences

- A protocol change means a release of `spacewalk-remote` and a version bump in `spacewalk` before the page deploys. During development `spacewalk` depends on the workspace through `file:`.
- The deploy wizard here builds the page from `../spacewalk`.
