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
#   --budget N        absolute peak. A runaway backstop. The only one of the two
#                     that is active on every leg of every run.
#   --delta-budget N  growth after a warm-up. Retracted claim, corrected here:
#                     it used to read "The one that can SEE the leak", and on CI
#                     that is false. The `packages/cli` leg — the one this budget
#                     was derived from — DECLINES to produce a growth figure on
#                     CI, because that runner's module-load ramp extends past
#                     the warm-up (measured twice: floor 3966/3971 against an
#                     opening probe of 3497/3431, deficit 469/540). So on CI the
#                     growth check is not applied to the leg it was built for,
#                     and the in-process per-cycle test in
#                     `packages/cli/test/serve/fd-budget.test.ts` is the only
#                     active guard against a descriptor leak — and it covers
#                     `startDaemon`/`stop` alone, not the whole process tree
#                     this script watches. What the growth budget still buys is
#                     a cross-process total on the legs whose window IS settled
#                     (`packages/worker`, `site/playwright`) and a hard refusal
#                     to report a figure it cannot defend. Tracked with #86.
#
# The `packages/cli` leg breaks down as ~3433 fixed plus ~1020 of leak, and
# the fixed part is a module-load cost rather than a leak. Three separate
# measurements were previously conflated into one number here, so each is
# labelled with what it actually is:
#
#   52      a bare `bun test` file importing only `node:fs`.
#   3268    a minimal probe whose only project import is `serve/daemon.ts`.
#   ~3433   the real leg's post-warm-up FLOOR, measured as the p10 of the
#           post-warm-up window on a local run (412 samples, loadavg ~3).
#           The older `min`-based figure was 3384 local / 3403 on CI; see
#           "THE FLOOR STATISTIC" below for why the two differ and which is
#           now the one growth is measured from.
#
# Only the third is the baseline growth is measured from, so the arithmetic
# uses it: the first DOUBLING of the leak lands at ~3433 + 2040 = ~5473,
# comfortably UNDER any absolute ceiling loose enough not to false-positive
# on a big workstation. An absolute ceiling alone is therefore blind to
# precisely the regression it was added for.
#
# Measuring growth after a warm-up drops the constant term, which is what
# makes a doubling visible. The warm-up is discarded rather than the first
# sample, because the first samples race the module graph being loaded — and
# one of them measured 3, against a settled plateau of 3433.
#
# THE FLOOR STATISTIC (issue #86). Growth used to be `max - min`, so ONE
# sample defined the floor and any transient at the bottom of the window was
# charged as leak. That mis-fired on healthy runs — CI run 37214081546
# attempt 1 reported growth 4006 against a budget of 1800, with floor 689
# against a plateau of 3403, on the same commit that measured 1632 when
# re-run. The floor is now the p10 of the post-warm-up window, and a settled
# baseline is a precondition for reporting a growth figure at all. The
# arithmetic and the reason for each constant are in `fd-budget-verdict.sh`,
# which is also where the honest `unmeasured` state is decided.
#
# The in-process `fd-budget.test.ts` catches the leak RATE with far better
# resolution (it sees a single daemon lifecycle). This script's job is the
# cross-process total and the growth, which no in-process test can observe.
# Neither one can attribute growth to a cause; see the failure message.
#
# Usage: scripts/fd-budget.sh --budget N [--delta-budget N] -- cmd args...
# Exits with the command's own status if it failed, else 1 if a budget was
# exceeded or the run could not be measured.
#
# Linux-only (`/proc/<pid>/fd`): outside Linux the check is skipped with a
# notice and the command runs unwatched, rather than pretending to have
# measured something.

set -uo pipefail

