# Production deployment

The two procedures a production release needs: moving the pinned `spacewalk` when the Viewer page should change, and tagging and deploying a release. `docs/production-release.md` is the full reference, with every check, the rollback and what to do when something goes wrong. Viewer and Room are defined in `GLOSSARY.md`.

Run every command from the root of this repo, with the `spacewalk` checkout next to it. If it is elsewhere, pass `--spacewalk <path>` to both scripts.

## How a release is made up

A release is one tag, `prod-YYYY-MM-DD`, in this repo only. `spacewalk` is never tagged.

| | Built from |
| --- | --- |
| Worker | this repo at the tag |
| Viewer page | the `spacewalk` commit named by `viewer.pin` at the tag |

`viewer.pin` sits at the root of this repo. It holds one line: the full 40-character sha of a `spacewalk` commit that is on origin. It changes only by pull request, so each change of Viewer page is a reviewed commit, "Pin spacewalk to `<sha>`".

`/version` shows both halves: the Worker as `<tag> (<spacewalk-mcp short sha>)` and the Viewer page as `<tag> (<pinned spacewalk short sha>)`.

## Updating the pinned spacewalk

Do this when the release should ship a newer Viewer page, before you tag. Skip it if the Viewer page stays as it is.

1. **Get the `spacewalk` commit you want onto its origin.** Merge the change to `spacewalk` `main` by pull request. A commit that only exists on your machine can't be pinned.

2. **Move the pin on a branch.** With no argument, `pin-viewer.sh` pins `spacewalk`'s `origin/main`. Give it a ref to pin something else, such as an older commit:

   ```sh
   git fetch origin
   git switch -c pin-spacewalk origin/main
   scripts/pin-viewer.sh            # or: scripts/pin-viewer.sh <ref>
   ```

   The script fetches `spacewalk`, resolves the ref to a full sha, and writes `viewer.pin`. If no branch of origin holds the commit, it refuses and leaves `viewer.pin` as it was.

3. **Check the `@aidenlab/spacewalk-remote` that commit pins.** The Worker refuses a Viewer whose protocol version differs from its own. See which version the pinned commit's `package.json` names:

   ```sh
   git -C ../spacewalk show "$(cat viewer.pin):package.json" | grep spacewalk-remote
   ```

   If `remote/` here has changed since that version's tag (`git diff --stat v<version> origin/main -- remote`), release a new version first (see `docs/releasing-spacewalk-remote.md`), pin it in `spacewalk`, and go back to step 1.

4. **Commit the pin and merge it by pull request:**

   ```sh
   git commit -m "Pin spacewalk to $(cut -c1-7 viewer.pin)" viewer.pin
   git push -u origin pin-spacewalk
   ```

5. **Test that `spacewalk` on dev.** Check out the pinned commit in `../spacewalk` and deploy dev, which builds from the working trees as they stand:

   ```sh
   git switch main && git pull --ff-only
   git -C ../spacewalk checkout --detach "$(cat viewer.pin)"
   scripts/deploy-dev.sh
   ```

   Check dev as `docs/production-release.md` step 4 describes, with `MCP_URL` unset so `dev-check` calls the dev Worker. Leave `../spacewalk` at the pinned commit until the release is deployed: the first check below compares it with `viewer.pin`. Afterwards, return it to its branch with `git -C ../spacewalk switch main`.

## Tagging and deploying a release

1. **Check that what you tested on dev is what you are about to ship.** These should print nothing:

   ```sh
   git fetch origin --tags
   git diff --stat HEAD origin/main
   git status --short
   git -C ../spacewalk status --short
   [ "$(git -C ../spacewalk rev-parse HEAD)" = "$(git show origin/main:viewer.pin)" ] || echo "viewer.pin is not the spacewalk you tested"
   ```

   If they print anything, either move the pin (above) or bring the checkouts in line with `main`, then redeploy dev and check it again.

2. **Tag `origin/main` in this repo and push the tag.** The name is `prod-YYYY-MM-DD`. A second release on the same day is `prod-YYYY-MM-DD.1`, then `.2`. Name `origin/main` explicitly, since a bare `git tag` tags whatever is checked out:

   ```sh
   TAG=prod-2026-11-06
   git tag "$TAG" origin/main
   git push origin "$TAG"
   ```

   Do not tag `spacewalk`. Never move a tag once it is pushed. To ship a fix, merge it and make a new tag.

3. **Deploy the tag:**

   ```sh
   scripts/deploy-prod.sh "$TAG"
   ```

   The script checks out this repo at the tag and `spacewalk` at the pin, runs the tests, deploys the Worker and the Viewer page, and checks the result. It ends with `released <tag>`. Before anything deploys, it stops if `spacewalk`'s origin does not have the pinned commit. If the pin is behind `spacewalk`'s `origin/main`, it prints a note and carries on. That is expected when you meant to ship an older Viewer page. Otherwise, move the pin and make a new tag.

4. **Check production.** Open `https://spacewalk-mcp.3dg.io/version` and check that the Viewer page's sha is the start of `viewer.pin`. Then open a Room and check it in a Host, as `docs/production-release.md` step 4 says.

## Rolling back

Deploy an earlier tag: `scripts/deploy-prod.sh <earlier tag>`. The Viewer page is built from the pin that tag carries, so the Worker and the page go back together.

`prod-2026-11-05` and `prod-2026-11-05.1` came before `viewer.pin`. For them, the script builds the page from `spacewalk`'s tag of the same name, so keep those two tags in `spacewalk`.
