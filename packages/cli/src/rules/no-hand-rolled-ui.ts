// no-hand-rolled-UI (C1, ADR-0005).
//
// Two allowlists, both case-insensitive:
//
//   1) A component-shaped file — `.astro .tsx .jsx .vue .svelte
//      .html .htm` — is only allowed under one of the registered UI
//      directories (`packages/components/src/`, `site/src/components/`,
//      `site/src/pages/`, `site/src/layouts/`). Test files (`*.test.*`)
//      are exempt so a UI unit test can live next to its module.
//
//   2) A JavaScript / TypeScript module (`.js .jsx .ts .tsx .mjs
//      .cjs .mts .cts`) inside a content directory is a violation —
//      content is data, not code. `docs/` and `site/src/content/`
//      carry MDX prose and typed data files (YAML/JSON), never a
//      module that would run at load or ship JS.
//
// Case-insensitivity matches how the OS resolves these paths on
// macOS/Windows — an author who sneaks in `Component.TSX` would run
// on the reviewer's Linux CI but bypass a case-sensitive rule.

import { extname } from "node:path";
import type { Diagnostic } from "../diagnostics.ts";

/** Component-shaped file extensions this rule refuses outside the
 * allowlisted UI trees. Every popular UI-source extension so a future
 * dependency on Vue or Svelte does not silently open a hole. */
const UI_EXTENSIONS: ReadonlySet<string> = new Set([
  ".astro",
  ".htm",
  ".html",
  ".jsx",
  ".svelte",
  ".tsx",
  ".vue",
]);

/** JavaScript / TypeScript module extensions that content directories
 * refuse. `.ts` is included — a `.ts` module inside `docs/` is a code
 * smuggler regardless of whether it imports UI. */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

/** Path prefixes (repo-relative, POSIX, trailing slash) where UI
 * files are allowed to live. Exposed for the PR body and docs — "the
 * exact allowlist" the plan asks for. Case-insensitive prefix check. */
export const UI_ALLOWED_PREFIXES: readonly string[] = [
  "packages/components/src/",
  "site/src/components/",
  "site/src/layouts/",
  "site/src/pages/",
];

/** Path prefixes where a code module is out of place: content is data.
 *
 * `docs/` — top-level repo docs (ADRs, designs, feature matrix).
 * `site/src/content/docs/` — rendered MDX/Markdown pages Starlight
 *   builds. Sibling directories under `site/src/content/` (`loaders/`,
 *   `schemas/`, `utils/`, `i18n/`) are Astro content-collection
 *   infrastructure — TypeScript modules that MUST live there for
 *   Astro's `defineCollection` to pick them up; they are not content
 *   themselves and are legitimately code. */
const CONTENT_DIR_PREFIXES: readonly string[] = [
  "docs/",
  "site/src/content/docs/",
];

/** Compare `haystack` against `needle` prefix, case-insensitively. */
function startsWithCI(haystack: string, needle: string): boolean {
  if (haystack.length < needle.length) return false;
  return haystack.slice(0, needle.length).toLowerCase() === needle.toLowerCase();
}

/** Is `posixRepoRelative` a UI test file? Only `.test.[jt]sx?` counts
 * — a plain-text `.test.md` still trips branch C so tests can not
 * hide inside a content directory. */
function isTestFile(posixRepoRelative: string): boolean {
  return /(^|\/)([^/]+\.)?test\.[jt]sx?$/i.test(posixRepoRelative);
}

/** Is `posixRepoRelative` ANY test file (`.test.*`)? Broader than the
 * UI exemption above — used by branch C to catch `docs/foo.test.md`
 * and friends. */
function isAnyTestFile(posixRepoRelative: string): boolean {
  return /(^|\/)[^/]+\.test\.[^/]+$/i.test(posixRepoRelative);
}

/** Is this file's path under one of the allowed UI prefixes? */
export function isUnderAllowedUIPath(posixRepoRelative: string): boolean {
  return UI_ALLOWED_PREFIXES.some((prefix) => startsWithCI(posixRepoRelative, prefix));
}

/** Is this file inside a content directory? */
function isUnderContentDir(posixRepoRelative: string): boolean {
  return CONTENT_DIR_PREFIXES.some((prefix) => startsWithCI(posixRepoRelative, prefix));
}

/** Check one file. Returns 0 or 1 diagnostics per rule branch. */
export function checkNoHandRolledUiFile(posixRepoRelative: string): Diagnostic[] {
  const ext = extname(posixRepoRelative).toLowerCase();
  const findings: Diagnostic[] = [];

  // Branch A: component-shaped file outside allowed UI trees.
  if (UI_EXTENSIONS.has(ext) && !isTestFile(posixRepoRelative)) {
    if (!isUnderAllowedUIPath(posixRepoRelative)) {
      findings.push({
        file: posixRepoRelative,
        line: 0,
        rule: "no-hand-rolled-ui",
        message: `UI file (${ext}) must live under one of: ${UI_ALLOWED_PREFIXES.join(", ")} (ADR-0002, ADR-0005). Move the file or file a component-request issue (revkit escalate).`,
      });
    }
  }

  // Branch B: code module inside a content directory.
  if (CODE_EXTENSIONS.has(ext) && !isTestFile(posixRepoRelative)) {
    if (isUnderContentDir(posixRepoRelative)) {
      findings.push({
        file: posixRepoRelative,
        line: 0,
        rule: "no-hand-rolled-ui",
        message: `code module (${ext}) inside a content directory (${CONTENT_DIR_PREFIXES.find((p) => startsWithCI(posixRepoRelative, p))}) — content is data, not code (ADR-0002, ADR-0003).`,
      });
    }
  }

  // Branch C: test file under a content dir — content is data, tests
  // don't belong there. Catches every `*.test.*` (not just the UI
  // exempt from branch B), so `docs/foo.test.md` fails too
  // (round-3 nit).
  if (isAnyTestFile(posixRepoRelative) && isUnderContentDir(posixRepoRelative)) {
    findings.push({
      file: posixRepoRelative,
      line: 0,
      rule: "no-hand-rolled-ui",
      message: `test file inside a content directory — move tests out of ${CONTENT_DIR_PREFIXES.find((p) => startsWithCI(posixRepoRelative, p))} (ADR-0003).`,
    });
  }

  return findings;
}
