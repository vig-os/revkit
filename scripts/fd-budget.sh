#!/usr/bin/env bash
# Run a command, watch its peak open-file-descriptor count, and fail if
# the peak exceeds a budget. Issue #74.
#
# WHY THIS EXISTS, AND WHY IT IS A SEPARATE SCRIPT. Every `startDaemon`
# leaks 2 descriptors on `bun 1.3.13` (`fs.watch(...).close()` does not
# release the fd — see `packages/cli/test/serve/fd-budget.test.ts` for
# the measurement and the `node v24.21.0` cross-check that clears the
# kernel). Over a full `packages/cli` run the peak is 4449
# descriptors (at CI's `workers: 1` the Playwright leg peaks at 499; on an
# 88-core host its ~44 workers push it to 4683).
#
# GitHub-hosted runners cap the soft `nofile` limit at 1024, so the suite
# dies with `EMFILE` long before it finishes — and the crash names no cause.
#
# Two guards, deliberately: `justfile.project`'s `test` recipe raises
# `ulimit -n` so the run survives, and this script fails it LOUDLY if
# the peak ever exceeds the documented ceiling, so the next leak is a
# named failure instead of an `EMFILE`. The in-process
# `fd-budget.test.ts` catches the leak RATE (sensitive); this catches
# the absolute total (the true suite-wide number no in-process test can
# observe).
#
# Usage: scripts/fd-budget.sh --budget N -- cmd args...
# Exits with the command's own status unless the budget is exceeded,
# in which case it exits 1 after printing the observed peak.
#
# Linux-only (`/proc/<pid>/fd`): outside Linux the check is skipped
# with a notice and the command runs unwatched, rather than pretending
# to have measured something.

set -uo pipefail

budget=""
while [ $# -gt 0 ]; do
  case "$1" in
    --budget)
      budget="${2-}"
      shift 2 || true
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

if [ -z "$budget" ]; then
  printf 'fd-budget: usage: %s --budget N -- cmd args...\n' "$0" >&2
  exit 64
fi
case "$budget" in
  '' | *[!0-9]*) printf 'fd-budget: --budget must be a positive integer, got %s\n' "$budget" >&2; exit 64 ;;
esac
if [ "$budget" -lt 1 ]; then
  printf 'fd-budget: --budget must be >= 1, got %s\n' "$budget" >&2
  exit 64
fi
if [ $# -eq 0 ]; then
  printf 'fd-budget: no command given\n' >&2
  exit 64
fi
if [ "$(uname -s)" != "Linux" ]; then
  printf 'fd-budget: needs /proc (Linux only) — running without the fd check.\n' >&2
  exec "$@"
fi

samples=$(mktemp)
trap 'rm -f "$samples"' EXIT

"$@" &
child=$!

# Peak = descriptors held by the command AND every descendant.
#
# The tree walk is load-bearing, not decoration. `just test`'s Playwright
# leg runs `just e2e`, which spawns `bun run test:e2e`, which spawns a
# Playwright worker per file, which spawns a `revkit serve` daemon per
# spec — and it is those DAEMONS that leak. Measuring only the direct
# child reports the shell's ~5 descriptors and sees nothing at all.
#
# Descendants come from `/proc/<pid>/task/*/children` (procfs' own child
# list) rather than a scan over `/proc`, which would cost one readdir plus
# one stat per process on the box for every sample — on an 88-core dev
# host that is ~1200 processes, far too expensive at 20 samples/second.
fds_of_tree() {
  local total=0 pid kids kid d
  local -a queue=("$1") entries
  while [ ${#queue[@]} -gt 0 ]; do
    pid="${queue[0]}"
    queue=("${queue[@]:1}")
    d="/proc/$pid/fd"
    # A glob that matches nothing expands to the pattern itself, hence the
    # comparison rather than a count. Pure bash on purpose: this runs for
    # every pid in the tree 20 times a second, and a `ls | wc -l` fork per
    # pid is the difference between cheap and noticeable on a 44-worker box.
    entries=("$d"/*)
    if [ "${entries[0]}" != "$d/*" ]; then total=$((total + ${#entries[@]})); fi
    for kids in /proc/"$pid"/task/*/children; do
      [ -r "$kids" ] || continue
      # shellcheck disable=SC2013  # one line of SPACE-separated pids, not lines
      for kid in $(cat "$kids" 2>/dev/null); do
        queue+=("$kid")
      done
    done
  done
  printf '%s\n' "$total"
}

# Poll the process tree's /proc/<pid>/fd count. Started AFTER the child so
# the pid is known, and torn down by the parent below — a poller that
# waited on the child itself would spin forever on the zombie, since
# `kill -0` keeps succeeding until the child is reaped.
(
  while :; do
    fds_of_tree "$child" >>"$samples"
    sleep 0.05
  done
) &
poller=$!

wait "$child"
status=$?

kill "$poller" 2>/dev/null || true
wait "$poller" 2>/dev/null || true

peak=$(sort -n "$samples" 2>/dev/null | tail -1)
peak="${peak:-0}"
observed=$(wc -l <"$samples")

printf 'fd-budget: peak %s open fds (budget %s, %s samples at 50ms)\n' "$peak" "$budget" "$observed"
if [ "$observed" -eq 0 ]; then
  printf 'fd-budget: NOTE the command exited before one sample was taken, so this run was NOT measured.\n' >&2
fi

if [ "$status" -ne 0 ]; then
  exit "$status"
fi
if [ "$peak" -gt "$budget" ]; then
  cat >&2 <<EOF

fd-budget: FAILED — peak ${peak} descriptors exceeds the budget of ${budget}.

This is the descriptor leak from issue #74, and it is a BUG, not a
slow test. Each startDaemon/stop cycle leaks 2 on bun 1.3.13 (Bun's
fs.watch close() does not free the fd; node v24.21.0 does not leak).
Re-measure with:

  cd packages/cli && bun test test/serve/fd-budget.test.ts

If that per-cycle test still passes, the growth is coming from
somewhere else — report it with the peak above rather than raising
the budget.
EOF
  exit 1
fi
