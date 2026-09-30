#!/usr/bin/env bash
# Nudge a stalled revkit run: if the coordinator pane has been idle for too long (a subagent hung, a notification was
# lost, a usage limit passed), type the resume prompt. Exits on .revkit/run/STOP or .revkit/run/DONE.
set -euo pipefail

pane="${1:?usage: watchdog.sh <pane-id> <resume-prompt>}"
resume="${2:?usage: watchdog.sh <pane-id> <resume-prompt>}"
run_dir="${REVKIT_RUN_DIR:-.revkit/run}"
idle_limit_secs="${REVKIT_IDLE_LIMIT_SECS:-2700}"
poll_secs="${REVKIT_POLL_SECS:-300}"
log="$run_dir/watchdog.log"

while [[ ! -e "$run_dir/STOP" && ! -e "$run_dir/DONE" ]]; do
  sleep "$poll_secs"
  agent=$(flk agent get "$pane" 2>/dev/null | jq -c '.result.agent // .result') || continue
  status=$(jq -r '.agent_status // empty' <<<"$agent")
  age=$(jq -r '.status_age_secs // 0' <<<"$agent")
  if [[ "$status" == idle && "$age" -ge "$idle_limit_secs" ]]; then
    printf '%s nudge (idle %ss)\n' "$(date -Is)" "$age" >>"$log"
    flk pane send-text "$pane" "$resume" >/dev/null
    flk pane send-keys "$pane" Enter >/dev/null
  fi
done
printf '%s watchdog exit\n' "$(date -Is)" >>"$log"
