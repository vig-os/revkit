// The core must run in Bun AND in a Cloudflare Worker AND in the browser
// (ADR-0025). To keep that promise, `src/` must not import from
// runtime-specific module namespaces: `node:*` (Node built-ins),
// `bun:*` (Bun built-ins) and DOM-only packages that ship without a
// runtime-neutral fallback. This test scans every source file's import
// specifiers and fails on any hit, so a stray `import { readFile } from
// "node:fs/promises"` tripping this test is the signal to redesign — not
// something a future adapter will "just polyfill".
//
// A companion test (`browser-build.test.ts`) verifies `bun build --target
// =browser` succeeds end-to-end, which catches the same class of import
// from the bundler side.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const SRC_DIR = new URL("../src/", import.meta.url).pathname;

/** Module specifiers with these prefixes are refused in `src/`. `node:` and
 * `bun:` are the two runtime built-in namespaces. Add a DOM-only package
 * here (e.g. `jsdom`, `happy-dom`) as one lands in the workspace — none
 * are pulled in today, so the list stays short. */
const BANNED_PREFIXES = ["node:", "bun:"] as const;

/** Captures the module specifier in `import ... from "spec"`,
 * `import "spec"`, `export ... from "spec"` and `await import("spec")`.
 * Comments are stripped first so a documentation example inside a
 * comment is not a false positive. */
const IMPORT_SPECIFIER = /(?:import|export)[^'"()]*?from\s*['"]([^'"]+)['"]|(?:^|[^.\w])import\s*['"]([^'"]+)['"]|(?:^|[^.\w])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

async function tsFilesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await tsFilesUnder(full)));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      out.push(full);
    }
  }
  return out;
}

/** Strip block and line comments so a `// import "node:foo"` in a doc
 * comment isn't miscounted. Naive but sufficient for TS source without
 * regex literals containing sequences that look like comment starts —
 * which our own source is written to avoid. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function importSpecifiers(source: string): string[] {
  const stripped = stripComments(source);
  const specs: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = IMPORT_SPECIFIER.exec(stripped)) !== null) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec !== undefined) specs.push(spec);
  }
  return specs;
}

describe("src/ imports — runtime neutrality", () => {
  test("no source file imports from a banned prefix (node:, bun:)", async () => {
    const files = await tsFilesUnder(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);
    const offenses: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const spec of importSpecifiers(source)) {
        for (const prefix of BANNED_PREFIXES) {
          if (spec.startsWith(prefix)) {
            offenses.push(`${file}: import from '${spec}'`);
          }
        }
      }
    }
    if (offenses.length > 0) {
      throw new Error(
        `src/ must be runtime-neutral (ADR-0025). Offending imports:\n  ${offenses.join("\n  ")}`,
      );
    }
  });

  test("the scanner regex actually matches import lines (guards against a silent no-op)", () => {
    const canned = [
      'import { z } from "zod";',
      "import * as x from 'node:fs';",
      'import "side-effect";',
      'const m = await import("bun:sqlite");',
      'export { foo } from "./bar.ts";',
    ].join("\n");
    const specs = importSpecifiers(canned);
    expect(specs.sort()).toEqual(
      ["./bar.ts", "bun:sqlite", "node:fs", "side-effect", "zod"].sort(),
    );
  });
});
