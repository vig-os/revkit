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
# or a declined one.
#
# THE FAILURE DIRECTION IS THE SAFE ONE, and that is a choice, not a proof. A
# false `unmeasured` costs a blind run — the absolute ceiling and the in-process
# per-cycle test both still apply. A false `settled` costs either a false CI
# failure, which is the bug #86 exists to fix, or — see the limit below — a
# leak reported as a passing number, which is worse than either.
#
# THE TWO MECHANISMS COMPOSE INTO ONE PROPERTY for RAMPS, which is the reason
# both are here rather than either alone. A ramp occupying fraction r of the
# window:
#
#   r <= 10%   the p10 floor excludes it entirely — floor and growth are sound —
#              and the probe still sits inside the ramp, so the verdict is
#              `unmeasured`.
#   10% < r    the floor is depressed AND the probe is inside the ramp, so the
#              verdict is `unmeasured`.
#   r ~= 50%+  the probe's deficit falls back inside FDV_SLACK and the ramp is
#              reported as growth. This is the ramp limit, and it is not worked
#              around, because at that point a stretched ramp and a leak are the
#              same measurement: a monotone rise over the whole window.
#
# In short: no ramp this gate can still be confused by is one it will report.
# Swept over ramp fractions 0.02 -> 0.90 on the reconstructed CI failure, every
# ramp the gate DOES report comes with an INFLATED growth figure that exceeds the
# budget — never a passing one.
#
# WHAT #89 DID TO THAT CLASSIFICATION, which is recorded here because the table
# above is documentation a future reader will reason from. The adaptive warm-up
# (fd-budget.sh) only OPENS a window once the count has been flat for one settle
# span, so two of the three rows change what they describe:
#
#   r <= 10%   STILL REACHABLE, and now reachable through a new door. A count
#              that stalls for longer than the settle span and then climbs again
#              produces exactly this shape, and so does any ramp that starts
#              after the warm-up resolved. Nothing about the p10/probe pair
#              changed.
#   10% < r    STILL REACHABLE, and STILL the most dangerous row, which is why it
#              is still the one the code works hardest to refuse. A stalling
#              count followed by a climb of more than a decile lands here.
#   r ~= 50%+  NO LONGER REACHABLE BY THE MODULE-LOAD RAMP. A ramp occupying
#              half a ~175s window cannot be preceded by a 1s flat span unless
#              it stalled first, and the real ramp does not — it climbs
#              continuously to its plateau. This row survives as a shape, but it
#              is now "a leak that paused", which is the front-loaded-leak limit
#              documented immediately below rather than a module-load cost. So
#              the ramp limit is no longer something this gate can walk into by
#              under-waiting; it is something a leak has to do on purpose.
#
# And a fourth state is now possible, which is not a ramp FRACTION at all: the
# ramp did not END within the warm-up's cap, so no window was ever opened. It
# is reported as `ramp did not settle within the cap`, it declines the growth
# figure the same way `unmeasured` does, and it is the only one of the four
# that asserts something about the runner rather than about the window.
#
# THE LIMIT ON THE OTHER SIDE: A FRONT-LOADED LEAK IS REPORTED AS A PASSING
# NUMBER, and this is the more dangerous of the two limits. The settledness test
# asks whether the count was at its floor when the window opened, and a leak
# that is still climbing at that moment looks exactly like a ramp that has not
# finished. The composition property above does NOT cover it, and neither does
# any threshold here: the two are the same measurement. Measured consequences,
# all on windows of 412 samples:
#
#   leak 2054 over the first 70% of the window, then flat:
#     floor 325, probe 61, deficit 264, settled YES, growth 1762 -> PASS.
#     A leak of twice #74's, invisible.
#   sweep of leak x ramp fraction: the largest front-loaded leak that still
#     passes a budget of 1800 is ~2000-2100 descriptors.
#   and p10 UNDER-REPORTS any monotone leak by 11-19% on top of that, because
#     it excludes the lowest tenth of the rise by construction (measured
#     0.900x the `max - min` figure for a leak starting at the window's
#     opening, against 1.000x for one starting >=10% in).
#
# So the honest statement of what this gate can see is narrower than "the
# growth": it sees a leak that accumulates across the window, not one that
# completes in the window's opening tenth, and it under-reports by up to ~19%
# when the leak is monotone. What covers the rest is named in
# `packages/cli/test/serve/fd-budget.test.ts` (the in-process per-cycle rate,
# `startDaemon`/`stop` only) and the absolute ceiling. See the coverage issue
# filed with #86 for the quantified band this leaves unguarded.
#
# WHAT IS *NOT* CLAIMED. This file decides whether descriptors grew and by how
# much. It does not decide why, and nothing here names a cause — see the
# failure message in `fd-budget.sh`, which reports the numbers and says the
# cause is not established.

