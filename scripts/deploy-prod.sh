#!/usr/bin/env bash
# Deploy production from one release tag, never from a working tree:
#
#   Worker       spacewalk-mcp     at https://spacewalk-mcp.3dg.io  (server/wrangler.toml [env.prod])
#   Viewer page  spacewalk-viewer  at https://spacewalk-viewer.pages.dev/viewer.html
#
#   scripts/deploy-prod.sh prod-YYYY-MM-DD[.N] [--spacewalk <path>]
#
# Releasing: tag spacewalk-mcp main and spacewalk main with the same name, push both tags, run this.
# Both repos are checked out at the tag into throwaway worktrees, the tests run there, and the
# Worker and the page are deployed from there using the tag's own deploy scripts. So uncommitted
# changes never ship, and rolling back is deploying an earlier tag. --spacewalk (else SPACEWALK_DIR,
# else the checkout next to this one) only says where that clone is.
#
# The first release creates the Worker, the Pages project and SESSION_HMAC_SECRET. Later releases
# leave the secret as it is. A prod- tag does not publish @aidenlab/spacewalk-remote: that is a v tag
# (.github/workflows/publish-remote.yml), and the page's own pin says which version it ships.
set -euo pipefail

USAGE="usage: scripts/deploy-prod.sh prod-YYYY-MM-DD[.N] [--spacewalk <path>]"
TAG=""
while (($#)); do
  case "$1" in
    --spacewalk) SPACEWALK_DIR="${2:?$USAGE}"; shift 2 ;;
    --spacewalk=*) SPACEWALK_DIR="${1#--spacewalk=}"; shift ;;
    -*) echo "$USAGE" >&2; exit 2 ;;
    *) [[ -z "$TAG" ]] || { echo "$USAGE" >&2; exit 2; }; TAG="$1"; shift ;;
  esac
done
[[ -n "$TAG" ]] || { echo "$USAGE" >&2; exit 2; }
[[ "$TAG" =~ ^prod-[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]+)?$ ]] || { echo "not a release tag: $TAG (prod-YYYY-MM-DD[.N])" >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPACEWALK_DIR="${SPACEWALK_DIR:-$REPO_ROOT/../spacewalk}"
[[ -d "$SPACEWALK_DIR/.git" ]] || { echo "no spacewalk checkout at $SPACEWALK_DIR; pass --spacewalk" >&2; exit 1; }

WORK="$(mktemp -d)"
cleanup() {
  git -C "$REPO_ROOT" worktree remove --force "$WORK/mcp" 2>/dev/null || true
  git -C "$SPACEWALK_DIR" worktree remove --force "$WORK/spacewalk" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# A local tag that differs from origin's fails this fetch, so what is deployed is what origin has.
for repo in "$REPO_ROOT" "$SPACEWALK_DIR"; do
  git -C "$repo" ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null \
    || { echo "tag $TAG is not on origin of $repo; push it first" >&2; exit 1; }
  git -C "$repo" fetch -q origin "refs/tags/$TAG:refs/tags/$TAG"
done

git -C "$REPO_ROOT" worktree add -q --detach "$WORK/mcp" "$TAG"
git -C "$SPACEWALK_DIR" worktree add -q --detach "$WORK/spacewalk" "$TAG"
echo "spacewalk-mcp $(git -C "$WORK/mcp" rev-parse --short HEAD), spacewalk $(git -C "$WORK/spacewalk" rev-parse --short HEAD) at $TAG"

SERVER_DIR="$WORK/mcp/server"
WRANGLER_ENV=prod
BASE_URL=https://spacewalk-mcp.3dg.io
PAGES_PROJECT=spacewalk-viewer
# shellcheck source=scripts/deploy-common.sh
source "$WORK/mcp/scripts/deploy-common.sh"
VERSION="$(build_version "$WORK/mcp" "$TAG")"

(cd "$WORK/mcp" && npm ci --no-audit --no-fund --loglevel=error && npm run test:run)

deploy_worker --message "$TAG"
ensure_secret
check_worker
ensure_pages_project
build_and_upload_viewer "$WORK/spacewalk"
check_viewer
finish_checks
echo "released $TAG: $(viewer_url) and $BASE_URL/mcp"
