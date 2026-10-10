#!/usr/bin/env bash
# The single verification gate for md-review.
#
#   scripts/verify.sh [--fail-fast] [--only STEPS] [--help]
#
# Steps (default: all, run-all-and-report):
#   typecheck  vue-tsc -b --noEmit
#   unit       vitest run
#   build      vite build (into .verify/runs/<id>/dist, the repo's dist/ is
#              left alone; removed when the run ends), then check:lazy-editor
#              on it (#6)
#   e2e        throwaway backend + the app on free ports, then every
#              tests/e2e/*.test.mjs and tests/e2e/items/*.test.mjs serially,
#              one node --test run per file, under the shared browser lock.
#              The app is the build step's output served by `vite preview`
#              (built here if the build step didn't run); STACK_MODE=dev
#              uses the vite dev server instead
#   server     a second throwaway backend (REVISIONS_MAX=5, so the retention
#              test runs), then server/test*.mjs and
#              server/test-items/*.test.mjs against it
#
# Env:
#   VERIFY_ONLY=unit,e2e     same as --only
#   VERIFY_FAIL_FAST=1       same as --fail-fast (skip the rest after a failure)
#   E2E_FILES="app,shared-mode"   subset of e2e files (basename, name.test.mjs
#                            or a path; comma or space separated)
#   VERIFY_E2E_FILE_TIMEOUT  seconds per e2e file before it is killed (900)
#   VERIFY_BROWSER_LOCK      browser slot lock prefix (/tmp/md-review-viewshare-browser.lock)
#   BROWSER_SLOTS            concurrent browser runs allowed across worktrees (3)
#   STACK_MODE=dev           e2e against the vite dev server, not the build
#   VERIFY_KEEP_DIST=1       keep the run's build (.verify/runs/<id>/dist)
#   E2E_DEV_FILES="06-lazy-editor"  e2e files written against the dev server's
#                            per-module URLs; they get a vite dev server (same
#                            backend) even in prod mode, started only if one runs
#   VERIFY_ITEMS=04,02       backlog items whose acceptance tests run in addition
#                            to the landed ones listed in docs/build/LANDED.
#                            Item tests are files named NN-*.test.* under
#                            tests/items, tests/e2e/items, server/test-items;
#                            tests of items not yet built are written ahead of
#                            time and stay out of the gate until enabled here.
#                            An explicit E2E_FILES list is never filtered.
#
# Output: per-step logs in .verify/runs/<id>/logs/ (.verify/logs -> latest), summary table on stdout and in
# .verify/last-summary.txt. Exit status is non-zero if any step failed.
# The live service (ports 3100/3200, server/data) is never touched.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2
VERIFY_DIR="$ROOT/.verify"
# Each run logs into its own directory so concurrent runs in one worktree
# never delete each other's logs; .verify/logs points at the latest run.
VERIFY_RUN_ID="${VERIFY_RUN_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
RUN_DIR="$VERIFY_DIR/runs/$VERIFY_RUN_ID"
LOG_DIR="$RUN_DIR/logs"
# Per run, like the logs: a concurrent run's --emptyOutDir must never pull the
# files out from under this run's e2e server.
DIST_DIR="$RUN_DIR/dist"
export STACK_LOG_DIR="$LOG_DIR"
# shellcheck source=lib/stack.sh
source "$ROOT/scripts/lib/stack.sh"
# shellcheck source=lib/browser-slot.sh
source "$ROOT/scripts/lib/browser-slot.sh"

ALL_STEPS=(typecheck unit build e2e server)
FAIL_FAST="${VERIFY_FAIL_FAST:-0}"
ONLY="${VERIFY_ONLY:-}"
LOCK="${VERIFY_BROWSER_LOCK:-/tmp/md-review-viewshare-browser.lock}"
E2E_FILE_TIMEOUT="${VERIFY_E2E_FILE_TIMEOUT:-900}"
# 06-lazy-editor asserts on dev module URLs (/src/components/EditorPane.vue,
# ?type=style, /node_modules/.vite/deps/...) and blocks them by those URLs;
# its build-mode twin is 06-lazy-editor-build.
E2E_DEV_FILES="${E2E_DEV_FILES-06-lazy-editor}"

usage() { sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; }
while (( $# )); do
  case "$1" in
    --fail-fast) FAIL_FAST=1 ;;
    --only) ONLY="${2:?--only needs a value}"; shift ;;
    --only=*) ONLY="${1#--only=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

