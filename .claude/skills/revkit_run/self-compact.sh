#!/usr/bin/env bash
# Self-compaction for an unattended revkit run inside a flock pane.
# Waits until the pane's Claude session is idle, types `/compact <focus>`,
# waits for the compaction to finish, then types the resume prompt so the
# loop continues from .revkit/run/HANDOFF.md. A .revkit/run/STOP file aborts.
#
# Usage: self-compact.sh <pane-id> <compact-focus> <resume-prompt>
set -euo pipefail

pane="${1:?pane id (e.g. from flk agent get \$FLOCK_PANE_ID)}"
focus="${2:?compact focus}"
resume="${3:?resume prompt}"
stop_file="${REVKIT_RUN_DIR:-.revkit/run}/STOP"
idle_timeout_ms="${REVKIT_IDLE_TIMEOUT_MS:-7200000}"
settle_seconds=5

wait_idle() {
  flk wait agent-status "$pane" --status idle --timeout "$idle_timeout_ms" >/dev/null
}

type_line() {
  flk pane send-text "$pane" "$1" >/dev/null
  flk pane send-keys "$pane" Enter >/dev/null
}

sleep "$settle_seconds"
wait_idle
[[ -e "$stop_file" ]] && exit 0
type_line "/compact $focus"
sleep "$settle_seconds"
wait_idle
[[ -e "$stop_file" ]] && exit 0
type_line "$resume"
