// Plot spec schema (`plots/<name>/spec.vl.json`) — Vega-Lite JSON with data
// in a sibling file, never inline (ADR-0004, C4). Rendering to SVG at build
// time lives in M1 item 3; this file is the schema half only.
import { z } from "astro/zod";
import { schemaVersionField } from "./shared.ts";

/** A plot spec's `data` block: either `{ url }` pointing at a sibling data
 * file, or `{ name }` for a named data source declared by the caller. Inline
 * `values` is forbidden — the plot guard fails a build that includes it. */
const dataSourceSchema = z.union([
  z.object({ url: z.string().min(1) }).strict(),
  z.object({ name: z.string().min(1) }).strict(),
]);

/** Vega-Lite mark: a string ("bar", "line", ...) or a config object. The
 * detailed mark grammar is Vega-Lite's own; we only assert it is present. */
const markSchema = z.union([z.string().min(1), z.record(z.string(), z.unknown())]);

/**
 * A revkit plot spec. Shape:
 *   { schemaVersion, $schema?, data: { url|name }, mark, encoding, ... }
 * The rest of the fields pass through as an open record so the full
 * Vega-Lite grammar remains available; the guard (C4) is the enforcement
 * half — this schema is the structural contract.
 */
export const plotSpecSchema = z
  .object({
    schemaVersion: schemaVersionField("plots/<name>/spec.vl.json"),
    $schema: z.url().optional(),
    data: dataSourceSchema,
    mark: markSchema.optional(),
    encoding: z.record(z.string(), z.unknown()).optional(),
    layer: z.array(z.record(z.string(), z.unknown())).optional(),
    title: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    description: z.string().optional(),
  })
  .loose();

export type PlotSpec = z.infer<typeof plotSpecSchema>;
