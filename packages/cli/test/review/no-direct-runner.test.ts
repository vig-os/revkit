// Every git call from the review path must route through the
// hardened wrapper (`runSafeGit` / `runSafeGitOrThrow`). A direct
// `runner(...)` or `spawnGit(...)` invocation would bypass
// `core.hooksPath=/dev/null`, `protocol.file.allow=never`,
// `core.attributesFile=/dev/null`, and the rest of the config
// overrides — quietly re-opening the exact attack surfaces ADR-0025
// closes.
//
// This test greps the review source and refuses any call to `runner(`
// or a `spawnGit(` that isn't inside `git-safe.ts` itself.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, test } from "bun:test";

/** Files under review/ whose git access is intentionally direct
 * (only `git-safe.ts` itself). */
const ALLOWLISTED_FILES: ReadonlySet<string> = new Set([
  "git-safe.ts",
]);

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      yield* walkTs(abs);
    } else if (st.isFile() && extname(abs) === ".ts") {
      yield abs;
    }
  }
}

describe("review/*.ts — every git call routes through the hardened wrapper", () => {
  test("no direct `runner(` or `spawnGit(` outside git-safe.ts", () => {
    const reviewSrc = join(import.meta.dirname!, "..", "..", "src", "review");
    const offenders: { file: string; line: number; text: string }[] = [];
    for (const abs of walkTs(reviewSrc)) {
      const base = abs.slice(reviewSrc.length + 1);
      if (ALLOWLISTED_FILES.has(base)) continue;
      const source = readFileSync(abs, "utf8");
      const lines = source.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        // Ignore lines inside a `//` comment.
        const codeSlice = line.split("//")[0] ?? "";
        // A bare `runner(` at a call position — `.runner(` (method
        // call), `= runner`, `type runner` and `readonly runner`
        // are all fine.
        if (/(^|[^.\w])runner\(/.test(codeSlice)) {
          offenders.push({ file: base, line: i + 1, text: line });
        }
        if (/(^|[^.\w])spawnGit\(/.test(codeSlice)) {
          offenders.push({ file: base, line: i + 1, text: line });
        }
      }
    }
    if (offenders.length > 0) {
      // Render a specific message so the reviewer sees which line
      // to fix.
      const report = offenders
        .map((o) => `${o.file}:${o.line}: ${o.text.trim()}`)
        .join("\n");
      throw new Error(
        `Found direct git-runner calls outside the safe wrapper (route through runSafeGit / runSafeGitOrThrow):\n${report}`,
      );
    }
    expect(offenders.length).toBe(0);
  });
});
