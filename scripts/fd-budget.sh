#!/usr/bin/env bash
# Run a command, watch its open-file-descriptor count, and fail if either the
# absolute peak or the post-warm-up GROWTH exceeds a budget. Issue #74.
#
# WHY THIS EXISTS, AND WHY IT IS A SEPARATE SCRIPT. Every `startDaemon`
# leaks 2 descriptors on `bun 1.3.13` (`fs.watch(...).close()` does not
# release the fd — see `packages/cli/test/serve/fd-budget.test.ts` for
# the measurement and the `node v24.21.0` cross-check that clears the
# kernel). Over a full `packages/cli` run the peak is 4449 local / 4683 on
# CI. At CI's `workers: 1` the Playwright leg peaks at 499 local / 509 CI;
# across ~44 workers on an 88-core host it reaches 4683-6481.
#
# The soft `nofile` limit is the constraint, and where it is low the suite
# dies with `EMFILE` long before it finishes, with a crash that names no
# cause. Measured scope, stated precisely because it is narrower than it
# first looked: CI's runner already defaults to 65536 — exactly the value
# `justfile.project` sets, so the `ulimit -S` there is a no-op on CI — and
# it cannot help at all when the hard limit is also low (with
# `prlimit --nofile=1024:1024` the raise is refused, the recipe warns, and
# the suite would still die). It only rescues soft-low/hard-high.
#
# TWO BUDGETS, and why one is not enough.
#
#   --budget N        absolute peak. A runaway backstop.
#   --delta-budget N  growth after a warm-up. The one that can SEE the leak.
#
# The `packages/cli` leg breaks down as ~3384 fixed plus ~1065 of leak, and
# the fixed part is a module-load cost rather than a leak. Three separate
# measurements were previously conflated into one number here, so each is
# labelled with what it actually is:
#
#   52      a bare `bun test` file importing only `node:fs`.
#   3268    a minimal probe whose only project import is `serve/daemon.ts`.
#   ~3384   the real leg's post-warm-up FLOOR (4449 peak minus 1065 measured
#           growth). 3403 on CI (4687 minus 1284, run 37117007176).
#
# Only the third is the baseline growth is measured from, so the arithmetic
# uses it: the first DOUBLING of the leak lands at ~3384 + 2130 = ~5514,
# comfortably UNDER any absolute ceiling loose enough not to false-positive
# on a big workstation. An absolute ceiling alone is therefore blind to
# precisely the regression it was added for.
#
# Measuring growth after a warm-up drops the constant term, which is what
# makes a doubling visible. The warm-up is discarded rather than the first
# sample, because the first samples race the module graph being loaded.
#
# The in-process `fd-budget.test.ts` catches the leak RATE with far better
# resolution (it sees a single daemon lifecycle). This script's job is the
# cross-process total and the growth, which no in-process test can observe.
#
# Usage: scripts/fd-budget.sh --budget N [--delta-budget N] -- cmd args...
# Exits with the command's own status if it failed, else 1 if a budget was
# exceeded or the run could not be measured.
#
# Linux-only (`/proc/<pid>/fd`): outside Linux the check is skipped with a
# notice and the command runs unwatched, rather than pretending to have
# measured something.

set -uo pipefail

budget=""
delta_budget=""
while [ $# -gt 0 ]; do
  case "$1" in
    --budget)
      budget="${2-}"
      shift 2 || true
      ;;
    --delta-budget)
      delta_budget="${2-}"
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
  printf 'fd-budget: usage: %s --budget N [--delta-budget N] -- cmd args...\n' "$0" >&2
  exit 64
fi
for pair in "budget:$budget" "delta-budget:$delta_budget"; do
  name="${pair%%:*}"
  value="${pair#*:}"
  # `--delta-budget` is optional, so an absent one is not a bad value.
  if [ "$name" = "delta-budget" ] && [ -z "$value" ]; then continue; fi
  case "$value" in
    '' | *[!0-9]*)
      printf 'fd-budget: --%s must be a positive integer, got %s\n' "$name" "$value" >&2
      exit 64
      ;;
  esac
  if [ "$value" -lt 1 ]; then
    printf 'fd-budget: --%s must be >= 1, got %s\n' "$name" "$value" >&2
    exit 64
  fi
