#!/usr/bin/env bash
# Deploy the dev stack by hand, from these working trees (nothing deploys from CI):
#
#   Worker       spacewalk-mcp-dev     at https://spacewalk-mcp-dev.3dg.io  (server/wrangler.toml [env.dev])
#   Viewer page  spacewalk-viewer-dev  at https://spacewalk-viewer-dev.pages.dev/viewer.html
#
#   scripts/deploy-dev.sh           # both
#   scripts/deploy-dev.sh worker    # the Worker only
#   scripts/deploy-dev.sh viewer    # the Viewer page only
#
# Runs the tests first and checks the result last. The Viewer page is built from the spacewalk
# checkout next to this one (SPACEWALK_DIR names another), as it stands, uncommitted changes
# included. https://spacewalk-mcp-dev.3dg.io/version says what is live, Worker and page. To check the Hosts as well, see
# docs/checking-a-host.md.
set -euo pipefail

TARGET="${1:-all}"
case "$TARGET" in
  worker|viewer|all) ;;
  *) echo "usage: scripts/deploy-dev.sh [worker|viewer|all]" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"
SPACEWALK_DIR="${SPACEWALK_DIR:-$REPO_ROOT/../spacewalk}"
WRANGLER_ENV=dev
BASE_URL=https://spacewalk-mcp-dev.3dg.io
PAGES_PROJECT=spacewalk-viewer-dev
# shellcheck source=scripts/deploy-common.sh
source "$REPO_ROOT/scripts/deploy-common.sh"

deploy_worker_target() {
  VERSION="$(build_version "$REPO_ROOT")"
  echo "spacewalk-mcp at $VERSION"
  deploy_worker
  ensure_secret
  check_worker
}

deploy_viewer_target() {
  [[ -d "$SPACEWALK_DIR/.git" ]] || { echo "no spacewalk checkout at $SPACEWALK_DIR; set SPACEWALK_DIR" >&2; exit 1; }
  git -C "$SPACEWALK_DIR" fetch -q origin main || echo "could not fetch spacewalk's main; comparing with the last one fetched" >&2
  git -C "$SPACEWALK_DIR" log -1 --format='spacewalk at %h %s'
  [[ "$(git -C "$SPACEWALK_DIR" rev-parse HEAD)" == "$(git -C "$SPACEWALK_DIR" rev-parse origin/main)" ]] \
    || echo "warning: that is not spacewalk's origin/main" >&2
  [[ -z "$(git -C "$SPACEWALK_DIR" status --porcelain)" ]] \
    || echo "warning: that checkout has uncommitted changes, and they will be uploaded" >&2
  ensure_pages_project
  build_and_upload_viewer "$SPACEWALK_DIR"
  check_viewer
}

(cd "$REPO_ROOT" && npm run test:run)
[[ "$TARGET" == viewer ]] || deploy_worker_target
[[ "$TARGET" == worker ]] || deploy_viewer_target
finish_checks
[[ "$TARGET" == viewer ]] || echo "MCP server URL: $BASE_URL/mcp"
[[ "$TARGET" == worker ]] || echo "Viewer page: $(viewer_url)"
echo "What is live: $BASE_URL/version"
