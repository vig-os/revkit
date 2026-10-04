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
// matching budget with margin, and each is one to three orders of magnitude
// under the leg's own 4454 peak / 1021 growth. The headroom being spent is
// 1800 - 1284 = 516 of growth on CI and 8192 - 4695 = 3497 of peak, against
// perturbations of at most TRANSIENT_BURST below.

/** Transient size for the peak-only test, against its ceiling of 3. A `bash`
 * process holds ~7 descriptors on its own, so 3 fails on the shell alone with
 * no burst at all — which is the point: the ceiling must not need a leak to
 * demonstrate it bites. */
const CEILING_TEST_CEILING = 3;
const CEILING_BURST = 60;

/** A steady planted leak of ~480 over 8s, ~320 of it post-warm-up, against a
 * budget of 60. Wide enough that the verdict cannot depend on poll timing. */
const LEAK_TEST_BUDGET = 60;

/** A step inside the measurement window, against a budget of 40.
 *
 * Two constraints make this deterministic rather than racy, and both were found
 * the hard way. First, the burst is ONE `exec` with 51 redirections rather than
 * 51 `exec` calls: the loop form takes ~1.5s under load, which pushed the
 * pre-burst portion past p10's 10% exclusion and made the floor land on the low
 * samples — the run then reported growth 240 and failed, intermittently, on the
 * same box minutes apart. Second, the burst fires 0.15s after the warm-up
 * expires, so the low portion is ~3% of the window whether or not a poll lands
 * in it.
 *
 * Must exceed TRANSIENT_BUDGET for `max - min` to have failed on it (that is
 * the whole point), and stay under FDV_SLACK so the settled verdict is a clean
 * pass: 51 <= 200, which is the assertion the test then makes exactly. */
const TRANSIENT_BURST = 51;
const TRANSIENT_BUDGET = 40;

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
    const child = `for _ in $(seq 1 ${CEILING_BURST}); do exec {fd}>/dev/null; done
sleep 3
`;
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

  test("verdict: a step inside the window is absorbed by the floor, not charged as growth", async () => {
    // #86 end to end, and the sharpest form of it: the reported growth must be
    // ZERO, not merely under budget. The window opens on a process holding ~7
    // descriptors and 0.15s later the same process holds ~56. Under `max - min`
    // those low samples define the floor and growth reads ~49 against a budget
    // of 40 — a false failure. Under p10 they cannot, so growth is 0.
    //
    // A weaker "did not exceed the budget" assertion would pass even if the
    // floor were wrong, which is why this one is exact. The complementary
    // deterministic proof that `max - min` does fail on this shape is in the
    // arithmetic suite above, where the same trace is available to both
    // statistics.
    const child = `sleep 2.15
eval "exec $(i=10; while [ $i -le $((10 + TRANSIENT_BURST - 1)) ]; do printf '%d</dev/null ' "$i"; i=$((i+1)); done)"
sleep 6
`;
    const r = await runScript(1_000_000, TRANSIENT_BUDGET, child);
    expect(r.output).not.toContain("FAILED");
    expect(r.output, r.output).toContain("baseline settled: yes");
    expect(r.output, `the low samples defined the floor:\n${r.output}`).toContain(
      `growth 0 (budget ${TRANSIENT_BUDGET})`,
    );
    expect(r.code, r.output).toBe(0);
  }, 90_000);

  test("the failure message reports the numbers and does not assert a cause", async () => {
    const child = `for _ in $(seq 1 ${CEILING_BURST}); do exec {fd}>/dev/null; done
sleep 3
`;
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
    // The seam has to be unabusable, so assert the absence of the shapes that
    // would make it abusable: a way to feed the gate numbers, and a way to skip
    // the check. If a future revision adds one, this fails.
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
