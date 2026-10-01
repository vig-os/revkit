#!/usr/bin/env bash
set -euo pipefail

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/bin" "$root/run"

cat >"$root/bin/flk" <<'EOF'
#!/usr/bin/env bash
case "${FAKE_FLK_MODE:?}" in
  nested-done) printf '%s\n' '{"result":{"agent":{"agent_status":"done"}}}' ;;
  flat-idle) printf '%s\n' '{"result":{"agent_status":"idle"}}' ;;
  working) printf '%s\n' '{"result":{"agent":{"agent_status":"working"}}}' ;;
  fail) exit 1 ;;
  hang) sleep 10 ;;
  *) exit 64 ;;
esac
EOF
chmod +x "$root/bin/flk"

export PATH="$root/bin:$PATH"
export REVKIT_RUN_DIR="$root/run"
# shellcheck disable=SC1091
. "$(dirname "$0")/lib.sh"

fail() { printf 'test-lib: %s\n' "$*" >&2; exit 1; }

is_quiescent idle || fail "idle must be quiescent"
is_quiescent "done" || fail "done must be quiescent"
if is_quiescent working; then fail "working must not be quiescent"; fi

FAKE_FLK_MODE=nested-done wait_quiescent pane 1000 || fail "nested done response was rejected"
FAKE_FLK_MODE=flat-idle wait_quiescent pane 1000 || fail "flat idle response was rejected"

start=$SECONDS
set +e
FAKE_FLK_MODE=hang get_agent pane 1 >/dev/null
status=$?
set -e
elapsed=$((SECONDS - start))
[[ "$status" != 0 ]] || fail "hung agent lookup must fail"
((elapsed <= 2)) || fail "hung agent lookup exceeded timeout: ${elapsed}s"

touch "$REVKIT_RUN_DIR/STOP"
set +e
FAKE_FLK_MODE=working wait_quiescent pane 10000
status=$?
set -e
rm "$REVKIT_RUN_DIR/STOP"
[[ "$status" == 2 ]] || fail "STOP must interrupt polling with status 2, got $status"

start=$SECONDS
(sleep 1; touch "$REVKIT_RUN_DIR/STOP") &
stop_writer=$!
set +e
FAKE_FLK_MODE=hang wait_quiescent pane 10000
status=$?
set -e
wait "$stop_writer"
elapsed=$((SECONDS - start))
rm "$REVKIT_RUN_DIR/STOP"
[[ "$status" == 2 ]] || fail "STOP during a hung flk call must return status 2, got $status"
((elapsed <= 4)) || fail "STOP during a hung flk call took ${elapsed}s"

start=$SECONDS
set +e
FAKE_FLK_MODE=hang wait_quiescent pane 1000
status=$?
set -e
elapsed=$((SECONDS - start))
[[ "$status" == 1 ]] || fail "timeout must return status 1, got $status"
((elapsed <= 2)) || fail "hung flk exceeded timeout: ${elapsed}s"

printf '%s\n' "test-lib: passed"
