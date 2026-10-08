import { expect, test } from "bun:test";
import { revisionOf, type Anchor } from "@revkit/review-core";
import { recoverLegacyAnchor, renderProvenance } from "../../src/serve/source-provenance.ts";

const PATH = "docs/probe.md";
// Amortize timer/scheduler noise over >=20 ms of recovery per sample.
// The 0.1 ms denominator floor only affects very small 1x measurements.
const SAMPLE_MIN_MS = 20;
const SAMPLE_COUNT = 7;
const BASELINE_FLOOR_MS = 0.1;

function medianRecovery(run: () => ReturnType<typeof recoverLegacyAnchor>) {
  const samples: number[] = [];
  let recovered: ReturnType<typeof recoverLegacyAnchor>;
  for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
    let elapsed = 0;
    let repetitions = 0;
    do {
      const before = performance.now();
      recovered = run();
      elapsed += performance.now() - before;
      repetitions++;
    } while (elapsed < SAMPLE_MIN_MS);
    samples.push(elapsed / repetitions);
  }
  return { median: samples.sort((a, b) => a - b)[Math.floor(SAMPLE_COUNT / 2)]!, recovered };
}

for (const marker of ["- ", "> "]) test(`legacy recovery scales linearly across nesting depths: ${marker}`, async () => {
  const times: number[] = [];
  // Warm the renderer and recovery before measuring independent snapshots.
  const warm = await renderProvenance("/repo", PATH, "deep x");
  recoverLegacyAnchor(warm, "deep x", { path: PATH, startLine: 1, endLine: 1, revision: await revisionOf("deep x"), quote: { exact: "deep", prefix: "", suffix: "" } });
  for (const depth of [125, 250, 500, 1000]) {
    const source = marker.repeat(depth) + "deep x";
    const rendered = await renderProvenance("/repo", PATH, source);
    const anchor: Anchor = { path: PATH, startLine: 1, endLine: 1, revision: await revisionOf(source), quote: { exact: "deep", prefix: "", suffix: "" } };
    // Fresh identities include indexing in every repetition. Rendering stays
    // outside the measured recovery window.
    const { median, recovered } = medianRecovery(() => recoverLegacyAnchor({ ...rendered }, source, anchor));
    expect(recovered?.quote.exact).toBe("deep");
    expect([recovered?.startLine, recovered?.endLine]).toEqual([1, 1]);
    times.push(median);
    console.info(`legacy nesting ${JSON.stringify(marker)} ${depth}: median ${median.toFixed(3)} ms`);
  }
  expect(times[3]! / Math.max(times[0]!, BASELINE_FLOOR_MS)).toBeLessThanOrEqual(16);
});

test("legacy recovery scales linearly for overlapping quotes with a missing suffix", async () => {
  const times: number[] = [];
  for (const size of [10_000, 20_000, 40_000, 80_000]) {
    const source = "a".repeat(size);
    const rendered = await renderProvenance("/repo", PATH, source);
    const anchor: Anchor = { path: PATH, startLine: 1, endLine: 1, revision: await revisionOf(source), quote: { exact: "a".repeat(size / 2), prefix: "", suffix: "b" } };
    // Warm JIT paths on this shape; measure recovery, excluding rendering.
    recoverLegacyAnchor({ ...rendered }, source, anchor);
    const { median, recovered } = medianRecovery(() => recoverLegacyAnchor({ ...rendered }, source, anchor));
    expect(recovered).toBeUndefined();
    times.push(median);
    console.info(`legacy overlapping ${size}: median ${median.toFixed(3)} ms`);
  }
  expect(times[3]! / Math.max(times[0]!, BASELINE_FLOOR_MS)).toBeLessThanOrEqual(16);
});
