# Releasing to production

How to ship the Worker and the Viewer page to production, check them and roll back. Nothing deploys from CI: a person runs each release from their own machine. Room, Viewer, Host and Connector are defined in `GLOSSARY.md`.

| | Worker | Viewer page (Pages project) |
| --- | --- | --- |
| Dev | `spacewalk-mcp-dev` at `https://spacewalk-mcp-dev.3dg.io` | `spacewalk-viewer-dev` at `https://spacewalk-viewer-dev.pages.dev/viewer.html` |
| Production | `spacewalk-mcp` at `https://spacewalk-mcp.3dg.io` | `spacewalk-viewer` at `https://spacewalk-viewer.pages.dev/viewer.html` |

Production shares nothing with dev: it has its own Rooms and its own secret, and only its own page may connect.

The whole release, in order:

1. Check what you are about to ship.
2. Tag `main` in both repos with the same name.
3. Deploy that tag.
4. Check production in a browser and in a Host.

## You need

- This repo, with the `spacewalk` checkout next to it. If it is elsewhere, pass `--spacewalk <path>` to the deploy script.
- Node.js and npm, `curl` and `openssl`.
- A wrangler login that can reach the account owning the `3dg.io` zone. `npx wrangler whoami` in `server/` should list account `1eadb18bb8557fd1bd06b1d0310a902e`.
- Push access to tags in both repos.

Run every command below from the root of this repo.

## 1. Check what you are about to ship

Fetch both repos first:

```sh
git fetch origin --tags
git -C ../spacewalk fetch origin
```

**What you tested on dev is what is on `main`.** `deploy-dev.sh` deploys the working trees as they stand, so a passing dev check says nothing about `main` unless the two match. These should print nothing:

```sh
git diff --stat HEAD origin/main
git -C ../spacewalk diff --stat HEAD origin/main
git status --short
git -C ../spacewalk status --short
```

If they print anything, get the two to match, redeploy dev with `scripts/deploy-dev.sh` and check it again.

**The Viewer page pins the `remote/` that `main` has.** The Viewer page gets `@aidenlab/spacewalk-remote` from the version `spacewalk` pins, not from this repo, and the Worker refuses a Viewer whose protocol version differs from its own. See which version is pinned:

```sh
git -C ../spacewalk show origin/main:package.json | grep spacewalk-remote
```

Then compare that version's tag with `main`, here for `0.3.0`. Versions from 0.3.0 on are on npm and tagged `v<version>`. 0.1.0 and 0.2.0 were tarballs, tagged `remote-<version>`:

```sh
git diff --stat v0.3.0 origin/main -- remote
```

If that shows changes to `remote/`, release a new version and update the pin in `spacewalk` before going on. `docs/releasing-spacewalk-remote.md` explains how. A `prod-` tag does not publish the package.

## 2. Tag `main` in both repos

The tag is `prod-YYYY-MM-DD`, and a second release on the same day is `prod-YYYY-MM-DD.1`. Use the same name in both repos.

Tag `origin/main` by name. A bare `git tag` tags whatever is checked out, which may be a feature branch.

```sh
TAG=prod-2026-11-01

git tag "$TAG" origin/main
git push origin "$TAG"

git -C ../spacewalk tag "$TAG" origin/main
git -C ../spacewalk push origin "$TAG"
```

Never move a tag once it is pushed. To ship a fix, merge it to `main` and make a new tag.

## 3. Deploy the tag

```sh
scripts/deploy-prod.sh "$TAG"
```

The script does these steps in order, stopping if one fails:

1. Checks out both repos at the tag in throwaway worktrees, so uncommitted changes never ship.
2. Runs the tests. If they fail, nothing has been deployed.
3. Deploys the Worker.
4. Sets `SESSION_HMAC_SECRET`, only if it is missing.
5. Checks the Worker: `/mcp` answers and reports `<tag> (<short sha>)` as its version, the secret works, and `/ws` accepts the production page and refuses other origins.
6. Creates the Pages project, only if it is missing.
7. Builds the Viewer page against the production Worker and uploads it.
8. Checks that the Viewer page answers.