done
if [ $# -eq 0 ]; then
  printf 'fd-budget: no command given\n' >&2
  exit 64
fi
if [ "$(uname -s)" != "Linux" ]; then
  printf 'fd-budget: needs /proc (Linux only) — running without the fd check.\n' >&2
  exec "$@"
fi

samples=$(mktemp)
raw=$(mktemp)
trap 'rm -f "$samples" "$raw"' EXIT

"$@" &
child=$!
started=$SECONDS

# Descriptors held by the command AND every descendant.
#
# The tree walk is load-bearing, not decoration. `just test`'s Playwright
# leg runs `just e2e`, which spawns `bun run test:e2e`, which spawns a
# Playwright worker per file, which spawns a `revkit serve` daemon per
# spec — and it is those DAEMONS that leak. Measuring only the direct
# child reports the shell's ~3 descriptors and sees nothing at all.
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
    # every pid in the tree many times a second, and a `ls | wc -l` fork per
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

# Interval the poller sleeps between samples. It is a TARGET, not a claim,
# and the achieved figure is several times larger than it on a real leg:
# each iteration is one whole-tree walk plus one `sleep`, and the walk gets
# more expensive as the tree widens. Measured on the real `packages/cli` leg
# (446 polls over 100.5s): mean 226ms, median 165ms, p90 358ms. On CI that
# leg manages 959 polls over its ~131s, about 137ms. A trivial `sleep`
# command polls at ~55ms, which is where an earlier version of this comment
# got its number — it described nothing that runs in CI. The broad-tree
# Playwright leg is slower still. Reported as a "target" below so the log
# does not assert a precision the tool does not have.
poll_interval="0.05"

# The warm-up is WALL CLOCK, not a sample count, and that distinction is the
# whole ballgame. The module-load ramp is a fixed DURATION, so a
# sample-count warm-up is wrong twice over. Too short and the ramp is
# counted as leak, which fires the growth budget on a healthy run (a filtered
# `bun test` measured 2974 of "growth" that was entirely module load). Too
# long and a short leg is left unmeasured — and a count is not even stable,
# since the achieved interval above varies 165-358ms on one leg.
#
# MEASURED, stamped per sample on the real cli leg: the count reaches 3374 at
# t+0.93s (3377, 3377, 3384, 3391, 3417, 3425 after that) and stays within
# 1% of its plateau from t+1.1s onward. So the ramp is ~1s of WALL CLOCK,
# and the earlier "flat by sample 20" was a sample index being read as a
# duration — at 165ms that index would be 3.3s, which is how this came to be
# flagged for review.
#
# Two seconds therefore clears the ~1s ramp with ~1s of margin, which is
# why the warm-up stays at 2 and is NOT moved. Raising it would shrink the
# sample count on short legs for no measured gain: on this leg the baseline
# is already settled to within ~50 descriptors by 2s, ~5% of the 1065 of
# growth being measured.
#
# Every positive sample goes to `raw` (so "did we ever poll?" stays
# answerable) and only post-warm-up ones go to `samples` (so growth is
# measured). That distinction is what lets a leg too SHORT to measure be
# reported honestly instead of either faking a number or failing.
warmup_seconds=2

# Poll the process tree's fd count. Started AFTER the child so the pid is
# known, and torn down by the parent below — a poller that waited on the
# child itself would spin forever on the zombie, since `kill -0` keeps
# succeeding until the child is reaped.
#
# Two conditions in this loop are load-bearing:
#
#   [ -d "/proc/$child" ]  stop at exit. Without it the poller keeps
#                          sampling a pid that no longer exists.
#   [ "$n" -gt 0 ]          drop zeros. A live process always holds at
#                          least fds 0/1/2, so a zero means "gone", and
#                          letting one through poisons the MINIMUM that
#                          growth is measured from: trailing zeros made
#                          growth collapse onto the peak, silently
#                          reducing the growth budget to a second copy of
#                          the absolute ceiling.
(
  while [ -d "/proc/$child" ]; do
    n=$(fds_of_tree "$child")
    if [ "$n" -gt 0 ]; then
      printf '%s\n' "$n" >>"$raw"
      if [ $((SECONDS - started)) -ge "$warmup_seconds" ]; then
        printf '%s\n' "$n" >>"$samples"
      fi
    fi
    sleep "$poll_interval"
  done
) &
poller=$!

wait "$child"
status=$?

kill "$poller" 2>/dev/null || true
wait "$poller" 2>/dev/null || true

# Growth across the post-warm-up samples: highest minus lowest.
polls=$(wc -l <"$raw")
observed=$(wc -l <"$samples")
peak=$(sort -n "$raw" 2>/dev/null | tail -1)
peak="${peak:-0}"

if [ "$observed" -gt 1 ]; then
  delta=$(sort -n "$samples" | awk '
    NR == 1 { lo = $1 }
    { hi = $1 }
    END { print hi - lo }
  ')
else
  # The leg finished inside the warm-up window. That is a real "not
  # measurable", not a pass and not a failure: the absolute ceiling above
  # still applied to every sample in `raw`.
  delta="unmeasured"
fi

# Cleanup of `$samples` and `$raw` is left to the EXIT trap. Doing it by hand
# here would mean clearing the trap too (so the second file survives), or
# removing one and leaving the other to a trap that a later `exit` may or may
# not reach.
if [ "$polls" -eq 0 ]; then
  printf 'fd-budget: FAILED — no samples were taken, so this run was NOT measured.\n' >&2
  printf 'fd-budget: the command exited before the first poll completed, and reporting "peak 0" would be a\n' >&2
  printf 'fd-budget: silent pass, so this is an error rather than a success.\n' >&2
  [ "$status" -ne 0 ] && exit "$status"
  exit 1
fi

printf 'fd-budget: peak %s open fds (ceiling %s); growth over %s post-warm-up samples: %s (budget %s); %s polls, %ss warm-up, target %ss interval\n' \
  "$peak" "$budget" "$observed" "$delta" "${delta_budget:-none}" "$polls" "$warmup_seconds" "$poll_interval"

if [ "$status" -ne 0 ]; then
  exit "$status"
fi

failed=0
if [ "$peak" -gt "$budget" ]; then
  printf '\nfd-budget: FAILED — peak %s descriptors exceeds the ceiling of %s.\n' "$peak" "$budget" >&2
  failed=1
fi
if [ -n "$delta_budget" ] && [ "$delta" != "unmeasured" ] && [ "$delta" -gt "$delta_budget" ]; then
  printf '\nfd-budget: FAILED — descriptor growth of %s over the post-warm-up samples exceeds the budget of %s.\n' \
    "$delta" "$delta_budget" >&2
  failed=1
fi
if [ "$failed" -ne 0 ]; then
  cat >&2 <<'EOF'

This is the descriptor leak from issue #74, and it is a BUG, not a slow
test. Each startDaemon/stop cycle leaks 2 on bun 1.3.13 (Bun's
fs.watch close() does not free the fd; node v24.21.0 does not leak).
Re-measure the rate with:

  cd packages/cli && bun test test/serve/fd-budget.test.ts

If that per-cycle test still passes, the growth is coming from somewhere
else — report it with the numbers above rather than raising the budget.
EOF
  exit 1
fi
exit 0
