// Issue #86: tests for `scripts/fd-budget.sh`'s OWN decision logic.
//
// WHY THIS FILE EXISTS. `fd-budget.test.ts` covers the per-cycle leak rate and
// this process's absolute ceiling. Nothing covered the script that decides CI:
// its arithmetic and its four verdicts had no test at all, which is how
// `growth = max - min` survived long enough to mis-fire on healthy runs (#86 —
// CI run 37214081546 attempt 1 reported growth 4006 against a budget of 1800
// with floor 689 against a plateau of 3403, on a commit that measured 1632 when
// re-run, with all 1368 tests passing).
//
// THE SEAM, and why there is no flag. `scripts/fd-budget-verdict.sh` holds the
// verdict as a pure function of two sample files; `fd-budget.sh` calls it, and
// so do these tests. There is deliberately NO `--samples-from` flag and no
// environment variable for feeding the gate numbers: a gate that accepts
// injected samples on a settable input is a gate that can be silenced, and this
// one cannot be. `BUDGET_*` values below are passed to the script's OWN
// documented flags, so the production path is exercised end to end — see
// `assertNoSilencingSeam`, which fails if a bypass-shaped flag ever appears.
//
// TWO KINDS OF TEST HERE, and what each is for. The `verdict()` tests drive the
// pure function over synthetic sample traces, so the arithmetic is asserted
// exactly and deterministically — including the reconstructed #86 failure and
// the planted leak. The `runScript()` tests spawn the REAL script over a REAL
// child process, so the wiring, the four verdicts and the failure message are
// covered end to end. A statistic proven only by inspection, or a gate whose
// tests never run the gate, is exactly what #86 was.
//
// Linux-gated with a written reason, same convention as `fd-budget.test.ts`:
// the script needs /proc/<pid>/fd and `bash`'s `exec {fd}>`.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

const hasProcFd = process.platform === "linux";

const REPO_ROOT = resolvePath(import.meta.dirname!, "..", "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "fd-budget.sh");
const VERDICT_LIB = join(REPO_ROOT, "scripts", "fd-budget-verdict.sh");

/** The growth budget `justfile.project` sets for every non-Playwright leg.
 * Mirrored rather than read from the justfile because parsing `justfile.project`
 * to assert a shell constant would be a worse test than stating the number it
 * has to hold. `EXPECTED_DELTA_BUDGET` below pins that the justfile still says
 * this, so the two cannot drift apart unnoticed. */
const DELTA_BUDGET = 1800;

/** The absolute ceiling the same file sets for the same legs. */
const CEILING = 8192;

// THESE TESTS PERTURB THE MEASUREMENT THEY LIVE INSIDE, and that is a real
// constraint rather than an incidental one. `scripts/fd-budget.sh` measures the
// descriptor count of the whole process TREE, and these tests run inside
// `bun test`, which is that tree — so every descriptor an end-to-end child opens
// is a descriptor the cli leg's own growth and peak count. An earlier revision of
// this file opened 3000 of them and the cli leg reported peak 9499 / growth
// 6022 against a budget of 1800: this file was the leak it was written to detect.
//
// So every burst below is the SMALLEST that still drives its verdict past the
// matching budget with margin, and each is orders of magnitude under the leg's
// own ~4450 peak / ~970 growth. The headroom being spent is 1800 - 1284 = 516 of
// growth on CI and 8192 - 4695 = 3497 of peak, against a perturbation of
// SETTLED_BURST below — the only burst this file still opens.
//
// A second, larger burst (51) used to sit here for a test of a step inside the
// measurement window. It was CUT rather than repaired, and the reason is worth
// recording because it is the failure mode this file already hit once: all four
// of its assertions passed whether or not the burst fired, because `growth 0`
// and `baseline settled: yes` are both what a child that opens NOTHING also
// produces. Deleting the burst line left the test green. A test that cannot fail
// when its subject is removed is not worth a 24-second window, and its property
// is already proven deterministically in the arithmetic suite above.

/** Transient size for the peak-only test, against its ceiling of 3.
 *
 * NO BURST. A bare `bash` child of this script already peaks at 4-5
 * descriptors, so a ceiling of 3 fails on the shell alone — which is the
 * point being made, and an earlier revision of this test opened 60 more to
 * "prove" it, which drove nothing and contradicted the note above about every
 * burst being the smallest that carries its verdict. */
const CEILING_TEST_CEILING = 3;

/** A steady planted leak of ~480 over 8s, ~320 of it post-warm-up, against a
 * budget of 60. Wide enough that the verdict cannot depend on poll timing. */
const LEAK_TEST_BUDGET = 60;

/** A count still climbing when the measurement window opens, sized so the
 * settledness test refuses it.
 *
 * The MEASURED deficit is 520, not `SETTLED_BURST - 7`. The ×2 is real and is
 * the same close-on-exec-false inheritance this file documents below: `exec
 * {fd}>` opens the descriptors without O_CLOEXEC, so the child's own `sleep`
 * inherits all 260 and the poller's whole-tree walk counts them twice —
 * 260 + 260 + the shell's own 7. Two earlier revisions of this comment said
 * `SETTLED_BURST - 7` and then "~253", both of which are the arithmetic before
 * the doubling was understood; the figure that matters is the measured one.
 *
 * 520 sits against a tolerance of `FDV_SLACK` (200) plus 10% of a growth that is
 * ~0 once the count is flat, i.e. ~200: a 320-descriptor margin, and an EXACT
 * one because the deficit is set by the burst size rather than by poll timing.
 * It has to exceed ~208 to fire at all, which is why it is not a small number.
 *
 * Opened with `exec {fd}>` in a loop rather than one `eval exec N</dev/null`:
 * the loop form is both faster (220 descriptors in 4ms measured) and lifts a
 * far higher ceiling, where a single `eval exec` aborts bash above ~240 with a
 * heap corruption on this host. */
const SETTLED_BURST = 260;

/** A verdict output, or `""` for one the library left UNSET.
 *
 * The empty case is kept distinct on purpose. `fd_budget_verdict` leaves every
 * window figure UNSET when growth is unmeasured, and coercing that to a number
 * would turn "not measured" into a confident 0 — which is exactly the mistake
 * #86 is about, one level down. */
type Maybe = number | "";

interface Verdict {
  polls: Maybe;
  n: Maybe;
  peak: Maybe;
  windowPeak: Maybe;
  floor: Maybe;
  probe: Maybe;
  growth: Maybe;
  deficit: Maybe;
  measured: Maybe;
  settled: Maybe;
  noSamples: Maybe;
}

/** Every name `fd_budget_verdict` sets, as (TypeScript key, shell variable).
 * Declared once so the probe script, the parser and the library cannot
 * disagree about a name — a mismatch here reads as an empty string, which
 * `Number("")` would then silently turn into 0. */
const VERDICT_KEYS: [keyof Verdict, string][] = [
  ["polls", "fdv_polls"],
  ["n", "fdv_n"],
  ["peak", "fdv_peak"],
  ["windowPeak", "fdv_window_peak"],
  ["floor", "fdv_floor"],
  ["probe", "fdv_probe"],
  ["growth", "fdv_growth"],
  ["deficit", "fdv_deficit"],
  ["measured", "fdv_measured"],
  ["settled", "fdv_settled"],
  ["noSamples", "fdv_no_samples"],
];

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "revkit-fd-verdict-"));
  roots.push(root);
  return root;
}

function writeLines(path: string, values: number[]): string {
  writeFileSync(path, values.map((v) => `${v}\n`).join(""));
  return path;
}

