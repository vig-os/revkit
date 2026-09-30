// Plot spec schema (`plots/<name>/spec.vl.json`) — Vega-Lite JSON with data
// in a sibling file, never inline (ADR-0004, C4). Rendering to SVG at build
// time lives in M1 item 3; this file is the schema half only.
//
// Inline data can enter a Vega-Lite spec through three doors, all forbidden
// here at any nesting depth. First, an inline `values` array on any `data`
// block — top-level, inside a `layer`, inside `concat`, `hconcat`, `vconcat`,
// `facet`, `spec`, or a `transform` lookup's `from.data`. Second, a top-level
// `datasets` map (Vega-Lite's named-dataset escape hatch, referenced later
// by `data: { name }`). Third, a `data.url` that is not a bare sibling
// filename — no scheme, no leading `/`, no `..`. Vega-Lite grammar keys
// such as `format`, `name` and `sequence` pass through: the check is
// data-source shape, not full Vega-Lite validation.
//
// Two Vega-Lite features are also refused because they would let a spec
// emit a link or fetch an external resource from the rendered SVG: the
// `href` encoding channel (renders `<a xlink:href="…">` around the mark)
// and the `image` mark type (renders `<image xlink:href="…">`, fetching
// the URL at read time). Rejected at any depth. Plots are static
// figures in revkit — an author who needs an interactive link belongs in
// the interactive-island escape hatch (ADR-0004), not in a build-time
// SVG that ships without JS.
import { z } from "astro/zod";
import { isObject, walkObjects } from "../utils/vega-lite-walk.ts";
import { schemaVersionField } from "@revkit/review-core";

const FILE_ROLE = "plots/<name>/spec.vl.json";

/** A bare sibling filename: no scheme, no absolute path, no parent-directory
 * traversal. Allows a subdirectory relative to the spec (e.g. `data/x.csv`)
 * so a plot can group its data files without escaping its own directory. */
export function isSiblingFilename(url: string): boolean {
  if (url.length === 0) return false;
  if (url.startsWith("/")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false; // http:, data:, file:, …
  if (url.split("/").some((segment) => segment === "..")) return false;
  return true;
}

interface InlineDataIssue {
  path: readonly (string | number)[];
  message: string;
}

/** Walk the whole spec and report every escape hatch that would let inline
 * data — or a link / image mark that would emit an outbound reference —
 * slip past the plot guard. Shared with the plots loader via
 * `walkObjects` so a schema-side rule can never drift from a loader-side
 * check that consults the same tree. */
function findInlineDataIssues(spec: unknown): InlineDataIssue[] {
  const issues: InlineDataIssue[] = [];
  walkObjects(spec, (node, path) => {
    if (isObject(node.datasets)) {
      issues.push({
        path: [...path, "datasets"],
        message: `${FILE_ROLE}: 'datasets' inlines data (Vega-Lite's named-dataset escape hatch); move each dataset into a sibling file and reference it via data.url (ADR-0004, C4).`,
      });
    }
    if (isObject(node.data)) {
      const dataObject = node.data;
      if ("values" in dataObject) {
        issues.push({
          path: [...path, "data", "values"],
          message: `${FILE_ROLE}: inline data 'values' is forbidden (ADR-0004, C4). Move the data to a sibling file and reference it via data.url.`,
        });
      }
      if ("url" in dataObject) {
        const raw = dataObject.url;
        if (typeof raw !== "string" || !isSiblingFilename(raw)) {
          issues.push({
            path: [...path, "data", "url"],
            message: `${FILE_ROLE}: data.url must be a sibling file path (no scheme, no leading '/', no '..'); got ${JSON.stringify(raw)}.`,
          });
        }
      }
    }
    // The `href` encoding channel renders each mark inside an
    // `<a xlink:href="…">` — a link out from a supposedly static figure.
    // Rejected wherever an `encoding` block appears (top-level, inside a
    // layer, concat, facet, spec, repeat, …). The channel accepts a
    // field/expression/datum, so refusing the key outright is the
    // simplest safe rule.
    if (isObject(node.encoding) && "href" in node.encoding) {
      issues.push({
        path: [...path, "encoding", "href"],
        message: `${FILE_ROLE}: the 'href' encoding channel is forbidden — plots are static figures and must not emit outbound links (ADR-0004, C4).`,
      });
    }
    // An `image` mark renders `<image xlink:href="…">`, which fetches the
    // URL at read time in the browser. Two shapes match: `mark: "image"`
    // and `mark: { type: "image", url: "…" }` — reject both.
    if (node.mark === "image") {
      issues.push({
        path: [...path, "mark"],
        message: `${FILE_ROLE}: the 'image' mark is forbidden — it would fetch a remote resource from the rendered SVG (ADR-0004, C4).`,
      });
    }
    if (isObject(node.mark) && node.mark.type === "image") {
      issues.push({
        path: [...path, "mark", "type"],
        message: `${FILE_ROLE}: the 'image' mark is forbidden — it would fetch a remote resource from the rendered SVG (ADR-0004, C4).`,
      });
    }
  });
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
      ctx.addIssue({ code: "custom", path: [...issue.path], message: issue.message });
    }
  });

export type PlotSpec = z.infer<typeof plotSpecSchema>;
