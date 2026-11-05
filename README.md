# spacewalk-mcp

A Connector for Claude and ChatGPT that lets the model open and drive a [Spacewalk](https://github.com/aidenlab/spacewalk) 3D chromatin viewer shown beside the conversation.

The vocabulary used here is defined in [`GLOSSARY.md`](GLOSSARY.md); decisions are in [`docs/adr/`](docs/adr/).

## Layout

- `server/`: a Cloudflare Worker, the MCP endpoint (`/mcp`).
- `remote/`: [`@aidenlab/spacewalk-remote`](remote/README.md), published to npm: the library that attaches a Viewer to a Room, and the wire protocol the Worker imports from it.
- `roundtrip/`: end-to-end tests of the Viewer page, built from [`../spacewalk`](https://github.com/aidenlab/spacewalk), against the local Worker.

The Viewer page itself is built and deployed from the `spacewalk` repo, which pins `@aidenlab/spacewalk-remote` (ADR 0003).

## Requirements

- [Node.js](https://nodejs.org) and npm

## Getting started

```sh
npm install
cp server/.dev.vars.example server/.dev.vars   # local stand-ins for the Worker's secrets
npm run dev:server   # the local Worker, on http://localhost:8787
```

## Checks

```sh
npm run typecheck
npm run test:run
```

## Deploying

Nothing deploys from CI. Both stacks need a Cloudflare login that can reach the `3dg.io` zone and a `spacewalk` checkout next to this one (or `SPACEWALK_DIR`).

| Stack      | Worker                                                  | Viewer page (Pages project)                                          | Deployed from  |
| ---------- | ------------------------------------------------------- | -------------------------------------------------------------------- | -------------- |
| dev        | `spacewalk-mcp-dev` at `https://spacewalk-mcp-dev.3dg.io` | `spacewalk-viewer-dev` at `https://spacewalk-viewer-dev.pages.dev/viewer.html` | working trees  |
| production | `spacewalk-mcp` at `https://spacewalk-mcp.3dg.io`         | `spacewalk-viewer` at `https://spacewalk-viewer.pages.dev/viewer.html`         | a release tag  |

```sh
scripts/deploy-dev.sh [worker|viewer|all]   # test, deploy to dev, check the result
```

To check the deploy in Claude and ChatGPT, see `docs/checking-a-host.md`.

To release, tag `main` here, push the tag and deploy it. `spacewalk` is not tagged: `viewer.pin` names the `spacewalk` commit the Viewer page is built from, and `scripts/pin-viewer.sh` moves it.

```sh
git tag prod-2026-11-01 origin/main && git push origin prod-2026-11-01
scripts/deploy-prod.sh prod-2026-11-01
```

`deploy-prod.sh` tests and deploys from throwaway worktrees, this repo at the tag and `spacewalk` at the pinned commit, so uncommitted changes never ship. A second release on a day is `prod-2026-11-01.1`. To roll back, deploy an earlier tag. The first release also creates the Worker, the Pages project and the secret. The connector URL to give Claude or ChatGPT is the Worker's address plus `/mcp`.

[`docs/production-release.md`](docs/production-release.md) is the full release procedure, with its checks and rollback. [`docs/production-deployment.md`](docs/production-deployment.md) is the short version: tagging a release and moving the pin.

[`docs/dev-check.md`](docs/dev-check.md) is the cheat sheet for `scripts/dev-check.mjs`, which calls one tool on the dev Worker from the terminal: a smoke test without a Host.
