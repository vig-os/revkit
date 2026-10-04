#!/usr/bin/env bash
# fd-budget VERDICT ARITHMETIC — the decision `fd-budget.sh` makes, as a pure
# function of two sample files. Issue #86.
#
# WHY THIS IS A SEPARATE, SOURCEABLE FILE. `fd-budget.sh` used to compute the
# verdict inline, so there was no way to test the decision a shared CI gate
# makes: `packages/cli/test/serve/fd-budget.test.ts` covered the per-cycle leak
# rate and this process's own ceiling, and NOTHING covered the script's
# arithmetic or its pass/fail branches. Fixing that needs a seam, and the only
# safe kind of seam is one that adds no input path.
#
# SO THERE IS NO `--samples-from` FLAG, and no environment variable, and no way
# for CI (or anyone) to hand this gate numbers instead of measuring them. A gate
# that accepts injected samples on a settable flag is a gate that can be
# silenced; this one cannot. Instead the arithmetic lives here, both the
# production script and the tests CALL this function, and a reviewer can see the
# production path is `fd_budget_verdict "$raw" "$samples"` — the same two files
# the poller wrote — with no branch around it.
#
# THE TWO NUMBERS, and which is which.
#
#   fdv_floor   p10 of the post-warm-up samples. The baseline growth is
#               measured FROM, replacing the old absolute `min`.
#   fdv_probe   p10 of the FIRST DECILE of the post-warm-up window, in time
#               order. Where the descriptor count was when the window opened.
#
# `min` was the defect (#86): one sample defined the floor, so any transient at
# the bottom of the window was charged as leak. Measured instances of that on
# healthy runs, in the same order of magnitude as the CI failures:
#
#   * the poller's FIRST sample catches the tree before it opens its
#     descriptors — measured at 3 on a healthy local run, against a settled
#     plateau of 3433. Had that landed inside the window, `min`-based growth
#     would have read 4451, i.e. 2.5x the budget, on a run whose real growth
#     was 1038.
#   * CI run 37214081546 attempt 1: floor 689 against a plateau of 3403.
#
# A percentile makes a handful of such samples unable to move the floor: p10
# ignores the lowest 10% of the window by construction. The cost is that it
# RAISES the floor, so it REDUCES measured growth — the right direction, because
# the old figure over-counted. See the "EFFECT ON THE NUMBERS" note below for
# the size.
#
# `probe` exists because a percentile alone is not enough, and the reason is
# worth stating because it is the limit of what this gate can know. Within one
# window, "the baseline had not finished settling" and "a leak is accumulating"
# are the SAME SHAPE: a monotone rise. No in-window statistic separates them,
# because the information needed to separate them is not in the window — what
# separates them is that the ramp is a finite one-time cost and the leak is
# paid per daemon cycle, and this gate counts descriptors, not cycles.
#
# So the question is not "can I tell them apart" but "how far do I let the
# ambiguous case run before refusing to answer". `fdv_settled` answers it by
# asking whether the count was ALREADY at its floor when the window opened:
#
#   settled  <=>  (floor - probe) <= FDV_SLACK + FDV_TOL_PCT% of growth
#
# A steady leak cannot break that test, because the count is already at the
# floor when such a window opens (measured: deficit 0 against a growth of
# 1021, on the reference run). A ramp still running breaks it badly, because
# the opening sample is nowhere near the floor. When the test cannot tell, the
# answer is `unmeasured` — which is why this gate reports no growth figure at
# all rather than a number it cannot defend, and why the ABSOLUTE CEILING
# stays in force. #86's own acceptance criterion allows either a stable verdict
# or a declined one, so the failure direction here is deliberately the safe one:
# a false `unmeasured` costs a blind run (the ceiling and the per-cycle test
# still apply), while a false `settled` costs a false CI failure, which is the
# bug this issue exists to fix.
#
# THE TWO MECHANISMS COMPOSE INTO ONE PROPERTY, which is the reason both are
# here rather than either alone. A ramp occupying fraction r of the window:
#
#   r <= 10%   the p10 floor excludes it entirely — floor and growth are sound —
#              and the probe still sits inside the ramp, so the verdict is
#              `unmeasured`.
#   10% < r    the floor is depressed AND the probe is inside the ramp, so the
#              verdict is `unmeasured`.
#   r ~= 50%+  the probe's deficit falls back inside FDV_SLACK and the ramp is
#              reported as growth. THIS IS THE KNOWN LIMIT and it is not
#              worked around, because at that point a stretched ramp and a leak
#              are the same measurement: a monotone rise over the whole window.
#              What still catches such a run is the absolute ceiling, the
#              per-cycle rate, and the deficit printed on the summary line
#              above — which is why the numbers are printed even on success.
#
# In short: no ramp this gate can still be confused by is one it will report.
#
# WHAT IS *NOT* CLAIMED. This file decides whether descriptors grew and by how
# much. It does not decide why, and nothing here names a cause — see the
# failure message in `fd-budget.sh`, which reports the numbers and says the
# cause is not established.

