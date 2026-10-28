# spacewalk-mcp

A Connector for Claude and ChatGPT that lets the model open and drive a [Spacewalk](https://github.com/aidenlab/spacewalk) 3D chromatin viewer shown beside the conversation.

The vocabulary used here is defined in [`GLOSSARY.md`](GLOSSARY.md); decisions are in [`docs/adr/`](docs/adr/).

## Layout

- `server/`: a Cloudflare Worker, the MCP endpoint (`/mcp`).
- `viewer/`: the Viewer, a Vite web page that will house Spacewalk.
- `roundtrip/`: end-to-end tests of the built Viewer against the local Worker.

## Requirements

- [Node.js](https://nodejs.org) and npm

## Getting started

```sh
npm install
cp server/.dev.vars.example server/.dev.vars   # local stand-ins for the Worker's secrets
npm run dev:server   # the local Worker, on http://localhost:8787
npm run dev:viewer   # the Viewer, on http://localhost:5173 (in a second terminal)
```

## Checks

```sh
npm run typecheck
npm run test:run
```
