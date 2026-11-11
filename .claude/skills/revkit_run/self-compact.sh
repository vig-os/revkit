#!/usr/bin/env bash
# Self-compaction for an unattended revkit run inside a flock pane.
# Waits until the pane's agent session is quiescent, types `/compact <focus>`,
# waits for the compaction to finish, then types the resume prompt so the
# loop continues from .revkit/run/HANDOFF.md. STOP or DONE in .revkit/run aborts.
#
# Usage (from the repo root): self-compact.sh <pane-id> <compact-focus> <resume-prompt>
set -uo pipefail
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "$0")/lib.sh"

pane="${1:?pane id (e.g. from flk agent get \$FLOCK_PANE_ID)}"
focus="${2:?compact focus}"
resume="${3:?resume prompt}"
idle_timeout_ms="${REVKIT_IDLE_TIMEOUT_MS:-7200000}"
settle_seconds=5

wait_idle() {
  wait_quiescent "$pane" "$idle_timeout_ms"
  case "$?" in
    0) ;;
    2) log "halted while waiting for pane $pane"; exit 0 ;;
    *) log "pane $pane not quiescent within ${idle_timeout_ms}ms; giving up (the watchdog will nudge)"; exit 1 ;;
  esac
}

sleep "$settle_seconds"; wait_idle
halted && { log "halted before compact"; exit 0; }
type_line "$pane" "/compact $focus" || exit 1
log "typed /compact"
sleep "$settle_seconds"; wait_idle
halted && { log "halted before resume"; exit 0; }
type_line "$pane" "$resume" || exit 1
log "typed resume prompt"