# Floor percentile. 10 keeps the lowest tenth of the window — the part a ramp
# can still occupy at the window's opening — out of the floor definition.
FDV_FLOOR_PCTL=10

# Fraction of growth the floor-to-probe deficit may reach before the baseline is
# called unsettled, in percent (integer arithmetic, no float in the gate).
#
# DERIVED, not chosen, and forced from both sides. For a window that is a steady
# leak from a settled floor, p10 of the window sits 10% of the way up and the
# probe 1% of the way up, so the deficit is 9% of the window's spread against a
# growth of 90% of it — a ratio of 0.100 analytically. MEASURED on the reference
# run the deficit was 0 against a growth of 1021, because that leg's leak does
# not begin until the third decile; 0.100 is therefore the WORST case, not the
# typical one.
#
# That makes 10 the only defensible value, and it is forced from both ends:
#
#   TOL < 10   the tolerance is below the analytic ratio of a steady leak, so a
#              large leak is declared "unsettled" — the gate goes BLIND to the
#              regression it exists for. The margin is a flat FDV_SLACK
#              descriptors at any leak size, not a ratio.
#   TOL > 10   more ramp is absorbed per sample, but so is more of a front-
#              loaded leak, which is the false-`unmeasured` direction.
FDV_TOL_PCT=10

# Absolute allowance, in descriptors, on top of FDV_TOL_PCT% of growth. It
# exists so that a window whose growth is ~0 is not called unsettled by its own
# sampling noise: with no growth there is nothing to be ambiguous about, and the
# verdict must stay a plain pass rather than flip to `unmeasured` on a few
# descriptors of jitter. 200 is ~5.8% of the measured 3433 plateau — large
# against sampler noise, far below the 815-deficit of a ramp occupying the
# first 30% of the window on the CI run that failed.
FDV_SLACK=200

# Number of leading samples, as a percentage of the window, that the opening
# probe is taken over. A tenth of the window is ~10-14s at the achieved poll
# rate (596-623 samples over ~97-100s locally, i.e. ~160ms; 137ms on CI), which
# is long enough for p10 to mean something and short enough to precede the leak
# on every measured leg — the cli leg's first three deciles sit flat at the
# plateau, which is why a decile-wide probe reads the baseline rather than the
# leak.
FDV_PROBE_SPAN_PCT=10

