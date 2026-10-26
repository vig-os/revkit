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
#                     that is false. It was false for a reason #89 removed: the
#                     2s warm-up below did not transfer to the CI runner, so the
#                     `packages/cli` leg — the one this budget was derived from
#                     — declined to produce a growth figure at all (measured
#                     three times across two commits: floor 3966/3971/3973
#                     against opening probes of 3497/3431/3537, deficits
#                     469/540/436, printed `baseline settled: no`). The warm-up
#                     is now adaptive and the leg reports a figure again; see
#                     "THE ADAPTIVE WARM-UP" below for the cap, the new third
#                     state, and what it costs.
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
# THE ADAPTIVE WARM-UP (issue #89). The warm-up used to be a fixed 2s and is
# now a decision: the window opens when the count has been flat for one settle
# span, and not before. The minimum stays 2s, which is what every local run
# rides, so nothing about a healthy dev box moves.
#
# WHY 2s WAS NOT WRONG ON THIS HOST AND WAS WRONG ON CI. It was not wrong here —
# it was MEASURED here, and the measurement was sound. Instrumenting the poller
# on the real `packages/cli` leg (loadavg 0.85, 660 polls over 174.6s, 1388
# tests passing), the raw trace is:
#
#     t+12ms 3      t+150ms 447    t+313ms 693    t+506ms 1301
#     t+712ms 2342  t+930ms 3382   t+1157ms 3382  t+1390ms 3389
#     t+1617ms 3405 t+1940ms 3429  t+2284ms 3429  t+2513ms 3416
#
# so the whole ~3.4k module-load ramp is inside the first FIVE polls, ~0.93s of
# wall clock, and 2s carries ~1.07s of margin. On CI the same climb takes ~4.1s,
# which is where #89 came from, and the arithmetic for that number is below.
#
# HOW THE CI RAMP END WAS MEASURED WITHOUT A NEW CI RUN, because it is derivable
# from a summary line this script already prints. `probe` is p10 of the window's
# first DECILE, and the window's first decile is a fixed span into the run — on
# run 37258522674 that is 140 samples at 127.7ms (1406 polls over 179.6s), i.e.
# the probe is the count at t=2+13x0.128 = 3.66s. `floor` is the plateau once
# the ramp has ended. For a linear ramp, `probe/floor` = (3.66-t0)/(T-t0), so
#
#     T = (3.66 - 0.1098 t0) / (probe/floor)
#
# and the three recorded CI runs give T = 4.08s, 4.12s and 4.19s — a 0.11s
# spread across two commits, which is what makes this a measurement of the
# runner rather than a guess. The implied ramp rate is 995-1051 fds/s against
# this host's ~3700, so CI's module-load pace is 3.5-3.7x slower, and the count
# at t=2s is ~1790 against a plateau of ~3970. That last number is the defect in
# one figure: at 2s the count is barely half way up the ramp.
#
# THE THIRD STATE, NAMED. There are now four outcomes and three of them are not
# a growth figure:
#
#   settled     the count was flat for a settle span, the window opened, and the
#               verdict's own probe agreed the baseline was down.
#   too short   the leg's last poll fell inside the minimum warm-up. #86's
#               existing state, kept deliberately: it asserts a fact about the
#               LEG ("there was no window to open"), which is still exactly what
#               happened. The ramp-ended-in-the-cap state is not this one
#               because it asserts something about the RAMP, and a short leg
#               gives no evidence about the ramp at all.
#   unsettled   the window opened and the opening probe was still below the
#               floor. #86's existing state.
#   ramp did    the count was STILL climbing when the warm-up reached its cap,
#   not settle  so no window was ever opened. Distinct from both neighbours in
#               cause, in evidence and in remedy, and it is the only one that
#               says something about the runner.
#
# THE CAP, AND WHY IT IS 10s. Both bounds on it are measurements of a runner,
# not of the code, and they conflict: the cap must be long enough to clear the
# CI ramp (lower bound) and short enough that the warm-up cannot discard more
# wall clock than the verdict's own floor already discards of the window (upper
# bound). Neither is a formula, and pretending otherwise would be the same
# mistake #86 was about.
#
#   LOWER, from the ramp: the measured CI ramp ends at 4.08-4.19s and the settle
#   span is 1s, so the warm-up needs ~5.2s. 10s is 1.9x that. Beyond it, the
#   gate reports `ramp did not settle` rather than a wrong number, which is the
#   safe direction.
#   UPPER, from the hole: the extended warm-up may not discard more wall clock
#   than the p10 floor already discards of the window, and the floor discards
#   the window's first decile — measured at 66 samples x 264ms = 17.4s locally
#   and 140 x 128ms = 17.9s on CI. 10s extends the warm-up by 8s, which is
#   2.2x inside that. This bound is the one worth holding tightly, because
#   crossing it means a leak long enough to have been caught at the old warm-up
#   can now finish inside the discarded prefix. A leak of the size the growth
#   budget exists to catch has to run past the window's opening decile to be
#   caught at all, i.e. past ~19.9s, and the cap fires at 10s — so the two
#   cannot both be true of the same leak and the band is empty at this cap.
#
# THE WALL-TIME COST IS ZERO, which is the part that is easy to get wrong by
# assuming otherwise. The warm-up does not delay the run: the poller and the
# child are concurrent, so an extension is spent polling a process that is
# already running. What an extension costs is WINDOW. By arithmetic, on CI: the
# warm-up resolves ~5.2s into a 178s run instead of 2s, so 1.8% of the window is
# discarded, which at the measured 4.8 fds/s leak rate is ~15 descriptors of
# growth figure.
#
# MEASURED, and the local case costs nothing at all: three `just test` runs at
# loadavg 7.9/8.2/9.0 all printed `warm-up settled at 2s (minimum 2s)` for the
# cli leg, with growth 953/955/957 against PR #88's 960/957/961 on the same host
# — a spread of 4 descriptors, 0.4%, which is the same spread #88 measured. The
# window now opens on a precise 2000ms rather than on the first whole-second
# boundary after it (`SECONDS` could not express a settle span, so the clock moved
# to `EPOCHREALTIME`), and that is where the remaining descriptor or two comes
# from. A warm-up that reaches its cap costs the whole window, and says so.
#
# The Playwright leg is the one that DOES extend: its `just build` is a real
# descriptor ramp, and it settles at 5s rather than 2s. It still reports a figure
# (measured 5723 against its 12000 budget, peak 5749, `baseline settled: yes`),
# which is the point — before this change that leg's growth was measured over a
# window that had opened during its build.
#
# IT IS NOT CONFIGURABLE, and that is deliberate rather than merely convenient.
# `warmup_seconds` and the cap are literals for the same reason the verdict has
# no way to be handed numbers instead of measuring them: a gate whose warm-up
# can be set from the outside is a gate whose `baseline settled: yes` can be
# bought. There is no flag and no environment variable for either, and
# `fd-budget-script.test.ts` asserts the absence.
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
: "${fdw_n:=0}" "${fdw_rise:=0}" "${fdw_growth:=0}" "${fdw_tol:=0}" "${fdw_settled:=0}"

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
stamps=$(mktemp)
warmstate=$(mktemp)
trap 'rm -f "$samples" "$raw" "$stamps" "$warmstate"' EXIT

