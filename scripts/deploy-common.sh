# What scripts/deploy-dev.sh and scripts/deploy-prod.sh share. Sourced, not run.
#
# The caller sets:
#   SERVER_DIR     the server/ whose wrangler.toml and wrangler are used
#   WRANGLER_ENV   the [env.*] of that wrangler.toml
#   BASE_URL       the Worker's address
#   PAGES_PROJECT  the Pages project the Viewer page is uploaded to
#   VERSION        what the Worker reports as its MCP serverInfo.version (see build_version)
# VIEWER_URL in [env.*] must be the address viewer_url gives here.

# Pages commands do not read wrangler.toml, so they are given its account here.
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-$(sed -n 's/^account_id = "\(.*\)"/\1/p' "$SERVER_DIR/wrangler.toml")}"
CHECK_FAILURES=0

wrangler()   { (cd "$SERVER_DIR" && npx wrangler "$@"); }
viewer_url() { printf 'https://%s.pages.dev/viewer.html' "$PAGES_PROJECT"; }

# build_version REPO_DIR [NAME]
# `<NAME> (<short sha>)` for REPO_DIR's HEAD. NAME is the release tag on prod; left out, it is the
# branch (HEAD when detached). Taken from git, so nothing is bumped by hand.
build_version() {
  local name="${2:-$(git -C "$1" rev-parse --abbrev-ref HEAD)}"
  printf '%s (%s)' "$name" "$(git -C "$1" rev-parse --short HEAD)"
}

# deploy_worker [wrangler deploy options]
deploy_worker() { wrangler deploy --env "$WRANGLER_ENV" --var "VERSION:$VERSION" "$@"; }

# Sets SESSION_HMAC_SECRET only if it is missing: changing it moves every ChatGPT conversation to a
# new Room. A list that fails stops here, since read as "not set" it would change the secret.
ensure_secret() {
  local out
  out=$(wrangler secret list --env "$WRANGLER_ENV" 2>/dev/null) \
    || { echo "could not list the secrets of the $WRANGLER_ENV Worker; nothing was changed" >&2; return 1; }
  if [[ "$out" == *SESSION_HMAC_SECRET* ]]; then
    echo "SESSION_HMAC_SECRET is already set"
  else
    echo "SESSION_HMAC_SECRET is not set; storing 32 random bytes"
    openssl rand -hex 32 | wrangler secret put SESSION_HMAC_SECRET --env "$WRANGLER_ENV"
  fi
}

# Matches the whole name: spacewalk-viewer must not be taken for spacewalk-viewer-dev.
ensure_pages_project() {
  local out
  out=$(wrangler pages project list --json 2>/dev/null) \
    || { echo "could not list the Pages projects; nothing was changed" >&2; return 1; }
  if [[ "$out" == *"\"$PAGES_PROJECT\""* ]]; then
    echo "the Pages project $PAGES_PROJECT exists"
  else
    wrangler pages project create "$PAGES_PROJECT" --production-branch main
  fi
}

# build_and_upload_viewer SPACEWALK_DIR
# Vite inlines VITE_* at build time and a direct upload never sees the project's variables, so the
# Worker's address is passed to the build. spacewalk's lockfile is not in git, hence npm install.
build_and_upload_viewer() {
  local page_dir="$1"
  (cd "$page_dir" && npm install --no-audit --no-fund --loglevel=error)
  # A link is a local remote/ (`npm install ../spacewalk-mcp/remote --no-save`), not the pinned one.
  [[ ! -L "$page_dir/node_modules/@aidenlab/spacewalk-remote" ]] \
    || { echo "@aidenlab/spacewalk-remote in $page_dir is a link to a local copy; remove it and run this again" >&2; return 1; }
  echo "building the Viewer page with VITE_SERVER_URL=$BASE_URL"
  (cd "$page_dir" && VITE_SERVER_URL="$BASE_URL" npm run build)
  grep -q "${BASE_URL#https://}" "$page_dir"/dist/assets/*.js \
    || { echo "the built assets do not contain $BASE_URL; nothing was uploaded" >&2; return 1; }
  wrangler pages deploy "$page_dir/dist" --project-name "$PAGES_PROJECT" --branch main --commit-dirty=true
}

# ── Checks on what was deployed. A failure is reported and counted, and does not stop the others. ──

_check() {
  if [[ "$3" == "$2" ]]; then
    echo "  ok      $1"
  else
    echo "  FAILED  $1 (wanted $2, got '$3')" >&2
    CHECK_FAILURES=$((CHECK_FAILURES + 1))
  fi
}

# Polls for up to two minutes (a new custom domain needs a certificate); prints the last status.
_wait_for_code() {
  local got="" i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    got=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1" || true)
    [[ "$got" == "$2" ]] && break
    sleep 10
  done
  printf '%s' "$got"
}

_ws_code() {
  curl -s -o /dev/null -w '%{http_code}' --http1.1 --max-time 5 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H "Origin: $1" "$BASE_URL/ws?room=7ZQH4M2K9X" || true
}

# The Room id the Worker derives from x-openai-session. The Room was never opened, so the refusal
# names it; without the secret there is none.
_hmac_room() {
  curl -s --max-time 15 -X POST "$BASE_URL/mcp" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "x-openai-session: $1" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_viewer_state","arguments":{}}}' \
    | grep -oE 'No such Room as [0-9A-Z]{10}' | grep -oE '[0-9A-Z]{10}$' || true
}

# The serverInfo.version an MCP initialize gets back; empty if there is none.
_server_version() {
  curl -s --max-time 15 -X POST "$BASE_URL/mcp" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"deploy-check","version":"1"}}}' \
    | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).result.serverInfo.version))}catch{}})' \
    || true
}

# Polls for up to a minute: the Worker just deployed may take a moment to replace the one before.
_wait_for_version() {
  local got="" i
  for i in 1 2 3 4 5 6; do
    got=$(_server_version)
    [[ "$got" == "$1" ]] && break
    sleep 10
  done
  printf '%s' "$got"
}

check_worker() {
  local room_a room_a_again room_b
  echo "checking the Worker at $BASE_URL"
  _check "GET /mcp answers 405" 405 "$(_wait_for_code "$BASE_URL/mcp" 405)"
  _check "initialize reports the version just deployed" "$VERSION" "$(_wait_for_version "$VERSION")"
  room_a=$(_hmac_room deploy-check-a); room_a_again=$(_hmac_room deploy-check-a); room_b=$(_hmac_room deploy-check-b)
  if [[ -n "$room_a" && "$room_a" == "$room_a_again" && "$room_a" != "$room_b" ]]; then
    _check "x-openai-session derives a stable Room id (the secret works)" ok ok
  else
    _check "x-openai-session derives a stable Room id (the secret works)" "one stable id per session" "$room_a, $room_a_again, $room_b"
  fi
  _check "/ws refuses an unlisted Origin" 403 "$(_ws_code https://example.com)"
  _check "/ws accepts https://$PAGES_PROJECT.pages.dev" 101 "$(_ws_code "https://$PAGES_PROJECT.pages.dev")"
}

# Follows redirects: Pages may send viewer.html on to /viewer.
check_viewer() {
  echo "checking the Viewer page at $(viewer_url)"
  _check "the Viewer page answers 200" 200 "$(curl -sL -o /dev/null -w '%{http_code}' --max-time 15 "$(viewer_url)" || true)"
}

# Run last: the deployment is in place by now, so this reports rather than undoes anything.
finish_checks() {
  (( CHECK_FAILURES == 0 )) && return 0
  echo "$CHECK_FAILURES check(s) failed: what was uploaded is live, but it is not working as it should" >&2
  return 1
}
