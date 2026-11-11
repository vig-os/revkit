import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("the CLI prints refusal diagnostics and warning before the serving URL, then exits non-zero after stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "revkit-review-output-"));
  try {
    const preload = join(root, "dispatch.ts");
    const index = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
    const entry = fileURLToPath(new URL("../../bin/revkit.js", import.meta.url));
    writeFileSync(preload, `
      import { mock } from "bun:test";
      mock.module(${JSON.stringify(index)}, () => ({ dispatch: async () => ({
        stdout: "revkit serve: listening on http://127.0.0.1:1\\n",
        stderr: "import.refused: comment.linked (invalid-shape)\\nWARNING: 1 refused; these GitHub comments were not imported; see import.refused logs above.\\n",
        exitCode: 1,
        blockForever: new Promise<void>((resolve) => setTimeout(() => {
          process.stdout.write("daemon stopped\\n");
          resolve();
        }, 0)),
      }) }));
    `);
    // Merge the child's streams so their real write order is observable.
    const proc = Bun.spawn(["bash", "-c", 'exec bun --preload "$1" "$2" 2>&1', "--", preload, entry], {
      stdout: "pipe", stderr: "pipe",
    });
    const [output, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(1);
    expect(output).toContain("import.refused:");
    expect(output).toContain("these GitHub comments were not imported");
    expect(output).toContain("revkit serve: listening on");
    expect(output).toContain("daemon stopped");
    expect(output.indexOf("import.refused:")).toBeLessThan(output.indexOf("WARNING:"));
    expect(output.indexOf("WARNING:")).toBeLessThan(output.indexOf("revkit serve: listening on"));
    expect(output.indexOf("revkit serve: listening on")).toBeLessThan(output.indexOf("daemon stopped"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