"$@" &
child=$!
# Epoch milliseconds for the poll loop, from bash's own clock rather than
# `SECONDS`. Two reasons, both #89: the settle span is a fraction of a second and
# `SECONDS` cannot express one, and `SECONDS` also quantises the MINIMUM warm-up
# to a second boundary — which is how the old script's window opened anywhere in
# [2s, 3s) rather than at 2s. `EPOCHREALTIME` is bash 5.0+ and reads the clock
# without forking, which matters because this is the hot loop.
t0_ms=$((10#${EPOCHREALTIME%.*} * 1000 + 10#${EPOCHREALTIME#*.} / 1000))

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
# IT IS NOW A MINIMUM AND NOT A CONSTANT (issue #89). 2s is still the floor of
# the warm-up and every local run rides it, but it is no longer the whole of it:
# the poller keeps the window shut until `fd_budget_warmup` says the count has
# been flat for a settle span, and gives up at `warmup_cap_seconds`. The ramp is
# ~0.93s of wall clock on this host and ~4.1s on the CI runner, so the same 2s is
# ample here and short there; the derivation of the span, of the tolerance and of
# the cap is in `fd-budget-verdict.sh` and in the header above.
#
# IT IS NOT CONFIGURABLE and adding an input for it would reopen the seam #86
# closed. There is no flag, no environment variable and no default-from-
# environment here; both numbers are literals in this file, and
# `fd-budget-script.test.ts` asserts that no bypass-shaped name has appeared.
#
# Shortening the minimum would also be the wrong trade. It used to be tempting
# because a longer warm-up was the only defence against a ramp; after #86 the p10
# floor and the settledness test are that defence, and after #89 the warm-up
# extends by itself, so shortening buys nothing. But the ramp's FIRST sample is
# not near the plateau — it measured 3 against 3433 — so a warm-up that expires
# before the ramp does does not merely lose margin, it hands the floor a sample
# three orders of magnitude below the baseline. A shorter warm-up trades a false
# negative for a blind one, and the measurement says there is no false negative
# to trade away.
#
# Every positive sample goes to `raw` (so "did we ever poll?" stays
# answerable), every one also goes to `stamps` with its elapsed time (so the
# warm-up can ask its question over a span in SECONDS, which a sample index
# cannot express — CI's 128ms poll interval and this host's 264ms make the same
# decile two different durations), and only post-warm-up ones go to `samples` (so
# growth is measured). That distinction is what lets a leg too SHORT to measure
# be reported honestly instead of either faking a number or failing.
warmup_seconds=2
# The settle span, in milliseconds, derived from the minimum and the percentage
# in the verdict library — so there is one place that decides how long "settled"
# means, and both the script and the tests read it from there.
warmup_settle_ms=$((warmup_seconds * FDV_WARMUP_SETTLE_PCT * 1000 / 100))
# The cap. The two bounds on it, both measurements and both stated in the header
# above: the measured CI ramp needs ~5.2s of warm-up, and the warm-up must not
# extend by more than the window's own first decile (17.4s local / 17.9s CI) or
# it would discard more of the run than the p10 floor already does. 10s is 1.9x
# the lower bound and 2.2x inside the upper one.
warmup_cap_seconds=10

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
#
# A THIRD condition is load-bearing under #89's warm-up, and it is the one that
# made the old two conditions insufficient. The window used to open on a fixed
# 2s and that was the entire decision; it now opens when the count has been flat
# for a settle span, which means the poller has to ask that question on every
# poll after the minimum. `fd_budget_warmup` is a pure function of the stamps
# file, so asking is a read of a small file and no state — and the poller's own
# `warm` variable is the ONLY thing that decides whether a sample lands in the
# window. There is no branch around the call.
(
  warm=min
  warm_now_ms=0
  warm_open_ms=0
  while [ -d "/proc/$child" ]; do
    n=$(fds_of_tree "$child")
    warm_now_ms=$((10#${EPOCHREALTIME%.*} * 1000 + 10#${EPOCHREALTIME#*.} / 1000 - t0_ms))
    if [ "$n" -gt 0 ]; then
      printf '%s\n' "$n" >>"$raw"
      printf '%s %s\n' "$warm_now_ms" "$n" >>"$stamps"
      if [ "$warm" = min ] && [ "$warm_now_ms" -ge $((warmup_seconds * 1000)) ]; then
        fd_budget_warmup "$stamps" "$warmup_settle_ms"
        if [ "$fdw_settled" -eq 1 ]; then
          warm=settled
          warm_open_ms=$warm_now_ms
        elif [ "$warm_now_ms" -ge $((warmup_cap_seconds * 1000)) ]; then
          warm=capped
          warm_open_ms=$warm_now_ms
        fi
      fi
      # Recorded on every poll, and the time it records is the RESOLVING one, not
      # the latest: while the warm-up is unresolved it tracks the current poll (so
      # a leg that ends mid-warm-up leaves behind how far it got), and the moment
      # it resolves it freezes. Recording the latest poll instead reported
      # `settled at 199s` on a 199s leg, which is a fact about the leg's length
      # and not about the warm-up. The file is a `mktemp` handle created here, so
      # there is no path by which anything outside this script can set it.
      [ "$warm" = min ] && warm_open_ms=$warm_now_ms
      printf '%s %s\n' "$warm" "$warm_open_ms" >"$warmstate"
      if [ "$warm" = settled ]; then
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

# How the warm-up ended, read back from the poller. `min` here means the leg's
# last poll fell inside the minimum warm-up, which is #86's "too short to
# measure" and only that: the poller resolves the warm-up on the very first poll
# at or after the minimum, so a leg that reached the minimum and produced no
# window has an unresolved CAP, not a short leg.
warm=min
warm_open_ms=0
if [ -s "$warmstate" ]; then
  read -r warm warm_open_ms <"$warmstate" || true
  warm_open_ms=${warm_open_ms:-0}
fi

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

# How the warm-up ended, in words, for the summary line. Four outcomes and they
# are four different facts: see the header's "THE THIRD STATE, NAMED". The
# elapsed time is rendered from the poller's own millisecond stamp so the number
# on the line is the number the decision was made on.
warm_open_s=$((warm_open_ms / 1000))
case "$warm" in
  settled)
    if [ "$warm_open_ms" -lt $((warmup_seconds * 1000)) ]; then
      warm_word="warm-up settled at the ${warmup_seconds}s minimum"
    else
      warm_word="warm-up settled at ${warm_open_s}s (minimum ${warmup_seconds}s)"
    fi
    ;;
  capped) warm_word="warm-up DID NOT SETTLE within the ${warmup_cap_seconds}s cap (minimum ${warmup_seconds}s)" ;;
  *) warm_word="warm-up never completed: the leg's last poll was at ${warm_open_s}s, inside the ${warmup_seconds}s minimum" ;;
esac

# Cleanup of `$samples` and `$raw` is left to the EXIT trap. Doing it by hand
# here would mean clearing the trap too (so the second file survives), or
# removing one and leaving the other to a trap that a later `exit` may or may
# not reach.
if [ "$fdv_measured" -eq 1 ]; then
  printf 'fd-budget: peak %s open fds (ceiling %s); post-warm-up window %s samples: floor %s (p%d), opening probe %s, deficit %s, baseline settled: %s, growth %s (budget %s); %s polls, %s, target %ss interval\n' \
    "$fdv_peak" "$budget" "$fdv_n" "$fdv_floor" "$FDV_FLOOR_PCTL" "$fdv_probe" "$fdv_deficit" \
    "$fdv_settled_word" "$fdv_growth_reported" "${delta_budget:-none}" "$fdv_polls" "$warm_word" "$poll_interval"
else
  printf 'fd-budget: peak %s open fds (ceiling %s); post-warm-up window %s samples: growth NOT MEASURED; %s polls, %s, target %ss interval\n' \
    "$fdv_peak" "$budget" "$fdv_n" "$fdv_polls" "$warm_word" "$poll_interval"
fi

if [ "$status" -ne 0 ]; then
  exit "$status"
fi

if [ "$fdv_measured" -eq 0 ] || [ "$fdv_settled" -eq 0 ]; then
  if [ "$warm" = capped ]; then
    printf '\nfd-budget: growth NOT MEASURED, so the growth budget was NOT applied to this run.\n' >&2
    printf 'fd-budget:   The descriptor count was STILL CLIMBING when the warm-up reached its %ss cap, so no\n' \
      "$warmup_cap_seconds" >&2
    printf 'fd-budget:   measurement window was ever opened. This is a THIRD state and it is not either of\n' >&2
    printf 'fd-budget:   the other two, which matters because all three decline a growth figure for\n' >&2
    printf 'fd-budget:   different reasons and none of them is a pass on the leak:\n' >&2
    printf 'fd-budget:     too short  the leg finished inside the %ss minimum warm-up; there was no window.\n' \
      "$warmup_seconds" >&2
    printf 'fd-budget:     unsettled  a window WAS opened and its opening probe was still below the floor.\n' >&2
    printf 'fd-budget:     this       the ramp did not END within the cap. Nothing opened, so there is no\n' >&2
    printf 'fd-budget:                 window, no floor and no probe to report — only the count.\n' >&2
    printf 'fd-budget:   The count reached %s by t+%ss and was still rising then; across its last %sms it\n' \
      "$fdv_peak" "$warm_open_s" "$warmup_settle_ms" >&2
    printf 'fd-budget:   rose by more than the tolerance. That tolerance is the same one the verdict\n' >&2
    printf 'fd-budget:   applies to a window it opens — fd_budget_warmup in scripts/fd-budget-verdict.sh\n' >&2
    printf 'fd-budget:   carries the derivation, and the two are one number by construction.\n' >&2
    printf 'fd-budget:   The measured module-load ramp ends ~0.93s into a run on a dev host and ~4.1s on\n' >&2
    printf 'fd-budget:   the CI runner, so reaching a %ss cap means the module-load pace on this\n' \
      "$warmup_cap_seconds" >&2
    printf 'fd-budget:   pace is worse than about 2.4x the slowest pace measured anywhere. That is a\n' >&2
    printf 'fd-budget:   property of the runner and not of the code: no fixed cap can clear a ramp whose\n' >&2
    printf 'fd-budget:   length is not yet known, which is the whole reason the warm-up is adaptive.\n' >&2
  elif [ "$fdv_measured" -eq 0 ]; then
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
    printf 'fd-budget:   The window opened because the count HAD been flat for the %sms settle span, so\n' \
      "$warmup_settle_ms" >&2
    printf 'fd-budget:   this is the ramp RESTARTING after the warm-up resolved, not a warm-up that was too\n' >&2
    printf 'fd-budget:   short. Within one window, "the baseline had not finished settling" and "a leak is\n' >&2
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
      printf '  absolute:  peak %s against a ceiling of %s, over %s polls (%s)\n' \
        "$fdv_peak" "$budget" "$fdv_polls" "$warm_word"
    [ "$fdv_growth_exceeded" -ne 0 ] &&
      printf '  growth:    %s over %s post-warm-up samples — floor %s (p%d), opening probe %s,\n' \
        "$fdv_growth" "$fdv_n" "$fdv_floor" "$FDV_FLOOR_PCTL" "$fdv_probe"
    [ "$fdv_growth_exceeded" -ne 0 ] &&
      printf '             deficit %s, baseline settled: %s, against a budget of %s\n' \
        "$fdv_deficit" "$fdv_settled_word" "$delta_budget"
    [ "$fdv_growth_exceeded" -ne 0 ] &&
      printf '             %s\n' "$warm_word"
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