SELECTED=()
if [[ -n "$ONLY" ]]; then
  for s in ${ONLY//,/ }; do
    [[ " ${ALL_STEPS[*]} " == *" $s "* ]] || { echo "unknown step '$s' (have: ${ALL_STEPS[*]})" >&2; exit 2; }
    SELECTED+=("$s")
  done
else
  SELECTED=("${ALL_STEPS[@]}")
fi
selected() { [[ " ${SELECTED[*]} " == *" $1 "* ]]; }

mkdir -p "$LOG_DIR"; ln -sfn "runs/$VERIFY_RUN_ID/logs" "$VERIFY_DIR/logs.tmp" && mv -Tf "$VERIFY_DIR/logs.tmp" "$VERIFY_DIR/logs" 2>/dev/null || true
export NO_COLOR=1 FORCE_COLOR=0 CI="${CI:-1}"
# #23: MCP servers/handlers that tests start keep their edit-token store here, never in
# the repo default (server/mcp-state/). Suites that need their own store override it.
export MCP_TOKEN_STORE="${MCP_TOKEN_STORE:-$RUN_DIR/mcp-state/edit-tokens.json}"

# ── backlog item gating ─────────────────────────────────────────────────────
ENABLED_ITEMS=" "
if [[ -f "$ROOT/docs/build/LANDED" ]]; then
  while read -r n _; do [[ "$n" =~ ^[0-9]+$ ]] && ENABLED_ITEMS+="$(printf '%02d' "$((10#$n))") "; done < "$ROOT/docs/build/LANDED"
fi
VERIFY_ITEMS="${VERIFY_ITEMS:-}"; for n in ${VERIFY_ITEMS//,/ }; do n="${n//,/}"; [[ -z "$n" ]] && continue; [[ "$n" =~ ^[0-9]+$ ]] && ENABLED_ITEMS+="$(printf '%02d' "$((10#$n))") "; done
item_enabled() { # path -> 0 if not an item test, or its item is enabled
  local b; b="$(basename "$1")"
  [[ "$b" =~ ^([0-9][0-9])- ]] || return 0
  [[ "$ENABLED_ITEMS" == *" ${BASH_REMATCH[1]} "* ]]
}

# ── result bookkeeping ──────────────────────────────────────────────────────
R_NAME=(); R_STATUS=(); R_COUNTS=(); R_DUR=()
ANY_FAIL=0
record() { # name status counts seconds
  R_NAME+=("$1"); R_STATUS+=("$2"); R_COUNTS+=("$3"); R_DUR+=("$4")
  [[ "$2" == FAIL ]] && ANY_FAIL=1
  printf '[verify] %-40s %-4s %s (%ss)\n' "$1" "$2" "$3" "$4" >&2
}
now() { echo "$EPOCHREALTIME"; }
elapsed() { awk -v a="$1" -v b="$(now)" 'BEGIN{printf "%.1f", b-a}'; }
stop_now() { (( FAIL_FAST )) && (( ANY_FAIL )); }

# node:test summary → sets T_TESTS T_PASS T_FAIL T_SKIP and T_COUNTS (call
# directly, not in $(...), so the variables survive)
node_counts() {
  local log="$1"
  T_TESTS=$(grep -aE '^[#ℹ] tests [0-9]+' "$log" | tail -1 | grep -oE '[0-9]+$'); T_TESTS=${T_TESTS:-0}
  T_PASS=$(grep -aE '^[#ℹ] pass [0-9]+' "$log" | tail -1 | grep -oE '[0-9]+$'); T_PASS=${T_PASS:-0}
  T_FAIL=$(grep -aE '^[#ℹ] fail [0-9]+' "$log" | tail -1 | grep -oE '[0-9]+$'); T_FAIL=${T_FAIL:-0}
  T_SKIP=$(grep -aE '^[#ℹ] skipped [0-9]+' "$log" | tail -1 | grep -oE '[0-9]+$'); T_SKIP=${T_SKIP:-0}
  local c; c=$(grep -aE '^[#ℹ] cancelled [0-9]+' "$log" | tail -1 | grep -oE '[0-9]+$'); c=${c:-0}
  T_FAIL=$((T_FAIL + c))
  T_COUNTS="$T_PASS/$T_TESTS pass, $T_FAIL fail, $T_SKIP skip"
}

skip_rest_from() { # mark remaining selected steps as SKIP
  local hit=0 s
  for s in "${ALL_STEPS[@]}"; do
    [[ "$s" == "$1" ]] && hit=1
    (( hit )) && selected "$s" && record "$s" SKIP "fail-fast" 0
  done
}

# ── steps ───────────────────────────────────────────────────────────────────
step_typecheck() {
  local t0 log="$LOG_DIR/typecheck.log" rc n
  t0=$(now)
  node_modules/.bin/vue-tsc -b --noEmit >"$log" 2>&1; rc=$?
  n=$(grep -c 'error TS' "$log")
  record typecheck "$([[ $rc == 0 ]] && echo PASS || echo FAIL)" "$n errors" "$(elapsed "$t0")"
}

step_unit() {
  local t0 log="$LOG_DIR/unit.log" rc line counts
  t0=$(now)
  local excl=() f
  for f in tests/items/*.test.ts; do [[ -f "$f" ]] && ! item_enabled "$f" && excl+=(--exclude "$f"); done
  node_modules/.bin/vitest run "${excl[@]}" >"$log" 2>&1; rc=$?
  line=$(grep -aE '^ +Tests +' "$log" | tail -1 | sed -E 's/^ +Tests +//')
  counts="${line:-no summary}"
  record unit "$([[ $rc == 0 ]] && echo PASS || echo FAIL)" "$counts" "$(elapsed "$t0")"
}

step_build() {
  local t0 log="$LOG_DIR/build.log" rc
  t0=$(now)
  node_modules/.bin/vite build --outDir "$DIST_DIR" --emptyOutDir >"$log" 2>&1; rc=$?
  # #6: CodeMirror must stay out of the entry graph (npm run check:lazy-editor).
  if [[ $rc == 0 ]]; then
    node scripts/check-lazy-editor.mjs --dist "$DIST_DIR" >>"$log" 2>&1; rc=$?
  fi
  # A failed build must not be served to e2e (stack_start_preview rebuilds).
  [[ $rc == 0 ]] || rm -f "$DIST_DIR/index.html"
  local n; n=$(find "$DIST_DIR/assets" -name '*.js' 2>/dev/null | wc -l)
  record build "$([[ $rc == 0 ]] && echo PASS || echo FAIL)" "$n js chunks" "$(elapsed "$t0")"
}

resolve_e2e_files() {
  E2E_LIST=()
  if [[ -z "${E2E_FILES:-}" ]]; then
    E2E_LIST=(tests/e2e/*.test.mjs)
    local item; for item in tests/e2e/items/*.test.mjs; do [[ -f "$item" ]] && item_enabled "$item" && E2E_LIST+=("$item"); done
    return 0
  fi
  local x
  for x in ${E2E_FILES//,/ }; do
    if [[ -f "$x" ]]; then E2E_LIST+=("$x")
    elif [[ -f "tests/e2e/$x" ]]; then E2E_LIST+=("tests/e2e/$x")
    elif [[ -f "tests/e2e/$x.test.mjs" ]]; then E2E_LIST+=("tests/e2e/$x.test.mjs")
    elif [[ -f "tests/e2e/items/$x.test.mjs" ]]; then E2E_LIST+=("tests/e2e/items/$x.test.mjs")
    else echo "unknown e2e file: $x" >&2; return 1
    fi
  done
}

step_e2e() {
  local t0 t1 rc f name log counts
  local sum_t=0 sum_p=0 sum_f=0 sum_s=0 status=PASS
  t0=$(now)
  if ! resolve_e2e_files; then record e2e FAIL "bad E2E_FILES" "$(elapsed "$t0")"; return; fi

  t1=$(now)
  if ! { stack_start_backend e2e && stack_start_app "$STACK_API_URL" "$DIST_DIR"; } 2>>"$LOG_DIR/stack.log"; then
    record "e2e:stack" FAIL "startup failed (see logs/stack.log)" "$(elapsed "$t1")"
    record e2e FAIL "not run" "$(elapsed "$t0")"
    stack_stop_all; return
  fi
  record "e2e:stack" PASS "api :$STACK_API_PORT  app :$STACK_VITE_PORT ($STACK_MODE)" "$(elapsed "$t1")"
  local api="$STACK_API_URL" base="$STACK_BASE_URL" data="$STACK_DATA_DIR"
  local dev_base="" fbase fmode

  t1=$(now)
  if ! browser_slot_acquire 3600; then
    record "e2e:lock" FAIL "no browser slot free (${BROWSER_SLOTS} slots)" "$(elapsed "$t1")"
    record e2e FAIL "not run" "$(elapsed "$t0")"; stack_stop_all; return
  fi
  record "e2e:lock" PASS "browser slot $BROWSER_SLOT/$BROWSER_SLOTS" "$(elapsed "$t1")"

  for f in "${E2E_LIST[@]}"; do
    name="$(basename "$f" .test.mjs)"
    log="$LOG_DIR/e2e-$name.log"
    t1=$(now)
    fbase="$base"; fmode="$STACK_MODE"
    if [[ "$STACK_MODE" != dev && " ${E2E_DEV_FILES//,/ } " == *" $name "* ]]; then
      if [[ -z "$dev_base" ]]; then
        if stack_start_vite "$api" 2>>"$LOG_DIR/stack.log"; then dev_base="$STACK_BASE_URL"
        else record "e2e/$name" FAIL "dev server startup failed (see logs/stack.log)" "$(elapsed "$t1")"; status=FAIL; continue
        fi
      fi
      fbase="$dev_base"; fmode=dev
    fi
    E2E_BASE_URL="$fbase" E2E_API_URL="$api" E2E_DATA_DIR="$data" E2E_STACK_MODE="$fmode" MDR_BROWSER_LOCK_HELD=1 \
      timeout --kill-after=10 "$E2E_FILE_TIMEOUT" \
      node --test --test-concurrency=1 --test-reporter=spec "$f" >"$log" 2>&1; rc=$?
    node_counts "$log"; counts="$T_COUNTS"
    (( rc == 124 || rc == 137 )) && counts="$counts, TIMEOUT"
    [[ "$fmode" != "$STACK_MODE" ]] && counts="$counts ($fmode)"
    record "e2e/$name" "$([[ $rc == 0 ]] && echo PASS || echo FAIL)" "$counts" "$(elapsed "$t1")"
    [[ $rc == 0 ]] || status=FAIL
    sum_t=$((sum_t + T_TESTS)); sum_p=$((sum_p + T_PASS)); sum_f=$((sum_f + T_FAIL)); sum_s=$((sum_s + T_SKIP))
    if (( FAIL_FAST )) && [[ $status == FAIL ]]; then break; fi
  done
  browser_slot_release
  stack_stop_all
  record e2e "$status" "$sum_p/$sum_t pass, $sum_f fail, $sum_s skip (${#E2E_LIST[@]} files)" "$(elapsed "$t0")"
}

step_server() {
  local t0 t1 rc f name log status=PASS
  local sum_t=0 sum_p=0 sum_f=0 sum_s=0
  t0=$(now)
  if ! stack_start_backend server REVISIONS_MAX=5 2>>"$LOG_DIR/stack.log"; then
    record server FAIL "backend startup failed" "$(elapsed "$t0")"; stack_stop_all; return
  fi
  for f in server/test*.mjs server/test-items/*.test.mjs; do
    [[ -f "$f" ]] || continue
    item_enabled "$f" || continue
    name="$(basename "$f" .mjs)"
    log="$LOG_DIR/server-$name.log"
    t1=$(now)
    PASTE_API="$STACK_API_URL" E2E_API_URL="$STACK_API_URL" DATA_DIR="$STACK_DATA_DIR" REVISIONS_MAX=5 \
      timeout --kill-after=10 600 \
      node --test --test-concurrency=1 --test-reporter=spec "$f" >"$log" 2>&1; rc=$?
    node_counts "$log"
    record "server/$name" "$([[ $rc == 0 ]] && echo PASS || echo FAIL)" "$T_COUNTS" "$(elapsed "$t1")"
    [[ $rc == 0 ]] || status=FAIL
    sum_t=$((sum_t + T_TESTS)); sum_p=$((sum_p + T_PASS)); sum_f=$((sum_f + T_FAIL)); sum_s=$((sum_s + T_SKIP))
  done
  stack_stop_all
  record server "$status" "$sum_p/$sum_t pass, $sum_f fail, $sum_s skip" "$(elapsed "$t0")"
}

# ── run ─────────────────────────────────────────────────────────────────────
stack_init
T_START=$(now)
for s in "${ALL_STEPS[@]}"; do
  selected "$s" || continue
  if stop_now; then skip_rest_from "$s"; break; fi
  "step_$s"
done

# Teardown check: nothing we started may survive.
stack_stop_all
[[ "${VERIFY_KEEP_DIST:-0}" == 1 ]] || rm -rf -- "$DIST_DIR"
LEFT=$(stack_leaked_count)
record teardown "$([[ $LEFT == 0 ]] && echo PASS || echo FAIL)" "$LEFT stray processes" 0

# ── summary ─────────────────────────────────────────────────────────────────
TOTAL=$(elapsed "$T_START")
{
  printf 'md-review verify  %s  (%s @ %s)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" "$(git rev-parse --short HEAD 2>/dev/null)$(git diff --quiet 2>/dev/null || echo '+dirty')"
  printf '%-34s %-6s %-46s %8s\n' STEP RESULT COUNTS SECONDS
  printf '%-34s %-6s %-46s %8s\n' "$(printf '%.0s-' {1..34})" ------ "$(printf '%.0s-' {1..46})" --------
  for i in "${!R_NAME[@]}"; do
    printf '%-34s %-6s %-46s %8s\n' "${R_NAME[$i]}" "${R_STATUS[$i]}" "${R_COUNTS[$i]}" "${R_DUR[$i]}"
  done
  printf '%s\n' "$(printf '%.0s-' {1..97})"
  printf 'OVERALL: %s   total %ss   logs: %s\n' "$([[ $ANY_FAIL == 0 ]] && echo PASS || echo FAIL)" "$TOTAL" "${LOG_DIR#"$ROOT"/}/"
} | tee "$RUN_DIR/summary.txt" "$VERIFY_DIR/last-summary.txt"

exit "$ANY_FAIL"
