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

```sh
scripts/deploy-wizard.sh
```

The [deploy wizard](scripts/deploy-wizard.sh) deploys the dev environment (the Worker `spacewalk-mcp-dev` and the Pages project `spacewalk-viewer-dev`) and walks you through connecting Claude desktop, claude.ai, ChatGPT desktop and ChatGPT web. It is re-runnable.

[`docs/dev-check.md`](docs/dev-check.md) is the cheat sheet for `scripts/dev-check.mjs`, which calls one tool on the dev Worker from the terminal: a smoke test without a Host.