# THE WARM-UP, AND WHY IT SHARES THIS FILE'S TOLERANCE (issue #89).
#
# THE BUG. `fd-budget.sh` warmed up for a fixed 2s and then measured growth.
# That is correct where the ramp was measured (it ends ~1s into the warm-up on a
# dev box) and wrong on the CI runner, where the same ~3.9k-descriptor climb
# takes ~4.1s. The window then opens mid-ramp, the opening probe sits below the
# floor by 436-540 descriptors, and the settledness test above refuses — which
# is the gate working. The cost is that on CI the `packages/cli` leg, the leg
# this budget was derived from, declines to produce a growth figure at all.
#
# WHY NO STATISTIC OVER THE TRACE CAN BE THE VERDICT'S OWN. The first thing
# tried was to run `fd_budget_verdict` itself over the prefix so far, with the
# "window" starting at the minimum warm-up. It fails, and the reason is worth
# recording because it is the whole shape of the problem: the verdict's floor is
# a p10, and a p10 only excludes a front-loaded rise if the window is LONG
# RELATIVE TO THAT RISE. Over a prefix that is mostly ramp, p10 returns the
# bottom of the ramp, the floor collapses onto the probe, and the verdict
# cheerfully reports `settled` at 0.5s — mid-ramp, on a trace where the ramp has
# another 3.6s to run. Measured, not argued: on the instrumented local trace it
# returns settled at sample 3 of 660.
#
# THE SAME HOLDING, THE OTHER WAY ROUND. Sweeping the predicate "has the count
# risen by more than the tolerance over its most recent DECILE OF SAMPLES", over
# every denominator the verdict's formula admits, gives a family that all fail
# for the same structural reason: the decile is a FRACTION of the trace, so it
# GROWS with the trace, so `rate x span` grows with time, so the decision lands
# at `t_fire = 10 x tol / rate` — and for a ramp that ends at `t_ramp` that is
# 10 x tol / (ramp_total / t_ramp), which is at or just below `t_ramp` for any
# ramp smaller than 10 x tol. The measured CI ramp is ~3973 descriptors and the
# largest tolerance in that family is 380, so the family decides at 0.96 x
# t_ramp: it cannot outlast the ramp by construction. Measured in the simulation
# over the reconstructed CI trace, the decile family fires at 2.17s against a
# ramp that ends at 4.08s.
#
# ⇒ THE SETTLEDNESS QUESTION MUST BE ASKED OVER AN ABSOLUTE SPAN, and the only
# two absolute spans in this gate are the verdict's own probe span and the
# warm-up's. The probe span cannot be used — it is a tenth of a window that does
# not exist yet, and measured post hoc it is ~17.4s locally and ~17.9s on CI, so
# a warm-up waiting a full probe span would open the local window ~11s in and
# move the local growth figure by ~50 descriptors (5%). That is the local
# regression #89 forbids. What is left is a span measured in seconds, which is
# `FDV_WARMUP_SETTLE_PCT` below, bounded by measurement on both sides.
#
# THE TOLERANCE, AND WHY THE TWO MUST AGREE. The warm-up asks "was the count
# already at its floor when the window opened?", over the span that just
# elapsed, and it allows itself the SAME formula this file allows over the
# window's opening decile:
#
#     rise over the settle span  <=  FDV_SLACK + FDV_TOL_PCT% of growth
#
# with `growth` read as the rise over the settle span, because that is the only
# rise the warm-up can name: at decision time the window's own growth is
# unknowable, and the two things it could be stood in for are both WRONG. The
# trace's total spread so far is dominated by the ramp, so it inflates the
# tolerance by exactly the quantity being waited for — measured, it decides at
# 0.51s on a local trace that ramps to 0.93s. The `--delta-budget` is not usable
# at all: it is OPTIONAL on `fd-budget.sh` and it is a caller-supplied flag, so
# reading it here would be a seam — a caller could widen the warm-up's tolerance
# by passing a larger budget, which is the quiet-for-the-wrong-reason failure
# #89 is about.
#
# Reading `growth` as the span's own rise collapses the ratio to an absolute
# allowance, and the collapse is the derivation rather than a side effect:
#
#     rise <= FDV_SLACK + FDV_TOL_PCT/100 x rise
#  ⟺  rise <= FDV_SLACK / (1 - FDV_TOL_PCT/100)
#  ⟺  rise <= 200 / 0.9 = 222 descriptors per settle span
#
# 222 is not a second constant. It is this file's own FDV_SLACK and FDV_TOL_PCT
# composed, it moves when either moves, and a test asserts that it does.
#
# MEASURED, and the honest shape of the property: the two do NOT always agree, and
# the residual is bounded and safe. Sweeping FDV_TOL_PCT over 0/2/5/10/20/40 and
# ramp rates from 150 to 500 fds/s in steps of 25, the band of rates at which the
# warm-up opens a window the verdict then REFUSES slides with the allowance:
#
#   FDV_TOL_PCT  allowance  disagreeing rates   top edge / allowance
#        0         200       150 175 200              1.00
#        2         204       150 175 200 225         1.10
#        5         210       150 175 200 225         1.07
#       10         222       150 175 200 225         1.01
#       20         250            225 250 275         1.10
#       40         333                   325 350      1.05
#
# Two things follow, and both are asserted in fd-budget-script.test.ts. The band
# MOVES with the constant, which is the "together, not independently" half, and a
# decoupled constant cannot do that. And its top edge never exceeds ~1.1x the
# allowance, which bounds the cost: a disagreeing run DECLINES rather than
# misreporting, because the script only prints a growth figure when this file says
# settled. Against the control -- a hand-picked 500 per span -- the same sweep
# disagrees at 250 and 400 fds/s, up to 1.8x the allowance the verdict grants.
# That is the shape of the bug #89 warns about: quiet for the wrong reason.
#
# WHY THE TWO MUST AGREE, stated as the property rather than the arithmetic. The
# window the warm-up opens has to be one the verdict will accept. If the warm-up
# is LOOSER than the verdict, it opens a window whose opening decile is still
# inside the ramp and the run declines — the exact defect #89 exists to fix, and
# it would be back with a better message. If the warm-up is TIGHTER, it waits
# past the point the verdict would already be satisfied and charges the wait to
# the blind spot instead of to the ramp: the gate goes quiet for a reason that is
# not the one it reports. The safe direction is therefore "never looser", and
# that is what makes the shared constants load-bearing rather than decorative —
# one edit to FDV_TOL_PCT moves both decisions together, and there is no
# combination of the two in which they can disagree.
#
# THE LEAK THIS COSTS, because a longer window is a bigger hole. A leak is only
# swallowed if it climbs faster than 222 descriptors per settle span — 222 fds/s
# here — AND the warm-up has not yet reached its cap. The measured leak rate is
# 4.8 fds/s on the CI cli leg (861 descriptors over 178s) and 5.8 fds/s locally
# (1015 over 174.6s), so reaching the threshold takes a leak 38x the measured
# rate. Above the threshold the leak keeps the count climbing, so the warm-up
# never resolves and the run reaches the CAP and reports the new state — a
# refusal, not a pass. That is what makes the cap part of the safety argument
# rather than a politeness bound, and it is why the cap is held well below the
# point where a swallowed leak could exceed the growth budget (see the cap
# derivation in `fd-budget.sh`).

