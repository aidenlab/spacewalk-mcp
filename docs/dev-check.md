# dev-check cheat sheet

`scripts/dev-check.mjs` drives a Viewer on the dev deployment from the terminal, taking the model's place: one tool call per run, aimed at a Room. Use it for a smoke test after `scripts/deploy-wizard.sh`, without a Host.

Room, Viewer and Room link are defined in `GLOSSARY.md`.

## 1. Open a Room

A Room id cannot be made up: a Room must have been opened first. `new` calls the tool without a Room, which is how `open_viewer` opens one:

```sh
node scripts/dev-check.mjs new open_viewer
```

The reply names the Room link and the Room id. Open the Room link in a browser. Never use a Room someone is working in.

## 2. Call a tool

```sh
node scripts/dev-check.mjs <room> <tool> ['<json args>']
```

The script adds `room` to the arguments itself. It prints the reply, and exits 1 if the tool answered with an error (2 if the command line itself is wrong). `2NNGYETVZD` below stands for your Room id.

| To | Run |
| --- | --- |
| See what the Viewer shows | `node scripts/dev-check.mjs 2NNGYETVZD read_viewer_state` |
| List the example ensembles | `node scripts/dev-check.mjs 2NNGYETVZD list_example_ensembles` |
| Load an ensemble | `node scripts/dev-check.mjs 2NNGYETVZD load_ensemble '{"url":"https://pub-398373e8d1204c57beab2ae62ef6cc91.r2.dev/A549_chr21-28-30Mb.sw"}'` |
| Set the render style | `node scripts/dev-check.mjs 2NNGYETVZD set_render_style '{"style":"ribbon"}'` (or `ball_and_stick`) |
| Make the balls bigger | `node scripts/dev-check.mjs 2NNGYETVZD step_ball_radius '{"direction":"up"}'` (or `down`) |
| Make the sticks thicker | `node scripts/dev-check.mjs 2NNGYETVZD step_stick_radius '{"direction":"up"}'` (or `down`) |
| Darken the background | `node scripts/dev-check.mjs 2NNGYETVZD adjust_background '{"direction":"darker"}'` (or `lighter`) |
| Reset the camera | `node scripts/dev-check.mjs 2NNGYETVZD reset_camera` |
| Get a shareable URL | `node scripts/dev-check.mjs 2NNGYETVZD get_shareable_url` |
| Get the Room link again | `node scripts/dev-check.mjs 2NNGYETVZD open_viewer` |

`server/src/tools.ts` and `server/src/commandTools.ts` give every tool's arguments.

## A smoke test

With the Viewer open on the Room link:

```sh
node scripts/dev-check.mjs 2NNGYETVZD load_ensemble '{"url":"https://pub-398373e8d1204c57beab2ae62ef6cc91.r2.dev/A549_chr21-28-30Mb.sw"}'
node scripts/dev-check.mjs 2NNGYETVZD set_render_style '{"style":"ribbon"}'
node scripts/dev-check.mjs 2NNGYETVZD set_render_style '{"style":"ball_and_stick"}'
node scripts/dev-check.mjs 2NNGYETVZD step_ball_radius '{"direction":"up"}'
node scripts/dev-check.mjs 2NNGYETVZD adjust_background '{"direction":"darker"}'
node scripts/dev-check.mjs 2NNGYETVZD reset_camera
node scripts/dev-check.mjs 2NNGYETVZD read_viewer_state
node scripts/dev-check.mjs 2NNGYETVZD get_shareable_url
```

Watch the Viewer change as each call lands. Change something by hand, and the next reply says so. Open the shareable URL in a new tab, and it shows the same view.

## When it goes wrong

- **"No such Room as …"**: that Room was never opened on this Worker. A local Worker's Rooms are unrelated to the dev Worker's. Run `new open_viewer`.
- **"Viewers connected: 0."**, or "Applied, not shown yet — no viewer is open.": the browser tab is not on that Room link, or has not connected yet.
- **Another Worker**: `MCP_URL` overrides the dev Worker, e.g. `MCP_URL=http://localhost:8787/mcp` for the local Worker. Start it with `npm run dev --workspace server -- --var VIEWER_URL:http://localhost:5173/viewer.html`, or the Room link opens the full app, which ignores `?room=`. The Viewer must also be one built for that Worker, which `npm run dev` in `spacewalk` is.
- **The server's view**: `npx wrangler tail --env dev` in `server/` logs each change and which Room it acted on.