/** A sample trace: a module-load plateau, optionally a ramp, then a leak.
 *
 * `ramp` is the fraction of the window spent climbing from `low` to `plateau`
 * instead of sitting at it — the #86 shape. `leak` is the descriptor rise over
 * the remainder. `lowSamples` injects isolated low samples, which is how the
 * poller's own first sample (measured at 3 against a plateau of 3433) puts a
 * single catastrophic value at the bottom of a healthy window. */
function trace(opts: {
  n: number;
  plateau: number;
  leak: number;
  ramp?: number;
  low?: number;
  lowSamples?: number;
}): number[] {
  const { n, plateau, leak, ramp = 0, low = plateau, lowSamples = 0 } = opts;
  const values: number[] = [];
  for (let i = 0; i < lowSamples && i < n; i++) values.push(low);
  const rest = n - values.length;
  const rampLen = Math.round(rest * ramp);
  for (let i = 0; i < rampLen; i++) {
    values.push(Math.round(low + ((plateau - low) * i) / rampLen));
  }
  const tail = rest - rampLen;
  for (let i = 0; i < tail; i++) {
    values.push(Math.round(plateau + (leak * i) / tail));
  }
  return values;
}

/** Run the real verdict function over a trace, in bash, and parse its outputs.
 *
 * Spawning bash rather than re-implementing the percentile in TypeScript is the
 * point: the arithmetic under test is shell, and a TypeScript copy would pass
 * while the gate the CI actually runs did something else. */
async function verdict(samples: number[], raw: number[] = samples): Promise<Verdict> {
  const dir = scratch();
  const rawPath = writeLines(join(dir, "raw"), raw);
  const samplesPath = writeLines(join(dir, "samples"), samples);
  const probe = join(dir, "probe.sh");
  // Every name is pre-assigned before the library is sourced, because bash's
  // indirect expansion `${!v}` has no `${!v:-}` form: the library leaves
  // fdv_floor/probe/growth/deficit UNSET when growth is unmeasured, and
  // `set -u` would abort the probe rather than report them as empty.
  const shellNames = VERDICT_KEYS.map(([, shell]) => shell);
  writeFileSync(
    probe,
    `#!/usr/bin/env bash
set -uo pipefail
${shellNames.map((n) => `${n}=`).join(" ")}
. ${JSON.stringify(VERDICT_LIB)}
fd_budget_verdict "$1" "$2"
for v in ${shellNames.join(" ")}; do
  printf '%s=%s\\n' "$v" "\${!v}"
done
`,
  );
  const proc = Bun.spawn(["bash", probe, rawPath, samplesPath], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr, `the verdict probe wrote to stderr:\n${stderr}`).toBe("");
  expect(code).toBe(0);
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const parsed: Verdict = {
    polls: 0,
    n: 0,
    peak: 0,
    windowPeak: 0,
    floor: "",
    probe: "",
    growth: "",
    deficit: "",
    measured: 0,
    settled: 0,
    noSamples: 0,
  };
  for (const [key, shell] of VERDICT_KEYS) {
    const raw = out[shell];
    parsed[key] = raw === undefined || raw === "" ? "" : Number(raw);
  }
  return parsed;
}

/** The OLD statistic, `max - min`, recomputed here from the same trace.
 *
 * Kept in the test on purpose. Every regression assertion below is a claim
 * about the DIFFERENCE between the two statistics, and a test that only knew
 * the new one could not make that claim — it would pass just as well if the
 * defect were still there. */
function oldGrowth(samples: number[]): number {
  return Math.max(...samples) - Math.min(...samples);
}

// ---------------------------------------------------------------------------
// #89 — the ADAPTIVE WARM-UP. Same seam discipline as the verdict above: the
// production decision is driven through the real `fd_budget_warmup` and
// `fd_budget_verdict` in bash, over the same two files the poller writes, in
// the same order it writes them. Nothing here re-implements the arithmetic.
// ---------------------------------------------------------------------------

/** A time-stamped trace: `[elapsed-ms, count]` per poll, in the poller's order. */
type Stamp = [number, number];

/** The poll interval and ramp shape MEASURED on CI run 37258522674, and the
 *  shapes derived from it.
 *
 *  The CI numbers are not copied from a local run and hoped over. `probe` is p10
 *  of the window's first DECILE, which on that run is 140 samples at 127.7ms
 *  (1406 polls over 179.6s) — so it is the count at t=3.664s — and `floor` is
 *  the plateau. For a linear ramp, `probe/floor = (3.664-t0)/(T-t0)`, and the
 *  three recorded CI runs solve to a ramp ending at 4.08s, 4.12s and 4.19s.
 *  Those are the numbers `CI_RAMP_END` and `CI_PLATEAU` carry, and the plateau
 *  is the measured p10 floor of 3973 to 3971 to 3966. */
const CI_POLL_MS = 127.7;
const CI_PLATEAU = 3973;
const CI_RAMP_END = 4.08;
const CI_LEAK = 861;
/** The window growth the same run reported: peak 4834 against floor 3973. */
const CI_WINDOW = 178;

/** A trace: a linear climb to `plateau` ending at `rampEnd` seconds after `t0`,
 *  then flat, with a leak of `leak` descriptors accumulating linearly from
 *  `leakFrom` to the end of the run.
 *
 *  `leakFrom` is the parameter the swallowed-leak case turns: set it earlier than
 *  `rampEnd` and the leak starts while the extended warm-up is still waiting, so
 *  the trace carries both at once. */
function stamped(opts: {
  rampEnd: number;
  plateau: number;
  dur: number;
  pollMs?: number;
  t0?: number;
  leak?: number;
  leakFrom?: number;
}): Stamp[] {
  const { rampEnd, plateau, dur, pollMs = CI_POLL_MS, t0 = 0.2 } = opts;
  const leakFrom = opts.leakFrom ?? rampEnd;
  const leak = opts.leak ?? 0;
  const rows: Stamp[] = [];
  for (let ms = 20; ms < dur * 1000; ms += pollMs) {
    const s = ms / 1000;
    let v = s <= rampEnd ? Math.max(3, (plateau * (s - t0)) / (rampEnd - t0)) : plateau;
    if (s > leakFrom) {
      const span = dur - leakFrom;
      v += span > 0 ? leak * Math.min(1, (s - leakFrom) / span) : leak;
    }
    rows.push([Math.round(ms), Math.round(v)]);
  }
  return rows;
}

/** The local shape, measured on the instrumented trace in this repo: the whole
 *  ~3.4k module-load ramp inside the first five polls, ending at t+0.93s. */
const LOCAL_RAMP_END = 0.93;
const LOCAL_PLATEAU = 3433;
const LOCAL_LEAK = 1015;

/** One decision of the warm-up, plus the verdict of the window it opened.
 *
 *  `openMs` is the millisecond stamp the poller resolved the warm-up on, and the
 *  whole point of several tests below is that it is not the minimum when the
 *  ramp is stretched and is the minimum when it is not. */
interface WarmDecision {
  state: "settled" | "capped" | "too-short";
  openMs: number;
  /** The `fd_budget_warmup` outputs at the resolving poll, which are only
   *  populated when a decision was actually reached. */
  rise: number;
  tol: number;
  /** The largest rise the rule ever measured on this trace, and the allowance it
   *  granted at that poll. This is the pair that shows the formula, because the
   *  resolving poll is by construction a flat one. */
  riseMax: number;
  tolAtMax: number;
  verdict: Verdict;
}

/** Drive the REAL poller decision loop over a time-stamped trace.
 *
 *  The body below is the production subshell from `scripts/fd-budget.sh`,
 *  transcribed statement for statement and with the same two functions called in
 *  the same order. `fixedWindow` skips the warm-up entirely and opens the window
 *  at the minimum, which is what `dev` does — so every "the old way declined"
 *  assertion in this file is a measurement of the pre-#89 path rather than an
 *  argument about it. */