# The p-th percentile (1..100) of newline-separated integers read from STDIN:
# the value at 1-based index ceil(p/100 * n) of the ascending-sorted list.
#
# STDIN rather than a filename so one implementation serves both callers — the
# whole window, and the opening decile fed through `head` — with no temp file
# and no process substitution. (Process substitution does not survive being
# consumed inside a `$( )` from a shell function: the /dev/fd handle is gone by
# the time the nested redirect runs, and the function silently reads nothing.
# That failure is quiet, so it is worth naming.)
#
# Written as integer arithmetic on purpose. This is a gate that decides CI, and
# a float comparison here would be one more thing to get subtly wrong; ceil is
# exact for the counts involved (a few hundred to a few thousand samples).
# Returns 1 on empty input, which is the caller's "not measurable".
fdv_pctl() {
  local pct="$1" line n idx
  local -a vals=()
  while IFS= read -r line; do
    [ -n "$line" ] && vals+=("$line")
  done
  n=${#vals[@]}
  [ "$n" -gt 0 ] || return 1
  idx=$(((pct * n + 99) / 100))
  [ "$idx" -gt "$n" ] && idx="$n"
  printf '%s\n' "${vals[@]}" | sort -n | sed -n "${idx}p"
}

# fd_budget_verdict <all-samples-file> <post-warm-up-samples-file>
#
# Sets, in the caller's scope:
#
#   fdv_polls         polls taken, warm-up window included
#   fdv_n             post-warm-up samples the verdict was computed from
#   fdv_peak          max over ALL samples — the absolute backstop
#   fdv_window_peak   max over the post-warm-up window
#   fdv_floor         p10 of the window
#   fdv_probe         p10 of the window's first decile, in time order
#   fdv_growth        window_peak - floor
#   fdv_deficit       floor - probe, the "was the baseline already down" reading
#   fdv_measured      1 iff a growth figure can be reported at all
#   fdv_settled       1 iff the deficit test says the baseline had settled
#   fdv_no_samples    1 iff no poll ever completed
#
# Returns 0 always: it computes a verdict, it does not enforce one. Enforcement
# is the caller's, because the budgets and the command's own exit status are
# the caller's business.
fd_budget_verdict() {
  local raw="$1" samples="$2" decile

  fdv_polls=$(wc -l <"$raw")
  fdv_polls=$((fdv_polls))
  fdv_n=$(wc -l <"$samples")
  fdv_n=$((fdv_n))

  fdv_peak=$(sort -n "$raw" 2>/dev/null | tail -1)
  fdv_peak=${fdv_peak:-0}
  fdv_window_peak=$(sort -n "$samples" 2>/dev/null | tail -1)
  fdv_window_peak=${fdv_window_peak:-0}

  fdv_no_samples=0
  [ "$fdv_polls" -eq 0 ] && fdv_no_samples=1

  fdv_measured=0
  fdv_settled=0
  fdv_floor=""
  fdv_probe=""
  fdv_growth=""
  fdv_deficit=""

  # Fewer than two post-warm-up samples is the leg-too-short case #86 says to
  # keep answering honestly with `unmeasured`, and it is the only condition the
  # old script had. It is kept as-is rather than widened: a wider threshold
  # would report `unmeasured` on the short legs (site/schemas, just/check),
  # trading a real measurement for tidiness.
  if [ "$fdv_no_samples" -eq 0 ] && [ "$fdv_n" -gt 1 ]; then
    # shellcheck disable=SC2034  # outputs of this sourced function, read by fd-budget.sh
    fdv_measured=1
    fdv_floor=$(fdv_pctl "$FDV_FLOOR_PCTL" <"$samples")
    decile=$(((fdv_n * FDV_PROBE_SPAN_PCT + 99) / 100))
    [ "$decile" -lt 1 ] && decile=1
    [ "$decile" -gt "$fdv_n" ] && decile="$fdv_n"
    # The window's first `decile` lines, in the poller's time order, read as a
    # percentile source. Pipelining keeps this a pure function of the two
    # files: no temp file for the function to clean up.
    fdv_probe=$(head -n "$decile" "$samples" | fdv_pctl "$FDV_FLOOR_PCTL")
    fdv_growth=$((fdv_window_peak - fdv_floor))
    fdv_deficit=$((fdv_floor - fdv_probe))
    fdv_settled=0
    if [ "$fdv_deficit" -le $((FDV_SLACK + FDV_TOL_PCT * fdv_growth / 100)) ]; then
      # shellcheck disable=SC2034  # outputs of this sourced function, read by fd-budget.sh
      fdv_settled=1
    fi
  fi
}