# Floor percentile. 10 keeps the lowest tenth of the window — the part a ramp
# can still occupy at the window's opening — out of the floor definition.
FDV_FLOOR_PCTL=10

# Fraction of growth the floor-to-probe deficit may reach before the baseline is
# called unsettled, in percent (integer arithmetic, no float in the gate).
#
# DERIVED, not chosen. For a window that is a steady leak from a settled floor,
# p10 of the window sits 10% of the way up and the probe 1% of the way up, so
# the deficit is 9% of the window's spread against a growth of 90% of it — a
# ratio of 0.100 analytically. Measured across 30 combinations of leak size
# (500-20000), window length (100/412/1500) and plateau (3433/3966), the largest
# deficit/growth ratio observed was 0.1003 and NO steady leak was ever called
# unsettled. On the reference run the ratio was 0.000, because that leg's leak
# does not begin until the third decile; 0.100 is the worst case, not the
# typical one.
#
# FORCED FROM ABOVE, and only from above. An earlier revision of this comment
# claimed 10 was "forced from both sides", which was half false and worth
# correcting precisely because #86 was caused by a number that looked derived
# and was not:
#
#   TOL > 10   too much of a front-loaded leak is tolerated and it is reported
#              as a passing number (see the limit above). The bound is tight:
#              at TOL=5 a front-loaded 2054-descriptor leak is refused, at TOL=10
#              it is reported and passes. So the ceiling on this constant is
#              what sets it, and it is close.
#   TOL < 10   the claim that this also protects a steady leak is NOT true. The
#              margin is the ADDITIVE FDV_SLACK, not a ratio, so lowering TOL
#              does not monotonically endanger a leak: at TOL=0 a steady
#              2042-descriptor leak is still `settled` (deficit 184 against a
#              bare 200 allowance). TOL only starts refusing steady leaks once
#              0.1 x growth exceeds that allowance, i.e. above ~2200
#              descriptors of growth — measured at TOL=0, where a steady
#              20000-descriptor leak IS refused.
#
# So: 10 is correct, and the upper bound is what forces it. The lower margin
# against sampling noise is FDV_SLACK's job, not this constant's.
#
# IT IS ALSO THE WARM-UP'S TOLERANCE, and that is a second reason it must not be
# retuned in isolation: `fd_budget_warmup` below composes this constant with
# FDV_SLACK, and #89's trap is a gate that declines for a different reason than
# the one it reports. See "THE WARM-UP, AND WHY IT SHARES THIS FILE'S
# TOLERANCE" above.
FDV_TOL_PCT=10

