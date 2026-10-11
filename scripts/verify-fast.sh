#!/usr/bin/env bash
# Full gate, faster: typecheck / unit / build / server run first (about 70 s
# on an idle box), then the e2e files run as N shards in parallel (each shard
# is its own scripts/verify.sh with its own throwaway backend, preview server
# and browser on free ports). The checks do not run alongside the shards: on a
# 4-CPU box the browsers starve them 10x, and the timing-bound unit/server
# tests (a vite build under a 240 s cap, a 50 ms parse budget) then fail.
#
#   scripts/verify-fast.sh [N]        N shards (default 4)
#
# Same pass/fail meaning as scripts/verify.sh; exit status is non-zero if any
# part failed. Per-part logs: .verify/runs/<run-id>/ (paths printed below).

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

N="${1:-4}"
[[ "$N" =~ ^[1-9][0-9]*$ ]] || { echo "usage: $0 [shards]" >&2; exit 2; }
STAMP="$(date +%Y%m%d-%H%M%S)-$$"
OUT="$ROOT/.verify/fast-$STAMP"
mkdir -p "$OUT"

# One browser per shard: this run owns the box, so lift the slot cap to N.
export BROWSER_SLOTS="$N"

pids=() names=()
run_part() { # name, then the command
  local name="$1"; shift
  ( VERIFY_RUN_ID="$STAMP-$name" "$@" >"$OUT/$name.log" 2>&1 ) &
  pids+=("$!"); names+=("$name")
}

t0=$SECONDS
run_part checks scripts/verify.sh --only typecheck,unit,build,server
wait "${pids[0]}"; checks_rc=$?
for ((i = 1; i <= N; i++)); do
  run_part "e2e-$i" env E2E_SHARD="$i/$N" scripts/verify.sh --only e2e
done

fail=0
for k in "${!pids[@]}"; do
  if (( k == 0 )); then rc=$checks_rc; else wait "${pids[$k]}"; rc=$?; fi
  if (( rc == 0 )); then st=PASS; else st=FAIL; fail=1; fi
  printf '%-8s %-4s %s\n' "${names[$k]}" "$st" "$(grep -E '^OVERALL' "$OUT/${names[$k]}.log" | tail -1)"
done

echo "------------------------------------------------------------------"
grep -hE '^(typecheck|unit|build|server|e2e) ' "$OUT"/*.log | sort -k1,1 | awk '{print}'
grep -hE ' FAIL ' "$OUT"/*.log | grep -v '^OVERALL' | sort -u
printf 'OVERALL: %s   wall %ss   logs: %s\n' "$([[ $fail == 0 ]] && echo PASS || echo FAIL)" "$((SECONDS - t0))" "${OUT#"$ROOT"/}"
exit "$fail"
