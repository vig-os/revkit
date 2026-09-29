// no-hand-rolled-UI (C1, ADR-0005): the only places a new
// `.astro`/`.tsx`/`.jsx` UI file may live are the component registry
// (`packages/components/src/**`) and the site's own component / page /
// layout directories (`site/src/components/**`, `site/src/pages/**`,
// `site/src/layouts/**`). Anything else — a `.astro` under `docs/`, a
// `.tsx` under `packages/cli/` — trips this rule.
//
// Test files (`*.test.ts` / `*.test.tsx`) are exempt so a schema-side
// snapshot test can render a component without moving to the components
// directory. Excluded extensions (`.d.ts`, non-UI `.ts`) are not this
// rule's concern.

import { extname } from "node:path";
import type { Diagnostic } from "../diagnostics.ts";

/** UI-shaped file extensions this rule checks. `.ts` is intentionally out
 * — a plain TS module is not UI. */
const UI_EXTENSIONS: ReadonlySet<string> = new Set([".astro", ".tsx", ".jsx"]);

/** Path prefixes (repo-relative, POSIX) where UI files are allowed to
 * live. Exposed for the PR body / docs — "the exact allowlist" the plan
 * asks for. */
export const UI_ALLOWED_PREFIXES: readonly string[] = [
  "packages/components/src/",
  "site/src/components/",
  "site/src/pages/",
  "site/src/layouts/",
];

/** Is `posixRepoRelative` a test file? Test suites are exempt so a UI
 * unit test can live next to its module. */
function isTestFile(posixRepoRelative: string): boolean {
  return /(^|\/)([^/]+\.)?test\.[jt]sx?$/i.test(posixRepoRelative);
}

/** Is this file's path under one of the allowed prefixes? */
export function isUnderAllowedUIPath(posixRepoRelative: string): boolean {
  return UI_ALLOWED_PREFIXES.some((prefix) => posixRepoRelative.startsWith(prefix));
}

/** Check one file against the no-hand-rolled-UI rule. Returns 0 or 1
 * diagnostics — the rule speaks about the file's LOCATION only, not its
 * contents. */
export function checkNoHandRolledUiFile(posixRepoRelative: string): Diagnostic[] {
  if (!UI_EXTENSIONS.has(extname(posixRepoRelative))) return [];
  if (isTestFile(posixRepoRelative)) return [];
  if (isUnderAllowedUIPath(posixRepoRelative)) return [];
  return [{
    file: posixRepoRelative,
    line: 0,
    rule: "no-hand-rolled-ui",
    message: `UI files must live under one of: ${UI_ALLOWED_PREFIXES.join(", ")} (ADR-0002, ADR-0005). Move the file or file a component-request issue (revkit escalate).`,
  }];
}
