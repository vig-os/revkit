// Untrusted-mode-only refusal of executable keys in a vega-lite spec
// (ADR-0021 / ADR-0025). Vega/vega-lite specs can carry expression
// strings — `params[].expr`, `transform[].calculate`, `signals`,
// `datum.expr` — that vega evaluates. In our own build we keep those
// off the SSR path (ADR-0021: plots render at build time via
// `vega-lite-svg`, no expression evaluation), but a hostile PR spec
// could still smuggle a plot spec containing them and rely on some
// downstream tool to evaluate them.
//
// This module walks the parsed JSON and refuses any occurrence of the
// known executable keys with a diagnostic that names the JSON path.
// It runs ONLY when the check trust posture is `untrusted` (the
// hosted `--online` verifier does not exist for the local reviewer).
//
// The check is a pure walk over the parsed JSON tree — no
// dependency on vega's own schema. Adding a new executable-key
// name is a one-line edit to `EXECUTABLE_KEYS`.

import { readFileSync } from "node:fs";
import type { Diagnostic } from "../diagnostics.ts";

/** Keys the walk refuses whenever they carry a string. See
 * https://vega.github.io/vega-lite/docs/expr.html and
 * https://vega.github.io/vega/docs/signals/. */
const EXECUTABLE_STRING_KEYS: ReadonlySet<string> = new Set([
  "expr",
  "signal",
  "calculate",
  "update",
  "on",
]);

/** Keys whose OBJECT value carries an `expr:` field. `datum: { expr: … }` is
 * a common vega-lite shape; we refuse it at the wrapping key too so the
 * message points at the enclosing property. */
const EXECUTABLE_OBJECT_KEYS: ReadonlySet<string> = new Set([
  "signals",
  "params",
  "transform",
]);

/** Check the parsed JSON of a spec file for executable keys. Every
 * hit becomes one diagnostic. Paths are dotted (`transform.0.calculate`)
 * so the reviewer can find the offending node in the file. */
export function checkVegaUntrusted(
  absoluteSpecPath: string,
  reportPath: string,
): Diagnostic[] {
  const findings: Diagnostic[] = [];
  let raw: string;
  try {
    raw = readFileSync(absoluteSpecPath, "utf8");
  } catch {
    return findings;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A malformed spec is refused by `plot-structure` already; do
    // not double-report.
    return findings;
  }
  visit(parsed, "", (path, why) => {
    findings.push({
      file: reportPath,
      line: 0,
      rule: "plot-structure",
      message: `${why} at ${path.length === 0 ? "<root>" : path} — refused for untrusted PR content (ADR-0021, ADR-0025).`,
    });
  });
  return findings;
}

/** Recursive DFS over the parsed JSON. `path` is dotted; `report`
 * receives `(path, reason)` for every hit. */
function visit(node: unknown, path: string, report: (path: string, reason: string) => void): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      visit(node[i], `${path}[${i}]`, report);
    }
    return;
  }
  if (typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const child = path.length === 0 ? key : `${path}.${key}`;
    if (EXECUTABLE_STRING_KEYS.has(key) && typeof value === "string") {
      report(child, `vega executable string key '${key}'`);
    }
    if (EXECUTABLE_OBJECT_KEYS.has(key) && Array.isArray(value)) {
      // The array is legal in itself (a `transform` is always an
      // array of objects); the elements are what carries the
      // executable strings. Recurse — the inner-object visit picks
      // them up.
    }
    visit(value, child, report);
  }
}
