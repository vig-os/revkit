import { expect, test } from "bun:test";
import { revisionOf, type Anchor } from "@revkit/review-core";
import { recoverLegacyAnchor, renderProvenance } from "../../src/serve/source-provenance.ts";

const PATH = "docs/probe.md";

for (const marker of ["- ", "> "]) test(`legacy recovery scales linearly across nesting depths: ${marker}`, async () => {
  const times: number[] = [];
  // Warm the renderer and recovery before measuring independent snapshots.
  const warm = await renderProvenance("/repo", PATH, "deep x");
  recoverLegacyAnchor(warm, "deep x", { path: PATH, startLine: 1, endLine: 1, revision: await revisionOf("deep x"), quote: { exact: "deep", prefix: "", suffix: "" } });
  for (const depth of [125, 250, 500, 1000]) {
    const source = marker.repeat(depth) + "deep x";
    const rendered = await renderProvenance("/repo", PATH, source);
    const anchor: Anchor = { path: PATH, startLine: 1, endLine: 1, revision: await revisionOf(source), quote: { exact: "deep", prefix: "", suffix: "" } };
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      // A fresh snapshot identity includes the cost of building its index.
      const snapshot = { ...rendered };
      const before = performance.now();
      const recovered = recoverLegacyAnchor(snapshot, source, anchor);
      samples.push(performance.now() - before);
      expect(recovered?.quote.exact).toBe("deep");
      expect([recovered?.startLine, recovered?.endLine]).toEqual([1, 1]);
    }
    const median = samples.sort((a, b) => a - b)[1]!;
    times.push(median);
    console.info(`legacy nesting ${JSON.stringify(marker)} ${depth}: median ${median.toFixed(3)} ms`);
  }
  expect(times[3]! / times[0]!).toBeLessThanOrEqual(16);
});

test("legacy recovery scales linearly for overlapping quotes with a missing suffix", async () => {
  const times: number[] = [];
  for (const size of [10_000, 20_000, 40_000, 80_000]) {
    const source = "a".repeat(size);
    const rendered = await renderProvenance("/repo", PATH, source);
    const anchor: Anchor = { path: PATH, startLine: 1, endLine: 1, revision: await revisionOf(source), quote: { exact: "a".repeat(size / 2), prefix: "", suffix: "b" } };
    // Warm JIT paths on this shape; measure recovery, excluding rendering.
    recoverLegacyAnchor({ ...rendered }, source, anchor);
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const snapshot = { ...rendered };
      const before = performance.now();
      const recovered = recoverLegacyAnchor(snapshot, source, anchor);
      samples.push(performance.now() - before);
      expect(recovered).toBeUndefined();
    }
    const median = samples.sort((a, b) => a - b)[2]!;
    times.push(median);
    console.info(`legacy overlapping ${size}: median ${median.toFixed(3)} ms`);
  }
  expect(times[3]! / times[0]!).toBeLessThanOrEqual(16);
});