async function warmup(
  rows: Stamp[],
  opts: { minMs?: number; capMs?: number; settleMs?: number; fixedWindow?: boolean; lib?: string } = {},
): Promise<WarmDecision> {
  const minMs = opts.minMs ?? 2000;
  const capMs = opts.capMs ?? 10000;
  const settleMs = opts.settleMs ?? 1000;
  const dir = scratch();
  const inPath = join(dir, "in");
  writeFileSync(inPath, rows.map(([ms, n]) => `${ms} ${n}\n`).join(""));
  const rawPath = join(dir, "raw");
  const samplesPath = join(dir, "samples");
  const shellNames = VERDICT_KEYS.map(([, s]) => s);
  const probe = join(dir, "probe.sh");
  writeFileSync(
    probe,
    `#!/usr/bin/env bash
set -uo pipefail
${[...shellNames, "fdw_n", "fdw_rise", "fdw_tol"].map((n) => `${n}=`).join(" ")}
. ${JSON.stringify(opts.lib ?? VERDICT_LIB)}
in="$1"; raw="$2"; samples="$3"; min="$4"; cap="$5"; settle="$6"
warm=min
open_ms=0
rise=0
tol=0
rise_max=0
tol_at_max=0
: >"$in.work"; : >"$raw"; : >"$samples"
while read -r ms n; do
  printf '%s\n' "$n" >>"$raw"
  printf '%s %s\n' "$ms" "$n" >>"$in.work"
  if [ "$FIXED" = 1 ]; then
    if [ "$ms" -ge "$min" ]; then warm=settled; open_ms="$ms"; fi
  elif [ "$warm" = min ] && [ "$ms" -ge "$min" ]; then
    fd_budget_warmup "$in.work" "$settle"
    if [ "$fdw_rise" -gt "$rise_max" ]; then rise_max="$fdw_rise"; tol_at_max="$fdw_tol"; fi
    if [ "$fdw_settled" -eq 1 ]; then
      warm=settled
      open_ms="$ms"
      rise="$fdw_rise"
      tol="$fdw_tol"
    elif [ "$ms" -ge "$cap" ]; then
      warm=capped
      open_ms="$ms"
      rise="$fdw_rise"
      tol="$fdw_tol"
    fi
  fi
  if [ "$warm" = settled ]; then printf '%s\n' "$n" >>"$samples"; fi
done <"$in"
if [ "$warm" = min ]; then printf 'too-short %s 0 0 0 0\n' "$open_ms"; exit 0; fi
fd_budget_verdict "$raw" "$samples"
printf '%s %s %s %s %s %s\n' "$warm" "$open_ms" "$rise" "$tol" "$rise_max" "$tol_at_max"
for v in ${shellNames.join(" ")}; do printf '%s=%s\n' "$v" "\${!v}"; done
`,
  );
  const proc = Bun.spawn(
    ["bash", probe, inPath, rawPath, samplesPath, String(minMs), String(capMs), String(settleMs)],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FIXED: opts.fixedWindow ? "1" : "0" },
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr, `the warm-up probe wrote to stderr:\n${stderr}`).toBe("");
  expect(code).toBe(0);
  const lines = stdout.trim().split("\n");
  const head = (lines[0] ?? "").split(/\s+/);
  const out: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const v: Verdict = {
    polls: 0, n: 0, peak: 0, windowPeak: 0, floor: "", probe: "",
    growth: "", deficit: "", measured: 0, settled: 0, noSamples: 0,
  };
  for (const [key, shell] of VERDICT_KEYS) {
    const raw_ = out[shell];
    v[key] = raw_ === undefined || raw_ === "" ? "" : Number(raw_);
  }
  return {
    state: head[0] as WarmDecision["state"],
    openMs: Number(head[1]),
    rise: Number(head[2]),
    tol: Number(head[3]),
    riseMax: Number(head[4]),
    tolAtMax: Number(head[5]),
    verdict: v,
  };
}

/** `warmup` against a RETUNED COPY of the verdict library.
 *
 *  This is how the tolerance sweeps below move `FDV_TOL_PCT`. It exists because
 *  the constant is an unconditional assignment in the library — deliberately, so
 *  that exporting it changes nothing on the real script (#86) — which means the
 *  only honest way to exercise a different value is to edit a copy of the file
 *  the function lives in. The arithmetic under test is still the shipped shell. */
function warmupWithLib(lib: string, rows: Stamp[], opts: object = {}): Promise<WarmDecision> {
  return warmup(rows, { ...opts, lib });
}

interface RunResult {
  code: number;
  output: string;
}

/** Spawn the real `scripts/fd-budget.sh` over a real child process. */
async function runScript(
  budget: number,
  deltaBudget: number | null,
  child: string,
): Promise<RunResult> {
  const dir = scratch();
  const childPath = join(dir, "child.sh");
  writeFileSync(childPath, child);
  chmodSync(childPath, 0o755);
  const args = [SCRIPT, "--budget", String(budget)];
  if (deltaBudget !== null) args.push("--delta-budget", String(deltaBudget));
  args.push("--", "bash", childPath);
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  let output: string;
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    output = `${stdout}${stderr}`;
  } catch {
    proc.kill();
    await proc.exited;
    throw new Error("fd-budget.sh did not finish; the child or the poller hung");
  }
  return { code: await proc.exited, output };
}

