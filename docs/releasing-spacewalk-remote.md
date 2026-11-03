# Releasing spacewalk-remote

How to publish a new version of `@aidenlab/spacewalk-remote` (the `remote/` workspace) to npm, and get the Viewer page onto it. The Worker never needs a release: it reads `remote/` straight from this repo. Remote, Viewer and Room are defined in `GLOSSARY.md`.

The package is at <https://www.npmjs.com/package/@aidenlab/spacewalk-remote>. 0.3.0 was its first npm version. 0.1.0 and 0.2.0 were only GitHub release tarballs (`remote-0.1.0`, `remote-0.2.0`). Leave those releases where they are, because older `spacewalk` commits still pin their URLs.

## Rules

- **A published version is never replaced.** npm won't accept the same version number twice, even after an unpublish. A fix is the next version.
- **The tag is `v` plus the version in `remote/package.json`**, such as `v0.3.1`. A `v` release starts `publish-remote.yml`, and that workflow fails if the tag and the version disagree.
- **A pre-release goes to the `next` dist-tag**, not `latest`. A plain `npm install` doesn't pick it up.
- **`spacewalk` pins an exact version**, such as `"0.3.0"`, never a range. It doesn't commit its lockfile, so a range would let two installs get different code.

## Release a new version

1. In this repo, bump the version on a branch, then merge it to `main` by pull request:

   ```sh
   npm version 0.3.1 --workspace remote --no-git-tag-version
   ```

   Raise `PROTOCOL_VERSION` in `remote/src/protocol.ts` only when an older Viewer and a newer Room can't work together. A change that only adds messages leaves it as it is.

2. Check what will be published, from an up-to-date, clean `main`:

   ```sh
   git switch main && git pull --ff-only
   npm run typecheck && npm run test:run
   npm publish --workspace remote --dry-run
   ```

   The list should be six files: `LICENSE`, `README.md`, `package.json` and the three files in `src/`.

3. Create the GitHub release. This publishes:

   ```sh
   gh release create v0.3.1 --repo aidenlab/spacewalk-mcp --target main \
     --title "spacewalk-remote 0.3.1" --notes "What changed, for a Viewer."
   ```

   Then approve the run under the repo's **Actions** tab. The `npm` environment holds every publish until a reviewer approves it.

4. Check the version on npm. A new version can take a few minutes to show up:

   ```sh
   npm view @aidenlab/spacewalk-remote dist-tags
   ```

   Then install it into an empty folder and check that it holds what you expect.

5. In `spacewalk/package.json`, set the new exact version. Run `npm install`, `npm test` and `npm run build`, then merge by pull request.

## Publishing by hand

0.3.0 was published from a laptop with `npm publish --workspace remote`, before trusted publishing was set up. If the workflow is ever unavailable, the same command works from a clean `main`. It needs:

- an npm login (`npm login`) with two-factor authentication turned on. Without 2FA, npm answers 403;
- membership of the `aidenlab` org on npm.

Afterwards, tag the published commit, because `docs/production-release.md` compares against the tag. Push only the tag. A GitHub release would start the workflow on a version that's already published:

```sh
git tag v0.3.0 6586971 && git push origin v0.3.0
```

## One-time setup the workflow needs

`publish-remote.yml` logs in to npm with trusted publishing (OIDC), so the repo stores no npm token. Two settings make it work:

- **On npmjs.com**, under the package's **Settings** → **Trusted Publisher** → **GitHub Actions**: organization `aidenlab`, repository `spacewalk-mcp`, workflow `publish-remote.yml`, environment `npm`. Once that works, set **Publishing access** to require two-factor authentication and disallow tokens.
- **On GitHub**, under `spacewalk-mcp` → **Settings** → **Environments**: an environment named `npm` with at least one required reviewer.

Both were set up on November 2, 2026. npm keeps a new Trusted Publisher in "pending validation" until a publish comes through it. The pre-release `v0.3.1-rc.0`, which has no code changes, did that on November 3, 2026, going to the `next` dist-tag with provenance attached. If a publish step ever gets a 403 or 404 from npm, one of the four Trusted Publisher fields no longer matches the workflow.
