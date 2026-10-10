#!/usr/bin/env bash
# Browser slots: at most BROWSER_SLOTS (default 3) Chromium-driving runs at
# once on this box, shared by every worktree.
#
#   source scripts/lib/browser-slot.sh; browser_slot_acquire [timeout_s]   # holds fd 9
#   browser_slot_release
#   scripts/lib/browser-slot.sh <cmd...>    # run one command inside a slot
BROWSER_SLOTS="${BROWSER_SLOTS:-3}"
BROWSER_SLOT_PREFIX="${VERIFY_BROWSER_LOCK:-/tmp/md-review-viewshare-browser.lock}"
BROWSER_SLOT=""

browser_slot_acquire() {
  local deadline=$(( SECONDS + ${1:-3600} )) i
  while (( SECONDS < deadline )); do
    for (( i = 1; i <= BROWSER_SLOTS; i++ )); do
      exec 9>"$BROWSER_SLOT_PREFIX.$i"
      if flock -n 9; then BROWSER_SLOT=$i; return 0; fi
      exec 9>&-
    done
    sleep 2
  done
  return 1
}

browser_slot_release() { [[ -n "$BROWSER_SLOT" ]] && { flock -u 9; exec 9>&-; BROWSER_SLOT=""; }; return 0; }

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  (( $# )) || { echo "usage: $0 <cmd...>" >&2; exit 2; }
  browser_slot_acquire || { echo "no browser slot free" >&2; exit 1; }
  "$@"; rc=$?; browser_slot_release; exit $rc
fi
