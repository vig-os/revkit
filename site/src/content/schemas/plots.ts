// Plot spec schema (`plots/<name>/spec.vl.json`) — Vega-Lite JSON with data
// in a sibling file, never inline (ADR-0004, C4). Rendering to SVG at build
// time lives in M1 item 3; this file is the schema half only.
//
// Vega-Lite lets a `data` block appear at many depths — top-level, inside
// each `layer`, inside `concat/hconcat/vconcat/facet/spec`, and via
// `transform[].lookup.from.data`. The schema walks the whole spec and
// forbids inline `values` wherever a `data` object appears, and requires
// every `data.url` to be a bare sibling filename (no scheme, no `/`, no
// `..`). Vega-Lite grammar keys such as `format`, `name` and `sequence`
// pass through — the check is data-source shape, not Vega-Lite validation.
import { z } from "astro/zod";
import { schemaVersionField } from "./shared.ts";

const FILE_ROLE = "plots/<name>/spec.vl.json";

/** A bare sibling filename: no scheme, no absolute path, no parent-directory
 * traversal. Allows a subdirectory relative to the spec (e.g. `data/x.csv`)
 * so a plot can group its data files without escaping its own directory. */
function isSiblingFilename(url: string): boolean {
  if (url.length === 0) return false;
  if (url.startsWith("/")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false; // http:, data:, file:, …
  if (url.split("/").some((segment) => segment === "..")) return false;
  return true;
}

interface InlineDataIssue {
  path: (string | number)[];
  message: string;
}

/** Walk every level of the spec and report inline-data or non-sibling-url
 * violations wherever a `data` object appears. Iterative so a deeply nested
 * Vega-Lite spec cannot blow the call stack. */
function findInlineDataIssues(spec: unknown): InlineDataIssue[] {
  const issues: InlineDataIssue[] = [];
  const stack: { node: unknown; path: (string | number)[] }[] = [{ node: spec, path: [] }];
  while (stack.length > 0) {
    const { node, path } = stack.pop() as { node: unknown; path: (string | number)[] };
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) {
        stack.push({ node: node[i], path: [...path, i] });
      }
      continue;
    }
    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      const childPath = [...path, key];
      if (
        key === "data" &&
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        const dataObject = value as Record<string, unknown>;
        if ("values" in dataObject) {
          issues.push({
            path: [...childPath, "values"],
            message: `${FILE_ROLE}: inline data 'values' is forbidden (ADR-0004, C4). Move the data to a sibling file and reference it via data.url.`,
          });
        }
        if ("url" in dataObject) {
          const raw = dataObject.url;
          if (typeof raw !== "string" || !isSiblingFilename(raw)) {
            issues.push({
              path: [...childPath, "url"],
              message: `${FILE_ROLE}: data.url must be a sibling file path (no scheme, no leading '/', no '..'); got ${JSON.stringify(raw)}.`,
            });
          }
        }
      }
      stack.push({ node: value, path: childPath });
    }
  }
  return issues;
}

/**
 * A revkit plot spec. Shape:
 *   { schemaVersion, $schema?, data: { url|name|sequence, format?, … }, mark, encoding, ... }
 * The rest of the fields pass through as a loose record so the full
 * Vega-Lite grammar remains available; a recursive superRefine enforces
 * the "no inline data" and "url is a sibling file" rules across every
 * level of nesting.
 */
export const plotSpecSchema = z
  .object({
    schemaVersion: schemaVersionField(FILE_ROLE),
  })
  .loose()
  .superRefine((spec, ctx) => {
    // A top-level `data` block is required — a spec that omits it entirely
    // would silently pass the recursive walk (no data key present anywhere)
    // and produce an empty plot at render time.
    if (!("data" in spec) || spec.data === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["data"],
        message: `${FILE_ROLE}: 'data' is required at the top level (Vega-Lite spec without a data block).`,
      });
    }
    for (const issue of findInlineDataIssues(spec)) {
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  });

export type PlotSpec = z.infer<typeof plotSpecSchema>;

/** Exposed for the loader (which must additionally check that each
 * `data.url` points at a file that exists next to the spec on disk). */
export { isSiblingFilename };