# Absolute allowance, in descriptors, on top of FDV_TOL_PCT% of growth. It
# exists so that a window whose growth is ~0 is not called unsettled by its own
# sampling noise: with no growth there is nothing to be ambiguous about, and the
# verdict must stay a plain pass rather than flip to `unmeasured` on a few
# descriptors of jitter. 200 is ~5.8% of the measured 3433 plateau — large
# against sampler noise, far below the 815-deficit of a ramp occupying the
# first 30% of the window on the CI run that failed.
#
# IT ALSO SETS THE SMALLEST LEAK THIS GATE CAN SEE, which is the consequence
# that is easy to miss and is stated here so the number is not read as only a
# noise allowance. A leak that completes inside the window's opening tenth
# reaches the plateau before p10 does, so p10 returns the plateau and the leak
# is charged NOTHING. Measured, on a 412-sample window:
#
#   front-loaded leak of 220  ->  deficit 199, growth 0, settled yes  ->  PASS
#
# 220 descriptors of leak, entirely invisible, and `growth 0` is the most
# confident possible lie this gate can tell. FDV_SLACK is therefore not only a
# noise allowance; it is the detectability floor, and the two uses are the same
# number for the same reason — both are "how much departure from the floor can
# this gate absorb before it has to admit it saw something".
#
# IT IS ALSO THE WARM-UP'S ALLOWANCE, through FDV_TOL_PCT: the warm-up's
# tolerance is FDV_SLACK / (1 - FDV_TOL_PCT/100), which is 222 per settle span.
# So the smallest leak this gate can see is unchanged by #89 in kind — it is now
# "222 per second of settle span" rather than "220 inside the window's opening
# tenth" — and the numbers are close enough that the change does not widen it.
FDV_SLACK=200

# Number of leading samples, as a percentage of the window, that the opening
# probe is taken over. A tenth of the window is ~10-14s at the achieved poll
# rate (596-623 samples over ~97-100s locally, i.e. ~160ms; 137ms on CI), which
# is long enough for p10 to mean something and short enough to precede the leak
# on every measured leg — the cli leg's first three deciles sit flat at the
# plateau, which is why a decile-wide probe reads the baseline rather than the
# leak.
FDV_PROBE_SPAN_PCT=10

