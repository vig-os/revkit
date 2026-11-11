// Manual full-renderer probe; recovery timings deliberately exclude rendering.
// nix develop -c bun packages/cli/bench/provenance-scaling.ts
import { renderProvenance, recoverLegacyAnchor } from "../src/serve/source-provenance.ts";
import { alignLeaf } from "../src/text-provenance.ts";
import { revisionOf } from "@revkit/review-core";

for (const ch of ["*", "[", "."]) {
  const medians: number[] = [];
  for (const size of [10_000, 20_000, 40_000, 80_000]) {
    const source = ch.repeat(size) + " tail...";
    const visible = (ch === "." ? "…" : ch.repeat(size)) + " tail…";
    const times: number[] = [];
    for (let i = 0; i < 9; i++) {
      const before = performance.now();
      if (!alignLeaf(source, visible, 0)) throw new Error("Mapping unexpectedly refused");
      times.push(performance.now() - before);
    }
    medians.push(times.sort((a, b) => a - b)[4]!);
  }
  console.info(`align ${ch} 10k/20k/40k/80k ms: ${medians.map((n) => n.toFixed(3)).join(" / ")}`);
}
const medians: number[] = [];
for (const size of [10_000, 20_000, 40_000, 80_000]) {
  const source = "x\n".repeat(size / 2);
  const rendered = await renderProvenance("/repo", "docs/probe.md", source);
  const anchor = { path: "docs/probe.md", startLine: 1, endLine: 1, revision: await revisionOf(source), quote: { exact: "x", prefix: "", suffix: "" } };
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const before = performance.now();
    const recovered = recoverLegacyAnchor(rendered, source, anchor);
    times.push(performance.now() - before);
    if (recovered?.quote.exact !== "x" || recovered.startLine !== 1 || recovered.endLine !== 1) throw new Error("Recovery changed source bounds");
  }
  medians.push(times.sort((a, b) => a - b)[1]!);
}
console.info(`legacy real-renderer 10k/20k/40k/80k ms: ${medians.map((n) => n.toFixed(3)).join(" / ")}`);
