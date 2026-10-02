#!/usr/bin/env bash
# Shared helpers for the revkit_run scripts. Sourced, not executed. Paths are relative to the repo root.
# shellcheck disable=SC2034  # variables are used by the sourcing scripts

run_dir="${REVKIT_RUN_DIR:-.revkit/run}"
mkdir -p "$run_dir"

log() { printf '%s %s: %s\n' "$(date -Is)" "${0##*/}" "$*" >>"$run_dir/run.log" 2>/dev/null || true; }

halted() { [[ -e "$run_dir/STOP" || -e "$run_dir/DONE" ]]; }

# Claude Code settles at "idle" while OpenCode settles at "done" after a turn.
# Both mean the pane can safely receive the next command.
is_quiescent() { [[ "$1" == "idle" || "$1" == "done" ]]; }

get_agent() {
  local pane="$1" timeout_secs="${2:-2}"
  timeout --signal=TERM "${timeout_secs}s" flk agent get "$pane" 2>/dev/null \
    | jq -ce '.result.agent // .result' 2>/dev/null
}

wait_quiescent() {
  local pane="$1" timeout_ms="$2" status deadline remaining call_timeout
  deadline=$((SECONDS + (timeout_ms + 999) / 1000))
  while ((SECONDS < deadline)); do
    halted && return 2
    remaining=$((deadline - SECONDS))
    call_timeout=$((remaining < 2 ? remaining : 2))
    status=$(get_agent "$pane" "$call_timeout" | jq -er '.agent_status' 2>/dev/null) \
      || { sleep 1; continue; }
    is_quiescent "$status" && return 0
    sleep 1
  done
  return 1
}

# Type one line into the pane. The lock keeps the watchdog and self-compact from interleaving keystrokes.
type_line() {
  local pane="$1" text="$2"
  (
    flock -w 60 9 || exit 1
    flk pane send-text "$pane" "$text" >/dev/null && flk pane send-keys "$pane" Enter >/dev/null
  ) 9>"$run_dir/type.lock" || { log "typing into $pane failed"; return 1; }
}