It ends with `released <tag>`, the page address and the Worker address.

**During the deploy:** the Worker goes live before the Viewer page. If the release changes the protocol version, Viewers are told "This viewer is out of date: reload the viewer." until the upload finishes, and a reload does not help until then.

**If a check fails:** the script reports `check(s) failed: what was uploaded is live`. Nothing is undone for you, so fix the cause or roll back.

**If the script stops partway:** the Worker may be live without its matching page. Run the same tag again if the cause was outside the code, such as a lost connection or an expired login. If the code has to change, make a new tag.

### The first release

The first release also creates the Worker, its `spacewalk-mcp.3dg.io` domain, the Pages project and the secret. The steps are the same, with these differences:

- The new domain needs a certificate, so the Worker check can take up to two minutes.
- There is no earlier tag to roll back to.
- ChatGPT's requests fail until the secret is set, moments after the Worker goes live.

## 4. Check production

The script's checks show that the Worker and the page answer. They do not show that the two work together, so open a Room.

`scripts/dev-check.mjs` calls the dev Worker unless `MCP_URL` says otherwise, so name production every time:

```sh
export MCP_URL=https://spacewalk-mcp.3dg.io/mcp
node scripts/dev-check.mjs new open_viewer
```

The Room link in the reply must start with `https://spacewalk-viewer.pages.dev/viewer.html`. Open it in a browser, and use the Room id it gives in place of `<room>`:

```sh
node scripts/dev-check.mjs <room> read_viewer_state
node scripts/dev-check.mjs <room> load_ensemble '{"url":"https://pub-398373e8d1204c57beab2ae62ef6cc91.r2.dev/A549_chr21-28-30Mb.sw"}'
node scripts/dev-check.mjs <room> set_render_style '{"style":"ribbon"}'
node scripts/dev-check.mjs <room> reset_camera
node scripts/dev-check.mjs <room> get_shareable_url
```

| Call | Passes if |
| --- | --- |
| `read_viewer_state` | The reply says `Viewers connected: 1.` |
| `load_ensemble` | The reply starts `Applied and drawn`, and the structure shows |
| `set_render_style` | The structure changes to a ribbon |
| `reset_camera` | The reply confirms the reset, and the view frames |
| `get_shareable_url` | The link opens the same view in a new tab |

`docs/dev-check.md` has more calls and explains the common errors.

Then check in a Host, using the production Connector: see `docs/checking-a-host.md`.

If a ticket depends on this release, record the tag on it before closing it.

## Rolling back

Deploy an earlier tag:

```sh
scripts/deploy-prod.sh prod-2026-10-31
```

This restores the Worker and the Viewer page together, so they stay on the same protocol version. Afterwards, run the checks in step 4 again.

- **It is not an exact rebuild.** The `spacewalk` lockfile is not in git, so the page's dependencies are resolved again at build time.
- **Rooms are kept.** A deploy does not clear them. Before rolling back a release that changed what a Room stores, check that the older Worker can read what the newer one wrote.
- **The secret stays as it is.** Changing `SESSION_HMAC_SECRET` moves every ChatGPT conversation to a new Room, so do not change it as part of a rollback.

## When something goes wrong

- **`tag ... is not on origin`:** the tag was not pushed in one of the repos. Push it and run the script again.
- **`would clobber existing tag`, or the tag fetch fails:** your local tag differs from origin's. Delete the local one with `git tag -d <tag>` and run the script again, so that what deploys is what origin has.
- **`@aidenlab/spacewalk-remote ... is a link to a local copy`:** this comes from a dev checkout. A release builds in a fresh worktree, so it should not happen here. If it does, check what `spacewalk`'s tag pins.
- **"This viewer is out of date: reload the viewer." after the release:** reload first. If it stays, the page's pinned protocol version differs from the Worker's, which is the check in step 1.
- **"No such Room as ..." from `dev-check`:** `MCP_URL` is probably not set to production in this shell, or the Room was opened on dev.
- **The Worker's logs:** `npx wrangler tail --env prod` in `server/`.