# The verdict arithmetic lives in a sourceable sibling, so a test can call the
# SAME function this script calls instead of re-implementing it (issue #86).
# There is deliberately no flag and no environment variable for handing this
# gate samples instead of measuring them — a gate that accepts injected numbers
# on a settable input can be silenced, and this one cannot be. Resolved relative
# to THIS file rather than the caller's cwd, so the script works from anywhere.
fd_self="${BASH_SOURCE[0]}"
case "$fd_self" in
  */*) fd_libdir="${fd_self%/*}" ;;
  *) fd_libdir="." ;;
esac
fd_lib="$fd_libdir/fd-budget-verdict.sh"
if [ ! -r "$fd_lib" ]; then
  printf 'fd-budget: cannot read the verdict arithmetic at %s\n' "$fd_lib" >&2
  exit 70
fi
# shellcheck source=fd-budget-verdict.sh  # sibling in this directory; the hook
# runs shellcheck per file without -x, so the follow cannot happen here.
# shellcheck disable=SC1091
. "$fd_lib"

# Defaults for the verdict function's outputs, assigned before it is called.
# These are load-bearing, not appeasing: when the growth is `unmeasured` the
# function leaves fdv_floor/probe/growth/deficit UNSET, and this script reads
# them under `set -u` in the summary and failure paths. It also happens to be
# what makes shellcheck accept the cross-file reads, since it does not follow
# the source above.
: "${fdv_polls:=0}" "${fdv_n:=0}" "${fdv_peak:=0}" "${fdv_window_peak:=0}"
: "${fdv_no_samples:=1}" "${fdv_measured:=0}" "${fdv_settled:=0}"
: "${fdv_floor:=}" "${fdv_probe:=}" "${fdv_growth:=}" "${fdv_deficit:=}"

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
# Two seconds therefore clears the ~1s ramp with ~1s of margin.
#
# RE-MEASURED for #86, and it stays at 2. Instrumenting the poller to keep its
# sample files, on a local `packages/cli` leg at loadavg ~3, the raw trace is
# 3 at sample 1 and 3416-3433 by sample 11, holding 3433 flat through sample 50:
# the whole ramp is inside the first TEN polls. Because the tree is narrow at
# that point, the achieved interval there is the narrow-tree figure (~55ms) and
# not the 226ms mean above, so ten polls is ~0.6-0.8s of wall clock — which
# agrees with the ~1s measured by the per-sample stamps cited above. So 2s
# carries ~1.2s of margin, not the ~1s previously claimed, and there is nothing
# to gain by shortening it.
#
# Shortening would also be the wrong trade now. It used to be tempting because a
# longer warm-up was the only defence against a ramp; after #86 the p10 floor and
# the settledness test are that defence, so a longer warm-up buys nothing either.
# But the ramp's FIRST sample is not near the plateau — it measured 3 against
# 3433 — so a warm-up that expires before the ramp does does not merely lose
# margin, it hands the floor a sample three orders of magnitude below the
# baseline. A shorter warm-up trades a false negative for a blind one, and the
# measurement says there is no false negative to trade away.
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
#                          letting one through poisons the floor that
#                          growth is measured from: trailing zeros made
#                          growth collapse onto the peak, silently
#                          reducing the growth budget to a second copy of
#                          the absolute ceiling.
#
#                          STILL LOAD-BEARING UNDER p10, and it is worth being
#                          explicit about why, because the percentile looks
#                          like it should have made the drop redundant. It has
#                          not. p10 tolerates zeros in the lowest tenth of the
#                          window, so a SINGLE trailing zero is now harmless —
#                          but the floor is a percentile, not a minimum, so
#                          enough zeros still poison it, just later: over 10%
#                          of the window reads as zeros, the floor collapses
#                          to 0 and growth collapses onto the peak again. The
#                          threshold moved; the requirement did not.
#                          `fd-budget-script.test.ts` asserts both halves of
#                          that — that a trace containing >10% zeros floors at
#                          0, and that a normal run's floor is strictly
#                          positive.
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

# The whole decision, delegated to one pure function of the two sample files.
# The old inline version computed `growth = max - min`, where `min` was a single
# sample and the module-load ramp therefore counted as leak (issue #86).
fd_budget_verdict "$raw" "$samples"

if [ "$fdv_no_samples" -eq 1 ]; then
  printf 'fd-budget: FAILED — no samples were taken, so this run was NOT measured.\n' >&2
  printf 'fd-budget: the command exited before the first poll completed, and reporting "peak 0" would be a\n' >&2
  printf 'fd-budget: silent pass, so this is an error rather than a success.\n' >&2
  [ "$status" -ne 0 ] && exit "$status"
  exit 1
fi

# Verdicts, computed from the function's output. The growth budget applies only
# when a growth figure can be defended; `unmeasured` is not a pass on the leak,
# it is a declined measurement, and the ceiling above stands either way.
fdv_peak_exceeded=0
[ "$fdv_peak" -gt "$budget" ] && fdv_peak_exceeded=1

fdv_growth_reported="unmeasured"
fdv_growth_exceeded=0
if [ "$fdv_measured" -eq 1 ] && [ "$fdv_settled" -eq 1 ]; then
  fdv_growth_reported="$fdv_growth"
  if [ -n "$delta_budget" ] && [ "$fdv_growth" -gt "$delta_budget" ]; then
    fdv_growth_exceeded=1
  fi
fi

if [ "$fdv_settled" -eq 1 ]; then
  fdv_settled_word=yes
else
  fdv_settled_word=no
fi

# Cleanup of `$samples` and `$raw` is left to the EXIT trap. Doing it by hand
# here would mean clearing the trap too (so the second file survives), or
# removing one and leaving the other to a trap that a later `exit` may or may
# not reach.
if [ "$fdv_measured" -eq 1 ]; then
  printf 'fd-budget: peak %s open fds (ceiling %s); post-warm-up window %s samples: floor %s (p%d), opening probe %s, deficit %s, baseline settled: %s, growth %s (budget %s); %s polls, %ss warm-up, target %ss interval\n' \
    "$fdv_peak" "$budget" "$fdv_n" "$fdv_floor" "$FDV_FLOOR_PCTL" "$fdv_probe" "$fdv_deficit" \
    "$fdv_settled_word" "$fdv_growth_reported" "${delta_budget:-none}" "$fdv_polls" "$warmup_seconds" "$poll_interval"
else
  printf 'fd-budget: peak %s open fds (ceiling %s); post-warm-up window %s samples: growth NOT MEASURED; %s polls, %ss warm-up, target %ss interval\n' \
    "$fdv_peak" "$budget" "$fdv_n" "$fdv_polls" "$warmup_seconds" "$poll_interval"
fi

if [ "$status" -ne 0 ]; then
  exit "$status"
fi

if [ "$fdv_measured" -eq 0 ] || [ "$fdv_settled" -eq 0 ]; then
  if [ "$fdv_measured" -eq 0 ]; then
    printf '\nfd-budget: growth NOT MEASURED, so the growth budget was NOT applied to this run.\n' >&2
    printf 'fd-budget:   Only %s post-warm-up sample(s) were taken — the leg finished inside the %ss\n' \
      "$fdv_n" "$warmup_seconds" >&2
    printf 'fd-budget:   warm-up window. There is no window to measure growth across, and this gate\n' >&2
    printf 'fd-budget:   declines rather than inventing one from too few samples to be meaningful.\n' >&2
  else
    printf '\nfd-budget: growth NOT MEASURED, so the growth budget was NOT applied to this run.\n' >&2
    printf 'fd-budget:   The descriptor count had not settled when the window opened: floor %s against an\n' \
      "$fdv_floor" >&2
    printf 'fd-budget:   opening probe of %s — a deficit of %s. For scale, the growth that figure would\n' \
      "$fdv_probe" "$fdv_deficit" >&2
    printf 'fd-budget:   have produced is %s, so a deficit LARGER than that is expected here rather than\n' \
      "$fdv_growth" >&2
    printf 'fd-budget:   a symptom: the ramp simply climbed past the opening sample.\n' >&2
    printf 'fd-budget:   Within one window, "the baseline had not finished settling" and "a leak is\n' >&2
    printf 'fd-budget:   accumulating" are the same shape, and this gate counts descriptors rather than\n' >&2
    printf 'fd-budget:   daemon cycles, so it declines to report a growth figure it cannot defend.\n' >&2
  fi
  if [ "$fdv_peak_exceeded" -eq 1 ]; then
    printf 'fd-budget: The absolute ceiling (peak %s against %s) DID apply to every sample, and it failed.\n' \
      "$fdv_peak" "$budget" >&2
  else
    printf 'fd-budget: The absolute ceiling (peak %s against %s) DID apply to every sample, and it passed.\n' \
      "$fdv_peak" "$budget" >&2
  fi
  printf 'fd-budget: This is "could not measure", NOT a pass on the leak. Narrow it with the per-cycle\n' >&2
  printf 'fd-budget: rate, which measures what this gate cannot:\n' >&2
  printf 'fd-budget:   cd packages/cli && bun test test/serve/fd-budget.test.ts\n' >&2
fi

if [ "$fdv_peak_exceeded" -ne 0 ] || [ "$fdv_growth_exceeded" -ne 0 ]; then
  {
    printf '\nfd-budget: FAILED'
    if [ "$fdv_peak_exceeded" -ne 0 ] && [ "$fdv_growth_exceeded" -ne 0 ]; then
      printf ' on both budgets.'
    elif [ "$fdv_peak_exceeded" -ne 0 ]; then
      printf ' — peak %s descriptors exceeds the ceiling of %s.\n' "$fdv_peak" "$budget"
    else
      printf ' — descriptor growth of %s exceeds the budget of %s.\n' "$fdv_growth" "$delta_budget"
    fi
    printf '\n'
    [ "$fdv_peak_exceeded" -ne 0 ] &&
      printf '  absolute:  peak %s against a ceiling of %s, over %s polls (warm-up %ss)\n' \
        "$fdv_peak" "$budget" "$fdv_polls" "$warmup_seconds"
    [ "$fdv_growth_exceeded" -ne 0 ] &&
      printf '  growth:    %s over %s post-warm-up samples — floor %s (p%d), opening probe %s,\n' \
        "$fdv_growth" "$fdv_n" "$fdv_floor" "$FDV_FLOOR_PCTL" "$fdv_probe"
    [ "$fdv_growth_exceeded" -ne 0 ] &&
      printf '             deficit %s, baseline settled: %s, against a budget of %s\n' \
        "$fdv_deficit" "$fdv_settled_word" "$delta_budget"
    cat <<'EOF'

CAUSE NOT ESTABLISHED. This gate counts descriptors. It did not count daemon
cycles and it does not know which code path is holding them, so nothing here
attributes this to a bug.
EOF
    if [ "$fdv_growth_exceeded" -ne 0 ]; then
      cat >&2 <<'EOF'

For a growth failure there is a specific ambiguity worth naming. This gate has
already established that the baseline had settled — "baseline settled: yes"
above — so it is NOT confusing this with module load, which is the mistake
issue #86 was about. What it cannot exclude is a leak that was ALREADY
accumulating when the window opened: that is the same shape as the ramp it just
ruled out, and settling is decided by a threshold rather than observed. The
measured size of that blind spot is in `scripts/fd-budget-verdict.sh`; a leak
completing inside the window's opening tenth is charged nothing at all.
EOF
    else
      cat >&2 <<'EOF'

For a peak failure the ambiguity is narrower: a high peak is either a runaway or
one large legitimate allocation, and this gate cannot tell which. The growth
figure on the summary line above is the narrower signal to read first.
EOF
    fi
    cat >&2 <<'EOF'

Issue #74 is a real bug with its own test — an fs.watch().close() leak of 2
descriptors per daemon cycle on bun 1.3.13 — but whether THIS number is that
bug is a question for the per-cycle rate, which measures exactly what this gate
cannot:

  cd packages/cli && bun test test/serve/fd-budget.test.ts

If that test passes at its budgeted rate, the growth above is not the #74
watcher leak, and something else is holding descriptors — report it with the
numbers above rather than raising the budget. If it fails, the leak rate has
moved, and that is the finding to chase first.
EOF
  } >&2
  exit 1
fi
exit 0
