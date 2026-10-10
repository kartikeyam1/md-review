#!/usr/bin/env bash
# Throwaway md-review stack: paste backend (server/server.cjs) + vite dev server,
# each on a free port, the backend on a fresh temp data dir. Never touches the
# live service (3100 / 3200) or its data dir.
#
# Two ways to use it:
#
#   1. Source it (scripts/verify.sh does):
#        source scripts/lib/stack.sh
#        stack_init                       # registers the cleanup trap
#        stack_start_backend e2e          # -> STACK_API_URL, STACK_DATA_DIR_e2e ...
#        stack_start_vite "$STACK_API_URL" # -> STACK_BASE_URL
#        ...
#        # stack_stop_all runs on EXIT/INT/TERM
#
#   2. Run a command against a fresh stack:
#        scripts/lib/stack.sh run -- node scripts/screens.mjs
#      The command sees E2E_BASE_URL / E2E_API_URL / E2E_DATA_DIR; the stack is
#      torn down when it exits, and its exit code is propagated.
#
# Env knobs:
#   STACK_LOG_DIR       where backend/vite logs go     (default <repo>/.verify/logs)
#   STACK_READY_TIMEOUT seconds to wait for readiness   (default 90)
#   STACK_KEEP_DATA=1   keep the temp data dirs on teardown (path is logged)

STACK_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STACK_LOG_DIR="${STACK_LOG_DIR:-$STACK_REPO_ROOT/.verify/logs}"
STACK_READY_TIMEOUT="${STACK_READY_TIMEOUT:-90}"
# Test stacks share a box with the live md-review service. Make everything
# started from here the OOM killer's first choice (inherited by children;
# raising the score needs no privileges), so memory pressure from a test run
# can never take the live backend down.
echo 1000 > /proc/self/oom_score_adj 2>/dev/null || true

STACK_PGIDS=()        # live process groups we started (setsid -> pid == pgid)
STACK_ALL_PGIDS=()    # every group ever started (for leak checks)
STACK_TMP_DIRS=()     # temp data dirs to remove on teardown
STACK_RESERVED_PORTS=" 3100 3200 58747 "

_stack_log() { printf '[stack] %s\n' "$*" >&2; }

# Print a free TCP port on 127.0.0.1, never one of the reserved ones.
stack_free_port() {
  local p
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    p="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
    case "$STACK_RESERVED_PORTS" in *" $p "*) continue ;; esac
    echo "$p"; return 0
  done
  return 1
}

# stack_wait_http <url> <pid> <label> — poll until any HTTP response, the
# process dies, or the timeout expires.
stack_wait_http() {
  local url="$1" pid="$2" label="$3" deadline=$((SECONDS + STACK_READY_TIMEOUT))
  while (( SECONDS < deadline )); do
    if ! kill -0 "$pid" 2>/dev/null; then
      _stack_log "$label exited before becoming ready"; return 1
    fi
    if curl -s -o /dev/null --max-time 2 "$url"; then return 0; fi
    sleep 0.3
  done
  _stack_log "$label not ready at $url after ${STACK_READY_TIMEOUT}s"; return 1
}

# stack_start_backend <name> [VAR=value ...]
# Starts server.cjs on a free port against a fresh temp DATA_DIR.
# Sets STACK_API_URL, STACK_API_PORT, STACK_DATA_DIR, STACK_BACKEND_PID and the
# per-name copies STACK_API_URL_<name> / STACK_DATA_DIR_<name>.
stack_start_backend() {
  local name="$1"; shift
  local port data log pid
  port="$(stack_free_port)" || { _stack_log "no free port"; return 1; }
  data="$(mktemp -d "${TMPDIR:-/tmp}/md-review-verify-${name}.XXXXXX")"
  STACK_TMP_DIRS+=("$data")
  mkdir -p "$STACK_LOG_DIR"
  log="$STACK_LOG_DIR/backend-${name}.log"
  # env -i keeps the live service's env (PORT, DATA_DIR, ...) from leaking in;
  # only PATH/HOME (gh auth token fallback) and explicit overrides pass through.
  setsid env -i PATH="$PATH" HOME="$HOME" ${GITHUB_TOKEN:+GITHUB_TOKEN="$GITHUB_TOKEN"} \
    PORT="$port" DATA_DIR="$data" "$@" \
    node "$STACK_REPO_ROOT/server/server.cjs" >"$log" 2>&1 < /dev/null &
  pid=$!
  STACK_PGIDS+=("$pid"); STACK_ALL_PGIDS+=("$pid")
  if ! stack_wait_http "http://127.0.0.1:$port/" "$pid" "backend[$name]"; then
    tail -20 "$log" >&2; return 1
  fi
  STACK_API_PORT="$port"
  STACK_API_URL="http://127.0.0.1:$port"
  STACK_DATA_DIR="$data"
  STACK_BACKEND_PID="$pid"
  printf -v "STACK_API_URL_${name//-/_}" '%s' "$STACK_API_URL"
  printf -v "STACK_DATA_DIR_${name//-/_}" '%s' "$data"
  _stack_log "backend[$name] $STACK_API_URL data=$data pid=$pid log=$log"
}