describe.skipIf(!hasProcFd)("fd-budget verdict arithmetic (#86)", () => {
  test("a settled baseline with the known leak measures growth and stays settled", async () => {
    // The reference shape: 3433 plateau (measured p10 on a local cli run) and
    // 1021 of leak (the measured growth of that run).
    const v = await verdict(trace({ n: 412, plateau: 3433, leak: 1021 }));
    expect(v.measured, "a settled baseline must be measurable").toBe(1);
    expect(v.settled, "a settled baseline must not be called unsettled").toBe(1);
    expect(Number(v.growth), "growth must track the leak").toBeGreaterThan(900);
    expect(Number(v.growth), "growth must not exceed the leak planted").toBeLessThanOrEqual(1021);
    expect(Number(v.floor), "the floor is a p10, so it sits above the start").toBeGreaterThan(3433);
    // The settledness test's own margin on a steady leak, stated so a retune of
    // FDV_TOL_PCT/FDV_SLACK that blinded it would fail here.
    const tolerance = 200 + (Number(v.growth) * 10) / 100;
    expect(Number(v.deficit), `deficit must clear the tolerance of ${tolerance}`).toBeLessThan(
      tolerance,
    );
  });

  test("#86: the recorded failing run reports unmeasured, where max-min reported 4006", async () => {
    // CI run 37214081546 attempt 1, reconstructed: peak 4695, floor 689, and the
    // documented 1284 of leak above a 3403 plateau. `ramp: 0.3` is the ramp
    // still running when the warm-up expires — the shape the issue describes,
    // and the only one of the recorded runs whose reported growth (4006) is not
    // reproducible from the leak.
    const samples = trace({ n: 900, plateau: 3403, low: 689, ramp: 0.3, leak: 1284 });
    const old = oldGrowth(samples);
    expect(old, "the old statistic must reproduce the recorded false failure").toBeGreaterThan(
      DELTA_BUDGET,
    );
    const v = await verdict(samples);
    expect(v.measured, "there IS a window, so this is a settledness question").toBe(1);
    expect(v.settled, "a baseline still climbing must be called unsettled").toBe(0);
    // And the caller's consequence: no growth figure is reported, so the growth
    // budget is not applied. Asserted on the script itself, in the e2e tests.
    expect(Number(v.deficit), "the deficit must be what exposed the ramp").toBeGreaterThan(200);
  });

  test("#86: a few low samples cannot define the floor, where max-min charged them as a leak", async () => {
    // The poller's own first sample measured 3 against a plateau of 3433 on a
    // healthy local run. If such a sample lands inside the window, `min`-based
    // growth reads the whole plateau as leak.
    const samples = [
      ...trace({ n: 407, plateau: 3433, leak: 1021 }),
      3,
      3,
      3,
      3,
      3,
    ];
    expect(oldGrowth(samples), "the old statistic must charge the 3s as a leak").toBeGreaterThan(
      DELTA_BUDGET,
    );
    const v = await verdict(samples);
    expect(v.settled, "low samples in the middle do not unsettle the baseline").toBe(1);
    expect(Number(v.growth), "5 samples out of 412 must not move growth at all").toBeLessThan(1021);
  });

  test("a low prefix is reported unmeasured rather than as leak", async () => {
    // The same 3s, but at the window's OPENING — which is the ramp case, and
    // the two must not be conflated. Floor cannot exclude them (they are the
    // first 10% of the window at p10), so the honest answer is to decline.
    const samples = [3, 3, 3, 3, 3, ...trace({ n: 407, plateau: 3433, leak: 1021 })];
    expect(oldGrowth(samples)).toBeGreaterThan(DELTA_BUDGET);
    const v = await verdict(samples);
    expect(v.settled, "a ramp at the window's opening must be called unsettled").toBe(0);
  });

  test("a ramp p10 absorbs is still refused, because the opening probe sees it", async () => {
    // Two mechanisms, and they compose into one property: wherever the p10 floor
    // fails to absorb a ramp, the probe refuses to report. At a tenth of the
    // window p10 DOES absorb it — the floor is sound and the growth figure would
    // be correct — and the probe still calls the baseline unsettled. So there is
    // no ramp fraction this gate confidently reports as leak growth.
    const tenth = await verdict(trace({ n: 900, plateau: 3403, low: 689, ramp: 0.1, leak: 1284 }));
    expect(tenth.floor, "p10 excludes a ramp over a tenth of the window").toBeGreaterThan(3300);
    expect(tenth.growth, "so the growth figure reads the leak, not the ramp").toBeLessThanOrEqual(1320);
    expect(tenth.settled, "but the probe still refuses to report it").toBe(0);

    const quarter = await verdict(trace({ n: 900, plateau: 3403, low: 689, ramp: 0.25, leak: 1284 }));
    expect(quarter.settled, "a ramp over a quarter of the window is not settled either").toBe(0);
    expect(Number(quarter.deficit), "and the deficit is what exposed it").toBeGreaterThan(200);
  });

  test("a planted leak on a settled baseline still trips the growth budget", async () => {
    // The property a naive "make the floor robust" fix silently destroys: a
    // p10 floor that is too high stops seeing a real leak.
    const leak = await verdict(trace({ n: 412, plateau: 3433, leak: 1021 }));
    const doubled = await verdict(trace({ n: 412, plateau: 3433, leak: 2042 }));
    expect(Number(leak.growth), "the single leak is under budget").toBeLessThanOrEqual(DELTA_BUDGET);
    expect(leak.settled, "the single leak is a settled baseline").toBe(1);
    expect(
      Number(doubled.growth),
      "a DOUBLING of the leak must clear the budget, or the gate is blind to the regression it exists for",
    ).toBeGreaterThan(DELTA_BUDGET);
    expect(doubled.settled, "a doubled leak must not be mistaken for an unsettled baseline").toBe(1);
  });

  test("a settled baseline with no leak measures zero growth", async () => {
    const v = await verdict(trace({ n: 412, plateau: 3433, leak: 0 }));
    expect(v.settled, "no growth means nothing to be ambiguous about").toBe(1);
    expect(Number(v.growth)).toBe(0);
  });

  test("fewer than two post-warm-up samples is unmeasured, not a confident figure", async () => {
    const v = await verdict([3433]);
    expect(v.measured, "one sample is not a window").toBe(0);
    expect(v.floor, "and no floor is invented for it").toBe("");
    const empty = await verdict([], []);
    expect(empty.noSamples, "no polls at all is its own state").toBe(1);
  });

  test("zeros in the window would poison the floor — which is why the poller drops them", async () => {
    // The poller drops zero samples because "a live process always holds at
    // least fds 0/1/2", so a zero means the process is gone. Under `min` one
    // trailing zero collapsed growth onto the peak; under p10 it takes more than
    // 10% of the window to do the same, but it still does, so the drop remains
    // load-bearing rather than historical.
    const samples = [0, ...trace({ n: 270, plateau: 3433, leak: 1021 }), ...new Array(140).fill(0)];
    const v = await verdict(samples);
    expect(Number(v.floor), "a poisoned floor reads 0").toBe(0);
    expect(Number(v.growth), "and growth collapses onto the peak").toBe(Number(v.windowPeak));
  });
});

