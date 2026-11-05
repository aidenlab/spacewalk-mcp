# viewer.pin: the spacewalk commit the production Viewer page is built from. Sourced, not run, by
# scripts/deploy-prod.sh (checkout_viewer) and scripts/pin-viewer.sh (pin_viewer).
#
# The file sits at this repo's root and holds one line, the full 40-character sha of a spacewalk
# commit on origin. A prod- tag lives in this repo only, and the pin it carries says which Viewer
# page ships with it, as igvjs-mcp's package-lock.json says which igv.js its page ships.

# _on_origin SPACEWALK_DIR SHA
# Whether SHA is a commit some branch of origin holds, as of the last fetch. A commit only in the
# local clone is not, so a page built from it could not be rebuilt by anyone else.
_on_origin() {
  git -C "$1" cat-file -e "$2^{commit}" 2>/dev/null \
    && [[ -n "$(git -C "$1" for-each-ref --count=1 --contains "$2" refs/remotes/origin)" ]]
}

# checkout_viewer SPACEWALK_DIR MCP_DIR TAG DEST
# Adds a detached worktree of SPACEWALK_DIR at DEST, at the commit MCP_DIR/viewer.pin names, after
# fetching origin. Stops, adding nothing, when origin does not have that commit.
#
# A release tagged before the pin existed (prod-2026-11-05, prod-2026-11-05.1) has no viewer.pin:
# spacewalk is checked out at its own tag of the same name instead, so those still roll back. A
# local tag that differs from origin's fails the fetch, so what is deployed is what origin has.
checkout_viewer() {
  local spacewalk="$1" mcp="$2" tag="$3" dest="$4" sha
  if [[ ! -e "$mcp/viewer.pin" ]]; then
    echo "no viewer.pin at $tag; building the Viewer page from spacewalk's tag $tag"
    git -C "$spacewalk" ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null \
      || { echo "tag $tag is not on origin of $spacewalk, and $tag has no viewer.pin to say which spacewalk to ship" >&2; return 1; }
    git -C "$spacewalk" fetch -q origin "refs/tags/$tag:refs/tags/$tag"
    git -C "$spacewalk" worktree add -q --detach "$dest" "$tag"
    return
  fi
  sha="$(head -n 1 "$mcp/viewer.pin")"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] \
    || { echo "viewer.pin at $tag holds '$sha', not the 40-character sha of a spacewalk commit; write it with scripts/pin-viewer.sh" >&2; return 1; }
  git -C "$spacewalk" fetch -q origin
  _on_origin "$spacewalk" "$sha" \
    || { echo "spacewalk commit $sha is not on origin of $spacewalk (viewer.pin at $tag); nothing was deployed. Push it, or pin a commit origin has with scripts/pin-viewer.sh and make a new tag" >&2; return 1; }
  _note_if_behind "$spacewalk" "$sha"
  git -C "$spacewalk" worktree add -q --detach "$dest" "$sha"
}

# A pin behind origin/main is allowed, since rolling back ships one, but it is said out loud, so
# shipping an older Viewer page is a choice someone made.
_note_if_behind() {
  local behind
  behind="$(git -C "$1" rev-list --count "$2..origin/main" 2>/dev/null || echo 0)"
  (( behind == 0 )) && return 0
  echo "note: the pinned spacewalk $(git -C "$1" rev-parse --short "$2") is $behind commit$( (( behind == 1 )) || echo s) behind spacewalk origin/main ($(git -C "$1" rev-parse --short origin/main)); the Viewer page ships without them. scripts/pin-viewer.sh moves the pin."
}

# pin_viewer SPACEWALK_DIR PIN_FILE [REF]
# Fetches spacewalk's origin, resolves REF (default origin/main) to a full sha and writes it to
# PIN_FILE. Refuses, writing nothing, a commit that no branch of origin holds.
pin_viewer() {
  local spacewalk="$1" pin_file="$2" ref="${3:-origin/main}" sha
  git -C "$spacewalk" fetch -q origin
  sha="$(git -C "$spacewalk" rev-parse --verify -q "$ref^{commit}")" \
    || { echo "$ref is not a commit in $spacewalk; viewer.pin was not changed" >&2; return 1; }
  _on_origin "$spacewalk" "$sha" \
    || { echo "$ref ($sha) is not on origin of $spacewalk; push it first. viewer.pin was not changed" >&2; return 1; }
  printf '%s\n' "$sha" >"$pin_file"
  echo "viewer.pin: spacewalk $(git -C "$spacewalk" log -1 --format='%h %s' "$sha")"
}