# Width of the window the WARM-UP asks its settledness question over, as a
# percentage of the minimum warm-up. This is a SPAN, not a tolerance: it is the
# same quantity FDV_PROBE_SPAN_PCT expresses, and it is the one new number in
# #89's change. See "THE WARM-UP SPAN" below for why a span is unavoidable at
# all, and why this one is bounded from above by the local leg's own margin.
#
# 50 of a 2s minimum warm-up is 1s, and 1s is bounded on both sides by
# MEASUREMENT, not by taste:
#
# BELOW it must not exceed the margin the minimum warm-up already carries, or
#   the local leg's own window moves and its growth figure changes. Measured on
#   this host: the ramp's last rise is the sample at t+0.93s, so a 2s warm-up
#   carries ~1.07s of margin, and 1.0s fits inside it with the window still
#   opening at the minimum. Anything above ~1.07s extends the local window.
#
# ABOVE it must be short enough that the rule still HOLDS against the measured CI
#   ramp. The effective allowance is FDV_SLACK / (1 - FDV_TOL_PCT/100) = 222 per
#   span, so a 1s span tolerates a climb of 222 fds/s, and the measured CI runner
#   climbs at 995-1051, which clears that by 4.5-4.7x. A 0.2s span would
#   tolerate 1110 and would NOT hold on the runner this gate is measured against,
#   which is what bounds it from above.
#
# AND THE PRICE, measured rather than assumed. Two things narrow what this span
# buys, and both are properties of sampling rather than of the rule:
#
#   1. The samples inside a 1s span cover only ~0.89s of it at CI's 128ms poll
#      interval, so the effective rate threshold is ~250 fds/s rather than 222.
#   2. Sweeping the real shape -- the same ~3973 climb at rates from 150 to 500
#      fds/s over a 178s window -- the rule produces a settled verdict at rates
#      at or above 500, reports the capped state at 250-400, and DECLINES at or
#      below 222. So the working band is a module-load pace of ~500 fds/s and up,
#      the measured CI runner is 2.0x above its floor, and this host's ~3700 is
#      7.4x. Below ~500 fds/s the run declines, which is the pre-#89 behaviour
#      and the safe direction: nothing is misreported, the growth budget simply
#      does not apply. That is a real limit of this change, not a caveat on it.
# shellcheck disable=SC2034  # read by fd-budget.sh, which shellcheck does not follow
FDV_WARMUP_SETTLE_PCT=50

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

# fd_budget_warmup <stamps-file> <settle-span-ms>
#
# "Is the ramp over?", decided over the span that just elapsed. Sets, in the
# caller's scope:
#
#   fdw_n          samples inside the settle span (2 or more means it can be
#                  decided at all — the same `> 1` rule the window needs)
#   fdw_rise       max - min of those samples: the descriptors the count rose
#                  across the span, which is the warm-up's `deficit`
#   fdw_growth     fdw_rise itself — see the derivation for why the warm-up
#                  cannot name any other growth, and why substituting one is a
#                  defect rather than an improvement
#   fdw_tol        the verdict's own formula, FDV_SLACK + FDV_TOL_PCT% of
#                  fdw_growth. Composes to FDV_SLACK / (1 - FDV_TOL_PCT/100)
#   fdw_settled    1 iff fdw_rise <= fdw_tol
#
# The stamps file is "<elapsed-ms> <count>" per line, in poll order — the same
# two files the production script hands to `fd_budget_verdict`, plus a time
# axis, because the settle span is measured in seconds and a sample index is
# not a duration (at CI's 128ms poll interval a decile of the trace is a
# different number of seconds than it is on this host, and that is the whole
# defect).
#
# Returns 0 always: it decides, it does not enforce. The caller applies the cap
# and the minimum, because those are wall-clock bounds on the run and not
# properties of the samples.
fd_budget_warmup() {
  local stamps="$1" span_ms="$2"
  local ms count last=-1 cut=0 lo='' hi='' i
  local -a tms=() cnt=()

  fdw_n=0
  fdw_rise=0
  fdw_growth=0
  fdw_tol=0
  fdw_settled=0

  while read -r ms count; do
    tms+=("$ms")
    cnt+=("$count")
  done <"$stamps"

  [ "${#tms[@]}" -gt 0 ] || return 0
  last="${tms[${#tms[@]} - 1]}"
  cut=$((last - span_ms))

  for i in "${!tms[@]}"; do
    [ "${tms[$i]}" -ge "$cut" ] || continue
    fdw_n=$((fdw_n + 1))
    if [ -z "$lo" ] || [ "${cnt[$i]}" -lt "$lo" ]; then lo="${cnt[$i]}"; fi
    if [ -z "$hi" ] || [ "${cnt[$i]}" -gt "$hi" ]; then hi="${cnt[$i]}"; fi
  done
  [ "$fdw_n" -gt 0 ] || return 0

  fdw_rise=$((hi - lo))
  fdw_growth="$fdw_rise"
  fdw_tol=$((FDV_SLACK + FDV_TOL_PCT * fdw_growth / 100))
  # One sample cannot describe a span. This is the same minimum the verdict
  # applies to a window (`fdv_n > 1`), not a third tuned number: a warm-up that
  # decided from a single sample would be reading a difference between two
  # consecutive polls, which on a slow runner is a handful of descriptors.
  if [ "$fdw_n" -gt 1 ] && [ "$fdw_rise" -le "$fdw_tol" ]; then
    # shellcheck disable=SC2034  # outputs of this sourced function, read by fd-budget.sh
    fdw_settled=1
  fi
  return 0
}
