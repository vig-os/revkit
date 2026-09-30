// The core's public entry must build for `--target=browser` with no
// externals (ADR-0025). Bun's browser target rejects `node:*` imports at
// bundle time and cannot resolve `bun:*` modules, so a successful build
// is a end-to-end proof that the surface is runtime-neutral — the
// complement to the specifier-scanning test in `src-imports.test.ts`.
//
// Uses `Bun.build` (Bun-native) rather than shelling out to `bun build`,
// so the assertion is against a structured result and the failure names
// each unresolved import.
import { describe, expect, test } from "bun:test";

const ENTRY = new URL("../src/index.ts", import.meta.url).pathname;

describe("bun build — browser target", () => {
  test("bundles src/index.ts for the browser target without errors", async () => {
    const result = await Bun.build({
      entrypoints: [ENTRY],
      target: "browser",
      // No externals: everything the package uses (zod) must inline for
      // the browser target, or the test fails, which is the point.
    });
    if (!result.success) {
      const messages = result.logs.map((log) => log.message ?? String(log)).join("\n");
      throw new Error(`browser build failed:\n${messages}`);
    }
    expect(result.outputs.length).toBeGreaterThan(0);
    const [entry] = result.outputs;
    expect(entry).toBeDefined();
    // A non-trivial bundle is proof the entry was reached; an empty
    // output would be a silent no-op.
    if (entry) {
      const bytes = await entry.arrayBuffer();
      expect(bytes.byteLength).toBeGreaterThan(0);
    }
  });
});
