#!/usr/bin/env bash
# Shared helpers for the revkit_run scripts. Sourced, not executed. Paths are relative to the repo root.
# shellcheck disable=SC2034  # variables are used by the sourcing scripts

run_dir="${REVKIT_RUN_DIR:-.revkit/run}"
mkdir -p "$run_dir"

log() { printf '%s %s: %s\n' "$(date -Is)" "${0##*/}" "$*" >>"$run_dir/run.log" 2>/dev/null || true; }

halted() { [[ -e "$run_dir/STOP" || -e "$run_dir/DONE" ]]; }

# Type one line into the pane. The lock keeps the watchdog and self-compact from interleaving keystrokes.
type_line() {
  local pane="$1" text="$2"
  (
    flock -w 60 9 || exit 1
    flk pane send-text "$pane" "$text" >/dev/null && flk pane send-keys "$pane" Enter >/dev/null
  ) 9>"$run_dir/type.lock" || { log "typing into $pane failed"; return 1; }
}