describe.skipIf(!hasProcFd)("fd-budget adaptive warm-up (#89)", () => {
  // ---- failure mode 1: a ramp that ENDS within the cap, and the number must
  // not move on a local-shaped trace ---------------------------------------
  test("a local-shaped ramp settles at the minimum and reports the fixed-2s figure exactly", async () => {
    const rows = stamped({
      rampEnd: LOCAL_RAMP_END, plateau: LOCAL_PLATEAU, dur: 20, pollMs: 190,
      leak: LOCAL_LEAK,
    });
    const adaptive = await warmup(rows);
    const fixed = await warmup(rows, { fixedWindow: true });

    // The whole point of keeping the minimum at 2s: a dev box must not notice.
    expect(
      adaptive.openMs,
      "the warm-up must resolve at the 2s minimum, not after the ramp plus a settle span",
    ).toBeLessThan(2000 + 400);
    expect(Number(adaptive.verdict.settled), "and the verdict must be settled").toBe(1);
    for (const field of ["floor", "probe", "deficit", "growth"] as const) {
      expect(
        Number(adaptive.verdict[field]),
        `the ${field} moved on a local-shaped trace`,
      ).toBe(Number(fixed.verdict[field]));
    }
    // Pinning the number too, so a retune that happens to move both cannot slip
    // through the comparison above. ~861 is what the same shape yields; the real
    // local leg measures 1015 over a longer run.
    expect(Number(adaptive.verdict.growth)).toBeGreaterThan(800);
    expect(Number(adaptive.verdict.growth)).toBeLessThanOrEqual(LOCAL_LEAK);
  });

  // ---- the defect itself: the CI ramp, and what the fixed window did with it
  test("a CI-paced ramp ends inside the cap and reports a figure where a fixed 2s declines", async () => {
    const rows = stamped({
      rampEnd: CI_RAMP_END, plateau: CI_PLATEAU, dur: CI_WINDOW, leak: CI_LEAK,
    });
    // PRE-#89 behaviour, measured on the same trace: the window opens at 2s with
    // the count at ~1790 against a plateau of 3973, and the settledness test
    // refuses. This is the CI symptom, reproduced deterministically.
    const fixed = await warmup(rows, { fixedWindow: true });
    expect(Number(fixed.verdict.settled), "a fixed 2s window must still decline on this shape").toBe(0);
    expect(
      Number(fixed.verdict.deficit),
      "and it must decline for the ramp reason, past the tolerance",
    ).toBeGreaterThan(200);

    const adaptive = await warmup(rows);
    expect(adaptive.state, "the ramp ends at 4.08s, well inside the 10s cap").toBe("settled");
    expect(
      adaptive.openMs,
      "and the window opens only after the ramp plus one settle span",
    ).toBeGreaterThanOrEqual(CI_RAMP_END * 1000);
    expect(Number(adaptive.verdict.settled), "so the verdict must accept it").toBe(1);
    expect(Number(adaptive.verdict.growth), "and report the leak").toBeGreaterThan(700);
    expect(Number(adaptive.verdict.growth)).toBeLessThanOrEqual(CI_LEAK);
  });

  // ---- failure mode 2: a ramp that does NOT end within the cap -----------
  test("a ramp that does not end within the cap reaches the cap, not a window", async () => {
    // 3973 descriptors over 13.2s = 300 fds/s, which is above what one 1s
    // settle span tolerates (222, and the samples inside a 1s span cover only
    // ~0.89s of it at CI's 128ms poll interval, so the effective threshold is
    // ~250). The ramp is still climbing at the 10s cap.
    const rows = stamped({ rampEnd: 3973 / 300, plateau: 3973, dur: 12 });
    const capped = await warmup(rows);
    expect(capped.state).toBe("capped");
    expect(capped.openMs, "the cap is reached, not passed").toBeGreaterThanOrEqual(10000);
    // No window means no window figures. `unmeasured`, not a confident zero.
    expect(Number(capped.verdict.measured), "a capped run has no window to measure").toBe(0);
    expect(capped.verdict.floor, "so no floor is invented for it").toBe("");

    // And it must be distinguishable from a leg that was simply too short: the
    // two are different facts and #89 says so rather than merging them.
    const short = await warmup(stamped({ rampEnd: LOCAL_RAMP_END, plateau: LOCAL_PLATEAU, dur: 1.2, pollMs: 190 }));
    expect(short.state, "a leg ending inside the minimum keeps #86's own state").toBe("too-short");
    expect(Number(short.verdict.measured)).toBe(0);
  });

  // ---- failure mode 4: THE TRAP. A real leak, planted inside the extended
  // warm-up, must be charged and not absorbed. --------------------------------
  test("#89: a leak starting inside the extended warm-up is charged, not absorbed", async () => {
    const clean = stamped({ rampEnd: CI_RAMP_END, plateau: CI_PLATEAU, dur: CI_WINDOW, leak: CI_LEAK });
    // The same shape with #88's leak — 60 fds/s, ~480 over the run, of which
    // PR #88's own test catches ~320 at a budget of 60 — planted at t+2.5s,
    // i.e. INSIDE the 2.06s-to-4.88s span the extended warm-up waits through.
    const leaky = stamped({
      rampEnd: CI_RAMP_END, plateau: CI_PLATEAU, dur: CI_WINDOW,
      leak: CI_LEAK + 480, leakFrom: 2.5,
    });

    const without = await warmup(clean);
    const with_ = await warmup(leaky);
    expect(
      with_.openMs,
      "the leak must NOT extend the warm-up: 60 fds/s is 60 per settle span against an allowance of 222",
    ).toBe(without.openMs);
    const delta = Number(with_.verdict.growth) - Number(without.verdict.growth);
    expect(
      delta,
      `the leak was absorbed by the extended warm-up — growth moved by only ${delta}`,
    ).toBeGreaterThan(300);
    // And the pre-#89 path on the same trace declines, which is what makes this
    // a RED case rather than a description: the fixed window is measured here,
    // not argued about.
    const fixed = await warmup(leaky, { fixedWindow: true });
    expect(Number(fixed.verdict.settled), "a fixed 2s window declines on this trace").toBe(0);
  });

  test("#89: a leak fast enough to extend the warm-up runs into the cap, not a pass", async () => {
    // The other half of the same question. Above 222 per settle span a leak DOES
    // keep the warm-up waiting, and then it has not stopped by the cap — so the
    // run declines loudly instead of reporting a window the leak has emptied.
    // 900 fds/s of leak from t+0.5s, which never lets a settle span go quiet.
    const rows: Stamp[] = [];
    for (let ms = 20; ms < 12_000; ms += CI_POLL_MS) {
      rows.push([Math.round(ms), Math.round(3 + (900 * ms) / 1000)]);
    }
    const d = await warmup(rows);
    expect(d.state, "an endless climb cannot settle, so the cap is the honest answer").toBe("capped");
    expect(Number(d.verdict.measured), "and no growth figure is invented").toBe(0);
  });

  // ---- THE OTHER TRAP: one tolerance, not two ----------------------------
  test("#89: the warm-up's tolerance IS the verdict's tolerance, composed", async () => {
    // A steady climb makes the ratio collapse to FDV_SLACK / (1 - FDV_TOL_PCT/100),
    // so the warm-up's allowance is a NUMBER DERIVED from the verdict's two
    // constants and not a third one an author picked. Read it back out of the
    // function rather than restating it, so a retune of either constant fails.
    // A steady 300 fds/s from t+1.2s, sampled every 250ms so the span is whole.
    // A steady 300 fds/s from t+0.5s, sampled every 250ms so the span is whole,
    // then a plateau long enough for the rule to settle on.
    const rows: Stamp[] = [];
    for (let ms = 500; ms <= 5000; ms += 250) rows.push([ms, 500 + (300 * (ms - 500)) / 1000]);
    for (let ms = 5250; ms <= 8000; ms += 250) rows.push([ms, 1700]);
    const d = await warmup(rows);
    // Read back out of the function rather than restated: the allowance the
    // warm-up grants must be FDV_SLACK + FDV_TOL_PCT% of the rise it measured.
    // The pair is the LARGEST rise it ever saw, because the poll it settles on is
    // by construction a flat one.
    expect(d.riseMax, "the largest rise over a settle span it measured").toBe(300);
    expect(d.tolAtMax, "so the allowance on it is 200 + 10% of 300").toBe(230);
    const slack = Number(/^FDV_SLACK=(\d+)$/m.exec(await Bun.file(VERDICT_LIB).text())![1]);
    const pct = Number(/^FDV_TOL_PCT=(\d+)$/m.exec(await Bun.file(VERDICT_LIB).text())![1]);
    expect(d.tolAtMax, "which is the verdict's own formula over the span's own rise").toBe(
      slack + Math.floor((pct * d.riseMax) / 100),
    );
    // And the collapsed form of that same formula, which is what makes the
    // allowance one number rather than two: rise <= slack/(1 - pct/100).
    expect(Math.floor(slack / (1 - pct / 100)), "the collapsed allowance at the boundary").toBe(222);
  });

  test("#89: the two tolerances move together, and the band they leave is bounded", async () => {
    // THE PROPERTY #89 NAMES, in the form it is actually true. The claim is NOT
    // "they can never disagree" — they cannot, quite: there is a band of ramp
    // rates just under the warm-up's own allowance where the warm-up opens the
    // window and the verdict then refuses it. What has to hold is that the band
    // (a) MOVES with the allowance as FDV_TOL_PCT moves, and (b) never reaches a
    // ramp rate meaningfully above it.
    //
    // Both halves are measured here. The table is what this sweep produced, so a
    // retune that decouples the two fails rather than passes:
    //
    //   FDV_TOL_PCT   allowance   ramp rates that disagree    top edge / allowance
    //        0          200        150  175  200                       1.00
    //        2          204        150  175  200  225                  1.10
    //        5          210        150  175  200  225                  1.07
    //       10          222        150  175  200  225                  1.01   <- shipped
    //       20          250             225  250  275                  1.10
    //       40          333                    325  350               1.05
    //
    // The whole band slides upward as the constant rises — that is the "together,
    // not independently" half, and it is what a decoupled constant cannot do. And
    // its top edge never exceeds ~1.1x the allowance, which bounds the cost of
    // disagreeing: a disagreeing run DECLINES, never misreports, because the
    // script only prints growth when `fdv_settled` is 1. So the residual band is
    // the pre-#89 behaviour on runners whose module-load pace is that slow, and
    // the measured CI runner is 4x above the top of it.
    const src = await Bun.file(VERDICT_LIB).text();
    const slack = Number(/^FDV_SLACK=(\d+)$/m.exec(src)![1]);
    const dir = scratch();
    const bands: number[][] = [];
    for (const tol of [0, 2, 5, 10, 20, 40]) {
      const lib = join(dir, `verdict-${tol}.sh`);
      writeFileSync(lib, src.replace(/^FDV_TOL_PCT=.*$/m, `FDV_TOL_PCT=${tol}`));
      const allowance = Math.floor(slack / (1 - tol / 100));
      const band: number[] = [];
      for (let rate = 150; rate <= 500; rate += 25) {
        const d = await warmupWithLib(lib, stamped({ rampEnd: 3973 / rate, plateau: 3973, dur: 40 }));
        if (d.state === "settled" && Number(d.verdict.settled) === 0) band.push(rate);
      }
      expect(band.length, `no disagreement at all at FDV_TOL_PCT=${tol}: the sweep found nothing`).toBeGreaterThan(0);
      expect(
        Math.max(...band) / allowance,
        `at FDV_TOL_PCT=${tol} (allowance ${allowance}) the warm-up settled while the count was ` +
          `climbing well above its own tolerance, which is the failure #89 names`,
      ).toBeLessThan(1.25);
      bands.push(band);
    }
    // And the band must SLIDE, not sit still. A tolerance that never moved the
    // warm-up's decision would mean the warm-up is not reading FDV_TOL_PCT at
    // all, which is the same bug from the other side.
    const first = bands[0]!;
    const last = bands[bands.length - 1]!;
    expect(
      Math.min(...last),
      "the disagreement band did not move up with the allowance, so the warm-up is not reading FDV_TOL_PCT",
    ).toBeGreaterThan(Math.max(...first));
  }, 120_000);

  test("#89: a SECOND, hand-picked constant breaks exactly that bound", async () => {
    // The control, and the reason the test above is not vacuous: an author-picked
    // 500-per-span allowance instead of the composed 222 settles the window while
    // the count is climbing at 250 and 400 fds/s — up to 1.8x the tolerance the
    // verdict will grant — and the run then declines for a reason it does not
    // report. A decoupled constant does not fail loudly; it makes the gate quiet
    // for the wrong reason, which is precisely what #90 exists to make visible.
    const dir = scratch();
    const lib = join(dir, "verdict-decoupled.sh");
    const src = await Bun.file(VERDICT_LIB).text();
    writeFileSync(lib, src.replace(/^  fdw_tol=\$\(\(FDV_SLACK.*$/m, "  fdw_tol=500"));
    const allowance = Math.floor(200 / (1 - 10 / 100));
    const offenders: number[] = [];
    for (const rate of [250, 400]) {
      const d = await warmupWithLib(lib, stamped({ rampEnd: 3973 / rate, plateau: 3973, dur: 40 }));
      if (d.state === "settled" && Number(d.verdict.settled) === 0) offenders.push(rate);
    }
    expect(offenders, "the decoupled tolerance was supposed to break the bound").toEqual([250, 400]);
    expect(
      Math.max(...offenders) / allowance,
      "and to break it by a margin the shipped rule keeps to 1.25x",
    ).toBeGreaterThan(1.25);
  });

  // ---- the seam, restated for the new inputs ------------------------------
  test("the warm-up has no flag, no environment variable and no default-from-env", async () => {
    const source = await Bun.file(SCRIPT).text();
    // The two numbers that decide everything stay literals. A `${VAR:-default}`
    // form is the shape a bypass would take, and `${VAR}` with no default is the
    // shape that fails closed when the variable is unset.
    expect(source).toMatch(/^warmup_seconds=2$/m);
    expect(source).toMatch(/^warmup_cap_seconds=\d+$/m);
    // Exactly one assignment each, and neither reads the environment. The
    // `${warmup_seconds}` interpolations in the message are reads of the literal
    // and are fine; what must not exist is a second assignment, or a
    // `${VAR:-default}` / `${VAR-default}` shape, which is how a bypass arrives.
    expect(source.match(/^warmup_seconds=/gm)?.length, "warmup_seconds must be assigned exactly once").toBe(1);
    expect(source.match(/^warmup_cap_seconds=/gm)?.length, "the cap must be assigned exactly once").toBe(1);
    for (const shape of [/warmup_seconds=\$\{/, /warmup_cap_seconds=\$\{/, /\$\{warmup_seconds:-/, /\$\{warmup_seconds-/]) {
      expect(source.match(shape), `scripts/fd-budget.sh gained an input: ${shape}`).toBeNull();
    }
    // The production call site, with no branch around it — the same assertion
    // #86 makes for the verdict, extended to the warm-up decision.
    expect(source).toContain('fd_budget_warmup "$stamps" "$warmup_settle_ms"');
    expect(source).toContain('fd_budget_verdict "$raw" "$samples"');
    // And nothing reads an environment variable at all. `FDV_*` are unconditional
    // assignments in the library, so exporting them cannot move the real script —
    // which is why `warmupWithLib` above has to edit a COPY of the library rather
    // than set a variable, and why this assertion can be about the script alone.
    for (const leak of [/getenv/, /\$\{FDV_/, /\$\{WARMUP/, /\$\{FDB_/]) {
      expect(source.match(leak), `scripts/fd-budget.sh reads ${leak} from the environment`).toBeNull();
    }
  });

  test("#89: a short leg keeps #86's own state, and the cap state is NOT that state", async () => {
    // FAILURE MODE 3, and the decision it asks for. A leg whose last poll falls
    // inside the minimum warm-up keeps `too short to measure` rather than becoming
    // the new cap state, and the reason is that the two assert different things.
    //
    // `too short` says "this leg produced no window" — a fact about the LEG, and
    // it is still exactly what happened. "The ramp did not settle within the cap"
    // says something about the RAMP, and a leg that ended inside the minimum gave
    // no evidence about the ramp either way: it may never have started. Folding
    // it in would print a claim about the runner on every one of the three legs
    // that finish in under two seconds (`packages/review-core` at 520ms,
    // `site/schemas` at 117ms, `just/check` at ~2s), which is where the message
    // would be least true.
    const short = await warmup(stamped({ rampEnd: LOCAL_RAMP_END, plateau: LOCAL_PLATEAU, dur: 1.2, pollMs: 190 }));
    expect(short.state).toBe("too-short");
    expect(Number(short.verdict.measured), "a short leg has no window to measure").toBe(0);
    // The cap state, by contrast, is only reachable once the minimum has elapsed.
    const capped = await warmup(stamped({ rampEnd: 3973 / 300, plateau: 3973, dur: 12 }));
    expect(capped.state).toBe("capped");
    expect(capped.openMs).toBeGreaterThanOrEqual(10000);
  });
});

describe.skipIf(!hasProcFd)("fd-budget verdicts, end to end over a real child (#86)", () => {
  test("verdict: pass", async () => {
    const r = await runScript(CEILING, DELTA_BUDGET, "sleep 4\n");
    expect(r.output).toContain("baseline settled: yes");
    expect(r.output).not.toContain("FAILED");
    expect(r.code, r.output).toBe(0);
    // The other half of the poller's zero-drop: on a normal run the floor is
    // strictly positive, i.e. no zero sample reached the window. Paired with the
    // synthetic-trace test that shows what >10% zeros would do to the floor.
    const floor = /floor (\d+) \(p10\)/.exec(r.output);
    expect(floor, `no floor on the summary line:\n${r.output}`).not.toBeNull();
    expect(Number(floor![1]), "a zero reached the measurement window").toBeGreaterThan(0);
  }, 60_000);

  test("verdict: absolute-ceiling failure, with growth comfortably inside its budget", async () => {
    const child = "sleep 3\n";
    const r = await runScript(CEILING_TEST_CEILING, 1_000_000, child);
    expect(r.output).toContain(`exceeds the ceiling of ${CEILING_TEST_CEILING}`);
    expect(r.output).not.toContain("descriptor growth of");
    expect(r.code, r.output).toBe(1);
  }, 60_000);

  test("verdict: growth failure — a planted leak trips the budget", async () => {
    // 3 per 50ms for 8s, of which ~two thirds lands after the warm-up. Asserted
    // against LEAK_TEST_BUDGET so the test cannot pass on timing slack alone.
    const child = `t0=$SECONDS
while [ $((SECONDS - t0)) -lt 8 ]; do
  for _ in 1 2 3; do exec {fd}>/dev/null; done
  sleep 0.05
done
sleep 2
`;
    const r = await runScript(1_000_000, LEAK_TEST_BUDGET, child);
    expect(r.output).toContain("baseline settled: yes");
    expect(r.output).toContain(`exceeds the budget of ${LEAK_TEST_BUDGET}`);
    expect(r.code, r.output).toBe(1);
  }, 60_000);

  test("#89: a ramp that never ends reaches the cap and says so — end to end", async () => {
    // THE THIRD STATE, over the real script and a real child. The child keeps a
    // descendant alive that holds 250 descriptors and then lets it go, in a loop,
    // so the whole-tree count never goes quiet for a full settle span: at any
    // moment in the last second there is either a live descendant or the tail of
    // one that has just exited. The count therefore never satisfies the warm-up's
    // test, the 10s cap fires, and no window is ever opened.
    //
    // The STAGGERED shape is the point, and it is what keeps this test cheap. A
    // short-lived descendant every 100ms, each holding 250 descriptors for
    // 250ms, puts two or three in the tree at once, so the whole-tree count
    // alternates between ~250 and ~750 and never falls back to the shell's own
    // baseline. Every settle span therefore straddles a ~250-500 descriptor step,
    // comfortably above the 222 the rule tolerates, and the warm-up can never
    // decide the count is quiet — regardless of where the poller's samples land.
    // (An earlier attempt oscillated between 257 and 7 and settled every time:
    // the 5ms gaps fell between samples, so every span saw a rise of ~7. The
    // amplitude does not help; what has to be sampled is both levels.)
    //
    // The peak stays at ~766 against this leg's own ~4450 and the window never
    // opens, so neither the peak nor the growth figure here moves. Sustaining a
    // ramp above the tolerance for the full 10s cap costs ~2200 descriptors
    // instead, and an earlier revision of this file learned the hard way that
    // spending that much pollutes the leg it lives inside.
    const child = `end=$((SECONDS + 11))
while [ "$SECONDS" -lt "$end" ]; do
  bash -c 'for i in $(seq 1 250); do exec {fd}>/dev/null; done; sleep 0.25' &
  sleep 0.1
done
wait
sleep 1
`;
    const r = await runScript(1_000_000, DELTA_BUDGET, child);
    const summary = /polls, (warm-up [^,]*), target/.exec(r.output);
    expect(summary, `no warm-up clause on the summary line:\n${r.output}`).not.toBeNull();
    expect(summary![1], "the summary must name the state, not just omit a figure").toContain(
      "DID NOT SETTLE",
    );
    expect(summary![1], "and must name the cap it reached").toContain("10s cap");
    expect(r.output).toContain("growth NOT MEASURED");
    expect(r.output).toContain("the growth budget was NOT applied to this run");
    // The state must be its OWN, and this is the anti-conflation assertion: the
    // two neighbouring states have their own wording and neither may appear.
    expect(r.output).toContain("STILL CLIMBING");
    expect(r.output).toContain("THIRD state");
    expect(r.output, "the too-short explanation must not be reused").not.toContain(
      "were taken — the leg finished inside the",
    );
    expect(r.output, "the unsettled explanation must not be reused").not.toContain(
      "had not settled when the window opened",
    );
    // It is a declined measurement, not a failure and not a pass: the ceiling
    // still applies, and that is stated.
    expect(r.output).toContain("DID apply to every sample");
    expect(r.output).toContain("NOT a pass on the leak");
    expect(r.output, "a capped run must not be reported as a failure").not.toContain("FAILED");
    expect(r.code, r.output).toBe(0);
  }, 90_000);

  test("#89: a real leak inside the extended warm-up trips the growth budget", async () => {
    // THE TRAP, end to end. STATED HONESTLY: this is a REGRESSION GUARD, not a
    // RED case — `dev` also catches this child, because at this child's gentle
    // ramp the fixed 2s window's opening probe is close enough to the floor. The
    // RED case is the CI-paced trace in the deterministic suite above, where the
    // fixed window is measured declining on the same trace the adaptive one
    // charges; and the end-to-end RED was demonstrated out of band against
    // `dev`'s own script with a CI-paced ramp, where `dev` exits 0 with
    // `deficit 390, baseline settled: no, growth unmeasured` and this script
    // exits 1 on a growth figure.
    //
    // The size is why the RED could not be pinned here rather than out of band: a
    // CI-paced ramp costs ~1800 measured descriptors inside this leg, which would
    // push the leg's OWN window peak past its 1800 growth budget and fail the
    // suite this file lives in. An earlier revision of this file opened 3000 and
    // did exactly that.
    //
    // The child climbs from t+0 so the ramp is still running when the fixed 2s
    // window opens — that is what makes the old path decline — then leaks at
    // #88's own rate (3 descriptors per 50ms) for the rest of the run. The leak is
    // far below the 222-per-settle-span the warm-up tolerates, so it must NOT
    // keep the window shut, and it must be charged once the window opens.
    //
    // SIZED AGAINST THIS FILE'S OWN BUDGET NOTE, and measured rather than
    // assumed. This child's descriptors are part of the cli leg's own tree, so a
    // child whose peak exceeds the leg's own ~4450 raises the leg's growth
    // figure directly. The first sizing of this test (12 per 100ms for 3s plus a
    // 6s leak) measured the leg at growth 1337 against 1015 without it — 322
    // descriptors of the leg's own 785-descriptor headroom, for one assertion.
    // At this size the child's whole-tree peak stays under the leg's own and the
    // measured cost is zero; the budget here is also halved, because the leak's
    // post-window share of it is what the assertion actually rests on.
    const child = `for _ in $(seq 1 26); do
  for _ in $(seq 1 6); do exec {fd}>/dev/null; done
  sleep 0.1
done
t0=$SECONDS
while [ $((SECONDS - t0)) -lt 5 ]; do
  for _ in 1 2 3; do exec {fd}>/dev/null; done
  sleep 0.05
done
sleep 2
`;
    const r = await runScript(1_000_000, LEAK_TEST_BUDGET / 2, child);
    expect(r.output, `the warm-up must not have been held shut by the leak:\n${r.output}`).toContain(
      "baseline settled: yes",
    );
    expect(r.output).toContain(`exceeds the budget of ${LEAK_TEST_BUDGET / 2}`);
    expect(r.code, r.output).toBe(1);
  }, 90_000);

  test("verdict: unmeasured — a leg that finishes inside the warm-up reports no growth figure", async () => {
    const r = await runScript(CEILING, DELTA_BUDGET, "sleep 1\n");
    expect(r.output).toContain("growth NOT MEASURED");
    expect(r.output).toContain("absolute ceiling (peak");
    expect(r.output, "unmeasured is a declined measurement, not a failure").not.toContain("FAILED");
    expect(r.code, r.output).toBe(0);
  }, 60_000);

  test("verdict: unmeasured — the absolute ceiling still bites", async () => {
    // The property that makes `unmeasured` safe: declining a growth figure must
    // not decline the ceiling with it. A leg too short to measure, against a
    // ceiling below the descriptors a `bash` process holds on its own.
    const r = await runScript(CEILING_TEST_CEILING, DELTA_BUDGET, "sleep 0.5\n");
    expect(r.output).toContain("growth NOT MEASURED");
    expect(r.output).toContain("DID apply to every sample, and it failed");
    expect(r.output).toContain(`exceeds the ceiling of ${CEILING_TEST_CEILING}`);
    // ...and the too-short case must not be handed the unsettled-baseline
    // explanation, which is a different reason to have no figure.
    expect(r.output).not.toContain("had not settled when the window opened");
    expect(r.code, r.output).toBe(1);
  }, 60_000);

  test("verdict: unsettled — a leak-shaped ramp declines rather than passing", async () => {
    // The FIFTH verdict, and the one CI's `packages/cli` leg prints on every
    // run. Until this test existed, `fd-budget.sh`'s `settled=no` branch — the
    // exact diagnostic above, with its own distinct wording from the
    // too-short branch — was never executed by any test: every other assertion
    // read the pure function's `v.settled` or grepped for an absence.
    //
    // The shape has to be one the gate REFUSES, so it is the settledness test's
    // own blind spot rather than a passing case: a count that is still climbing
    // when the window opens, by more than the tolerance. SETTLED_BURST of 260
    // produces a MEASURED deficit of 520 against a tolerance of ~200 — the ×2 is
    // the close-on-exec-false inheritance, see the constant's doc comment.
    //
    // Opened with `exec {fd}>` rather than `eval exec` because the latter aborts
    // bash above ~240 descriptors on this host (heap corruption, exit 134/139),
    // which is below what this test needs.
    const child = `sleep 2.5
for _ in $(seq 1 ${SETTLED_BURST}); do exec {fd}>/dev/null; done
sleep 24
`;
    const r = await runScript(1_000_000, DELTA_BUDGET, child);
    // THE ANTI-VACUITY ASSERTION, and it is here because this file already had
    // one test that could not fail (see the note on the burst sizes above).
    // `baseline settled: no` on its own does not prove the burst ran, because
    // the absence of any burst is not the only way to get here — so the deficit
    // is parsed and required to exceed FDV_SLACK. Without the burst line the
    // measured deficit is 0 and this fails first. Exact-number assertion would
    // be stronger still but would break on the ×2 inheritance changing; "> 200"
    // proves the subject ran without pinning the mechanism.
    const deficit = /opening probe of \d+ — a deficit of (-?\d+)/.exec(r.output);
    expect(deficit, `no deficit on the summary line:\n${r.output}`).not.toBeNull();
    expect(
      Number(deficit![1]),
      `deficit ${deficit![1]} did not exceed FDV_SLACK, so the burst did not fire:\n${r.output}`,
    ).toBeGreaterThan(200);
    expect(r.output, r.output).toContain("baseline settled: no");
    expect(r.output, r.output).toContain("had not settled when the window opened");
    expect(r.output, r.output).toContain("growth NOT MEASURED");
    // The growth budget must be explicitly NOT applied, and stated as a
    // declined measurement rather than a pass.
    expect(r.output).toContain("the growth budget was NOT applied to this run");
    expect(r.output).toContain("NOT a pass on the leak");
    // The too-short branch's wording must not be reused here: it is a
    // different reason to have no figure, and conflating them would be the
    // same class of mistake as #86's own message.
    expect(r.output).not.toContain("the leg finished inside the");
    expect(r.output, "an unsettled baseline must not be reported as a pass").not.toContain("FAILED");
    expect(r.code, r.output).toBe(0);
  }, 90_000);

  test("the failure message reports the numbers and does not assert a cause", async () => {
    const child = "sleep 3\n";
    const r = await runScript(CEILING_TEST_CEILING, 1_000_000, child);
    expect(r.output).toContain("CAUSE NOT ESTABLISHED");
    expect(r.output).toContain("bun test test/serve/fd-budget.test.ts");
    // The #86 defect in the message: it asserted a cause it had not established
    // and then contradicted itself four lines later.
    expect(r.output).not.toContain("This is the descriptor leak from issue #74");
    expect(r.output).not.toContain("it is a BUG, not a slow test");
    // #74 stays named as a real bug with its own test — just not as the answer.
    expect(r.output).toContain("#74 is a real bug");
    // A peak-only failure must not be handed the growth ambiguity paragraph,
    // which would be claiming an ambiguity it does not have.
    expect(r.output).toContain("For a peak failure the ambiguity is narrower");
    expect(r.output).not.toContain("a genuine leak and a baseline that had not finished settling");
  }, 60_000);

  test("the command's own exit status wins over any budget verdict", async () => {
    const r = await runScript(1, 1, "sleep 3\nexit 3\n");
    expect(r.code, r.output).toBe(3);
  }, 60_000);

  test("a bad budget is rejected before anything is measured", async () => {
    const r = await runScript(0, DELTA_BUDGET, "sleep 1\n");
    expect(r.code).toBe(64);
    expect(r.output).toContain("--budget must be >= 1");
  }, 30_000);

  test("no flag or environment variable can substitute samples for a measurement", async () => {
    // WHAT THIS ACTUALLY ENFORCES, stated precisely, because an earlier version
    // of this comment overclaimed. It enforces the ABSENCE of flag-shaped and
    // env-shaped bypasses — a way to hand the gate numbers, and a way to skip
    // the check — plus the PRESENCE of the production call site.
    //
    // It does NOT enforce that the verdict cannot be subverted by editing the
    // script: two assignments inserted after the call (`fdv_settled=1`,
    // `fdv_growth=0`) pass all eight regexes below AND the presence assertion,
    // and would turn a declined run into a pass. That is a code-review-visible
    // change rather than an environment bypass, which is a materially different
    // risk — but it is a real one, and claiming otherwise here would be the
    // same mistake #86 made with a number that looked derived and was not.
    //
    // The seam itself held every attack actually tried: no flag, no environment
    // variable (the `FDV_*` names are unconditional assignments in the library,
    // so exporting them changes nothing on the real script), and no PATH or cwd
    // substitution (bash resolves `BASH_SOURCE[0]` to an absolute path before
    // the library is sourced). The exit-status contract is unchanged on all four
    // paths, including a child that segfaults propagating 139.
    const source = await Bun.file(SCRIPT).text();
    for (const bypass of [
      /--samples/,
      /--input/,
      /--from-file/,
      /--no-check/,
      /--skip/,
      /--trust/,
      /FD_BUDGET_[A-Z_]*SAMPLE/,
      /getenv\(.*SAMPLE/,
    ]) {
      expect(source.match(bypass), `scripts/fd-budget.sh gained a bypass: ${bypass}`).toBeNull();
    }
    // The one input path it does have for the arithmetic is the library, and it
    // is reached with the poller's own two files.
    expect(source).toContain('fd_budget_verdict "$raw" "$samples"');
  });
});

describe("justfile budgets (#86)", () => {
  test("the growth budget is still the one this file asserts against", async () => {
    const justfile = await Bun.file(join(REPO_ROOT, "justfile.project")).text();
    expect(justfile).toContain(`test_fd_delta_budget_stable := "${DELTA_BUDGET}"`);
    expect(justfile).toContain(`test_fd_budget_stable := "${CEILING}"`);
  });
});
