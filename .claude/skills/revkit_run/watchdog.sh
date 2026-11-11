#!/usr/bin/env bash
# Nudge a stalled revkit run: if the coordinator pane has been quiescent too long (a subagent hung, a notification was
# lost, a usage limit passed), type the resume prompt. Single instance per run dir; exits on STOP or DONE.
# Never exits on a transient flk/jq failure: that is the situation it exists to survive.
#
# Usage (from the repo root): watchdog.sh <pane-id> <resume-prompt>
set -uo pipefail
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "$0")/lib.sh"

pane="${1:?usage: watchdog.sh <pane-id> <resume-prompt>}"
resume="${2:?usage: watchdog.sh <pane-id> <resume-prompt>}"
idle_limit_secs="${REVKIT_IDLE_LIMIT_SECS:-2700}"
poll_secs="${REVKIT_POLL_SECS:-300}"

exec 8>"$run_dir/watchdog.lock"
flock -n 8 || { log "another watchdog is running; exiting"; exit 0; }
log "started for $pane"

while ! halted; do
  sleep "$poll_secs"
  halted && break
  agent=$(get_agent "$pane") || continue
  status=$(jq -r '.agent_status // empty' <<<"$agent")
  age=$(jq -r '.status_age_secs // 0 | floor' <<<"$agent" 2>/dev/null)
  [[ "$age" =~ ^[0-9]+$ ]] || continue
  if is_quiescent "$status" && [[ "$age" -ge "$idle_limit_secs" ]]; then
    halted && break
    type_line "$pane" "$resume" && log "nudged (quiescent ${age}s)"
  fi
done
log "exit (STOP or DONE)"
