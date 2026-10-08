import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { parseMarkdownBlocks } from "@revkit/review-core/markdown-blocks";
import { prepareSegmentation } from "@revkit/review-core/block-preparation";
import { scanAllForbidden, startWorker } from "./harness.ts";

test("Markdown parser entry bundles without host imports and runs in local workerd", async () => {
  // Bun's in-process build inherits the test loader's development condition.
  // A fresh production process uses the same conditions as a shipped bundle.
  // this selects micromark's runtime-neutral default rather than debug/Electron.
  const directory = mkdtempSync(join(tmpdir(), "revkit-block-bundle-"));
  let script: string;
  try {
    const build = Bun.spawn([process.execPath, "build", new URL("./fixtures/markdown-blocks-probe.ts", import.meta.url).pathname, "--target", "browser", "--production", "--conditions", "workerd", "--conditions", "worker", "--outdir", directory], { stdout: "pipe", stderr: "pipe", env: { ...process.env, NODE_ENV: "production" } });
    const [exit, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    expect(stderr).not.toContain("error:");
    expect(exit).toBe(0);
    script = await Bun.file(join(directory, "markdown-blocks-probe.js")).text();
  } finally { rmSync(directory, { recursive: true, force: true }); }
  expect(scanAllForbidden(script)).toEqual([]);
  expect(script).not.toMatch(/(?:@astrojs|packages\/cli|from\s*["'](?:node:|bun:))/);
  const harness = await startWorker({ script });
  try {
    for (const source of ["## Heading\r\nBody\r\n\r\n- first\r\n- second", "| a | b |\n| --- | --- |\n| c | d |\n\n$$\nx\n$$", "x́ !", "слово كلمة शब्द 中文 👩‍💻 café"]) {
      const response = await harness.mf.dispatchFetch("http://localhost/blocks", { method: "POST", body: source });
      expect(response.status).toBe(200);
      const body = await response.json() as { map: unknown; boundaries: { grapheme: number[]; interior: number[]; end: number[] }; safe: boolean };
      expect(body.map).toEqual(await parseMarkdownBlocks(source));
      const tables = prepareSegmentation(source.replace(/\r\n?/g, "\n"));
      expect(body.boundaries).toEqual({ grapheme: [...tables.graphemeBoundary], interior: [...tables.wordInterior], end: [...tables.wordEnd] });
      if (source === "x́ !") expect(body.safe).toBe(false);
    }
  } finally { await harness.mf.dispose(); }
});