# stack_start_vite <api_url>
# Starts the vite dev server (needed for the ?filePath= loader) on a free port
# with VITE_PASTE_API_URL pointing at <api_url>. Sets STACK_BASE_URL,
# STACK_VITE_PORT, STACK_VITE_PID.
stack_start_vite() {
  local api="$1" port log pid
  port="$(stack_free_port)" || { _stack_log "no free port"; return 1; }
  mkdir -p "$STACK_LOG_DIR"
  log="$STACK_LOG_DIR/vite.log"
  (
    cd "$STACK_REPO_ROOT" || exit 1
    unset PORT
    # Per-worktree dep cache (see vite.config.ts cacheDir): node_modules is
    # shared between worktrees, its .vite/deps must not be.
    VITE_CACHE_DIR="$STACK_REPO_ROOT/.verify/vite-cache" \
    VITE_NO_WATCH=1 VITE_PASTE_API_URL="$api" exec setsid node node_modules/vite/bin/vite.js \
      --host 127.0.0.1 --port "$port" --strictPort --clearScreen false
  ) >"$log" 2>&1 < /dev/null &
  pid=$!
  STACK_PGIDS+=("$pid"); STACK_ALL_PGIDS+=("$pid")
  if ! stack_wait_http "http://127.0.0.1:$port/" "$pid" "vite"; then
    tail -20 "$log" >&2; return 1
  fi
  # Warm the module graph so the first test doesn't eat the dep-optimisation
  # cost (or its full-page reload).
  curl -s -o /dev/null --max-time 60 "http://127.0.0.1:$port/src/main.ts" || true
  STACK_VITE_PORT="$port"
  STACK_BASE_URL="http://127.0.0.1:$port"
  STACK_VITE_PID="$pid"
  _stack_log "vite $STACK_BASE_URL -> api $api pid=$pid log=$log"
}

# Kill every process group we started, then remove temp data dirs.
stack_stop_all() {
  local g
  for g in "${STACK_PGIDS[@]}"; do kill -TERM -- "-$g" 2>/dev/null; done
  for _ in $(seq 1 25); do
    local alive=0
    for g in "${STACK_PGIDS[@]}"; do kill -0 -- "-$g" 2>/dev/null && alive=1; done
    (( alive )) || break
    sleep 0.2
  done
  for g in "${STACK_PGIDS[@]}"; do kill -KILL -- "-$g" 2>/dev/null; done
  STACK_PGIDS=()
  if [[ "${STACK_KEEP_DATA:-0}" != 1 ]]; then
    local d
    for d in "${STACK_TMP_DIRS[@]}"; do [[ -n "$d" && -d "$d" ]] && rm -rf -- "$d"; done
  else
    _stack_log "kept data dirs: ${STACK_TMP_DIRS[*]}"
  fi
  STACK_TMP_DIRS=()
}

# Number of process groups ever started that are still alive.
stack_leaked_count() {
  local g n=0
  for g in "${STACK_ALL_PGIDS[@]}"; do kill -0 -- "-$g" 2>/dev/null && n=$((n + 1)); done
  echo "$n"
}

stack_init() { trap 'stack_stop_all' EXIT; trap 'exit 130' INT; trap 'exit 143' TERM; }

# ── CLI mode ────────────────────────────────────────────────────────────────
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -uo pipefail
  if [[ "${1:-}" != run ]]; then
    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 2
  fi
  shift; [[ "${1:-}" == -- ]] && shift
  (( $# )) || { echo "usage: $0 run -- <command...>" >&2; exit 2; }
  stack_init
  stack_start_backend app || exit 1
  stack_start_vite "$STACK_API_URL" || exit 1
  E2E_BASE_URL="$STACK_BASE_URL" E2E_API_URL="$STACK_API_URL" E2E_DATA_DIR="$STACK_DATA_DIR" "$@"
  exit $?
fi
