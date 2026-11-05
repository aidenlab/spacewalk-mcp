# What scripts/deploy-dev.sh and scripts/deploy-prod.sh share. Sourced, not run.
#
# The caller sets:
#   SERVER_DIR     the server/ whose wrangler.toml and wrangler are used
#   WRANGLER_ENV   the [env.*] of that wrangler.toml
#   BASE_URL       the Worker's address
#   PAGES_PROJECT  the Pages project the Viewer page is uploaded to
#   VERSION        what the Worker reports as its MCP serverInfo.version (see build_version)
# build_and_upload_viewer sets VIEWER_VERSION, what the page it uploads reports (see write_viewer_version).
# VIEWER_URL in [env.*] must be the address viewer_url gives here.

# Pages commands do not read wrangler.toml, so they are given its account here.
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-$(sed -n 's/^account_id = "\(.*\)"/\1/p' "$SERVER_DIR/wrangler.toml")}"
CHECK_FAILURES=0

wrangler()   { (cd "$SERVER_DIR" && npx wrangler "$@"); }
viewer_url() { printf 'https://%s.pages.dev/viewer.html' "$PAGES_PROJECT"; }

# build_version REPO_DIR [NAME]
# `<name> (<short sha>)` for REPO_DIR's HEAD, as igvjs-mcp and geenee build theirs. The name is NAME
# when given (the release tag: deploy-prod.sh's worktree is detached), else the tag at HEAD, else
# the branch, else "detached". The sha carries -dirty when tracked files differ from HEAD, so a
# build of uncommitted work does not claim a commit it does not run. Taken from git, so nothing is
# bumped by hand.
build_version() {
  local name="${2:-}" dirty=""
  [[ -n "$name" ]] || name="$(git -C "$1" describe --tags --exact-match HEAD 2>/dev/null \
    || git -C "$1" symbolic-ref --short -q HEAD || echo detached)"
  git -C "$1" diff --quiet HEAD || dirty="-dirty"
  printf '%s (%s%s)' "$name" "$(git -C "$1" rev-parse --short HEAD)" "$dirty"
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

# Run by an agent (Claude Code, Cursor and the like), wrangler 4.155 turns a Pages command on a
# project that does not exist yet into a Worker deploy: `pages project create` uploaded server/ as a
# Worker named after the page. --force keeps these Pages commands. A person running them is unaffected.
PAGES_ONLY=--force

# Matches the whole name: spacewalk-viewer must not be taken for spacewalk-viewer-dev. A project that
# still is not listed after the create stops here, so nothing is deployed in its place.
_pages_project_listed() {
  local out
  out=$(wrangler pages project list --json 2>/dev/null) \
    || { echo "could not list the Pages projects; nothing was changed" >&2; return 2; }
  [[ "$out" == *"\"$PAGES_PROJECT\""* ]]
}

ensure_pages_project() {
  local listed=0
  _pages_project_listed || listed=$?
  if (( listed == 0 )); then
    echo "the Pages project $PAGES_PROJECT exists"
    return 0
  fi
  (( listed == 1 )) || return 1
  wrangler pages project create "$PAGES_PROJECT" --production-branch main "$PAGES_ONLY"
  _pages_project_listed \
    || { echo "wrangler did not create the Pages project $PAGES_PROJECT; check that it made no Worker in its place" >&2; return 1; }
}

# write_viewer_version PAGE_DIR [NAME]
# Writes PAGE_DIR/dist/version.json, what the built page reports and the Worker's GET /version passes
# on, and sets VIEWER_VERSION. Its version is build_version's for the page's checkout (NAME as there);
# beside it, the @aidenlab/spacewalk-remote the page installed and the PROTOCOL_VERSION that package
# exports, since a Room refuses a Viewer that speaks another protocol. The package ships TypeScript,
# which node will not load from node_modules, so the constant is read from its source.
write_viewer_version() {
  local page_dir="$1" remote="$1/node_modules/@aidenlab/spacewalk-remote" remote_version protocol
  remote_version=$(node -p "require(process.argv[1]).version" "$remote/package.json" 2>/dev/null) \
    || { echo "no @aidenlab/spacewalk-remote installed in $page_dir; no version.json was written" >&2; return 1; }
  protocol=$(sed -n 's/^export const PROTOCOL_VERSION = \([0-9][0-9]*\).*/\1/p' "$remote/src/protocol.ts" 2>/dev/null)
  [[ -n "$protocol" ]] \
    || { echo "no PROTOCOL_VERSION in $remote/src/protocol.ts; no version.json was written" >&2; return 1; }
  VIEWER_VERSION="$(build_version "$page_dir" "${2:-}")"
  node -e 'const [file, version, remote, protocol] = process.argv.slice(1)
    require("fs").writeFileSync(file, JSON.stringify({ version, "spacewalk-remote": remote, protocol: Number(protocol) }) + "\n")' \
    "$page_dir/dist/version.json" "$VIEWER_VERSION" "$remote_version" "$protocol"
  echo "the Viewer page reports $VIEWER_VERSION, spacewalk-remote $remote_version, protocol $protocol"
}

# build_and_upload_viewer SPACEWALK_DIR [NAME]
# Vite inlines VITE_* at build time and a direct upload never sees the project's variables, so the
# Worker's address is passed to the build. spacewalk's lockfile is not in git, hence npm install.
# NAME is the release tag on prod, as for build_version.
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
  write_viewer_version "$page_dir" "${2:-}"
  wrangler pages deploy "$page_dir/dist" --project-name "$PAGES_PROJECT" --branch main --commit-dirty=true "$PAGES_ONLY"
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

# _mcp METHOD PARAMS_JSON JS_EXPRESSION
# Posts one JSON-RPC request to $BASE_URL/mcp and prints JS_EXPRESSION of its result (`r`); empty
# when there is no answer or the expression throws. The expression is pasted into a double-quoted
# node -e, so it must not contain ", $ or a backtick.
_mcp() {
  curl -s --max-time 15 -X POST "$BASE_URL/mcp" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" \
    | node -e "let s='';process.stdin.on('data',(d)=>(s+=d)).on('end',()=>{try{const r=JSON.parse(s).result;process.stdout.write(String($3))}catch{}})" \
    || true
}

# The serverInfo.version an MCP initialize gets back; empty if there is none.
_server_version() {
  _mcp initialize '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"deploy-check","version":"1"}}' \
    r.serverInfo.version
}

# _poll WANTED COMMAND [ARGS...]
# Runs COMMAND VERSION_POLLS times (default 6), ten seconds apart, until it prints WANTED; prints
# what it last printed. A new Worker takes a moment to replace the old, and Pages to serve a new page.
_poll() {
  local wanted="$1" got="" i
  shift
  for ((i = 1; i <= ${VERSION_POLLS:-6}; i++)); do
    got=$("$@")
    [[ "$got" == "$wanted" ]] && break
    (( i < ${VERSION_POLLS:-6} )) && sleep 10
  done
  printf '%s' "$got"
}

_wait_for_version() { _poll "$1" _server_version; }

# _version_field JS_EXPRESSION
# JS_EXPRESSION of what GET $BASE_URL/version answers (`r`); empty when there is no answer or the
# expression throws. The same quoting rules as _mcp.
_version_field() {
  curl -s --max-time 15 "$BASE_URL/version" \
    | node -e "let s='';process.stdin.on('data',(d)=>(s+=d)).on('end',()=>{try{const r=JSON.parse(s);process.stdout.write(String($1))}catch{}})" \
    || true
}


check_worker_version() {
  _check "/version reports the Worker just deployed" "$VERSION" "$(_poll "$VERSION" _version_field r.worker)"
}

check_worker() {
  local room_a room_a_again room_b
  echo "checking the Worker at $BASE_URL"
  _check "GET /mcp answers 405" 405 "$(_wait_for_code "$BASE_URL/mcp" 405)"
  _check "initialize reports the version just deployed" "$VERSION" "$(_wait_for_version "$VERSION")"
  check_worker_version
  room_a=$(_hmac_room deploy-check-a); room_a_again=$(_hmac_room deploy-check-a); room_b=$(_hmac_room deploy-check-b)
  if [[ -n "$room_a" && "$room_a" == "$room_a_again" && "$room_a" != "$room_b" ]]; then
    _check "x-openai-session derives a stable Room id (the secret works)" ok ok
  else
    _check "x-openai-session derives a stable Room id (the secret works)" "one stable id per session" "$room_a, $room_a_again, $room_b"
  fi
  _check "/ws refuses an unlisted Origin" 403 "$(_ws_code https://example.com)"
  _check "/ws accepts https://$PAGES_PROJECT.pages.dev" 101 "$(_ws_code "https://$PAGES_PROJECT.pages.dev")"
}

# The status a GET of URL ends at. Follows redirects: Pages may send viewer.html on to /viewer.
_http_code() { curl -sL -o /dev/null -w '%{http_code}' --max-time 15 "$1" || true; }

check_viewer() {
  echo "checking the Viewer page at $(viewer_url)"
  _check "the Viewer page answers 200" 200 "$(_http_code "$(viewer_url)")"
  _check "/version reports the page just uploaded" "$VIEWER_VERSION" \
    "$(_poll "$VIEWER_VERSION" _version_field "r.viewer.version ?? r.viewer.error")"
}

# What a release has to show once both halves are up: the Worker at $BASE_URL reports $VERSION,
# lists the Spacewalk tools, and its Room link is on the Viewer page and loads. open_viewer opens a
# Room, which expires unused after a day.
check_release() {
  local tools room_link page
  page="$(viewer_url)"
  echo "checking the release at $BASE_URL"
  _check "initialize reports $VERSION" "$VERSION" "$(_server_version)"
  tools="$(_mcp tools/list '{}' "r.tools.map((t)=>t.name).join(' ')")"
  _check "tools/list lists open_viewer and read_viewer_state" yes \
    "$([[ " $tools " == *" open_viewer "* && " $tools " == *" read_viewer_state "* ]] && echo yes || echo "${tools:-no tools}")"
  room_link="$(_mcp tools/call '{"name":"open_viewer","arguments":{}}' r.structuredContent.roomLink)"
  _check "the Room link is on $page" yes "$([[ "$room_link" == "$page?room="* ]] && echo yes || echo "${room_link:-no link}")"
  _check "the Room link loads" 200 "$([[ -n "$room_link" ]] && _http_code "$room_link" || echo "no link")"
}

# Run last: the deployment is in place by now, so this reports rather than undoes anything.
finish_checks() {
  (( CHECK_FAILURES == 0 )) && return 0
  echo "$CHECK_FAILURES check(s) failed: what was uploaded is live, but it is not working as it should" >&2
  return 1
}
