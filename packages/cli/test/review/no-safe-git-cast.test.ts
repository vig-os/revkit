// Refuses `as SafeGitRunner` (or `as unknown as SafeGitRunner`)
// anywhere outside `git-safe.ts`. The compile-time nominal brand +
// the runtime `assertSafeGitRunner` cover accidental fakes and
// pure-`any` forgeries; this test closes the last hole (a caller
// that casts a raw `GitRunner` into `SafeGitRunner` without
// wrapping) at authoring time.
//
// The runtime check would still refuse the forged value, but a
// review that flagged a cast in the diff catches it in code
// review rather than at execution.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, test } from "bun:test";

/** File that's PERMITTED to construct a SafeGitRunner. */
const ALLOWED: ReadonlySet<string> = new Set(["git-safe.ts"]);

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      yield* walkTs(abs);
    } else if (st.isFile() && (extname(abs) === ".ts" || extname(abs) === ".tsx")) {
      yield abs;
    }
  }
}

describe("`as SafeGitRunner` casts are refused outside git-safe.ts", () => {
  test("no `as SafeGitRunner` outside the constructor module", () => {
    const srcRoot = join(import.meta.dirname!, "..", "..", "src");
    const offenders: { file: string; line: number; text: string }[] = [];
    for (const abs of walkTs(srcRoot)) {
      const base = abs.slice(srcRoot.length + 1);
      // The one file allowed to construct SafeGitRunner is
      // `review/git-safe.ts`.
      if (base.endsWith("/git-safe.ts") && ALLOWED.has("git-safe.ts")) continue;
      const source = readFileSync(abs, "utf8");
      const lines = source.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        // Ignore comment lines.
        const codeSlice = line.split("//")[0] ?? "";
        if (/\bas\s+SafeGitRunner\b/.test(codeSlice)) {
          offenders.push({ file: base, line: i + 1, text: line });
        }
      }
    }
    if (offenders.length > 0) {
      const report = offenders.map((o) => `${o.file}:${o.line}: ${o.text.trim()}`).join("\n");
      throw new Error(
        `Found \`as SafeGitRunner\` casts outside git-safe.ts — use wrapSafeGitRunner() instead:\n${report}`,
      );
    }
    expect(offenders.length).toBe(0);
  });
});
