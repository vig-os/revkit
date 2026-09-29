// Validate that every `field` reference in a Vega-Lite plot spec resolves
// to a real column of the plot's data file (ADR-0004, C4). An undefined
// `field` currently renders an empty plot silently — a user-facing bug
// that CI must catch before it ships. Runs alongside the schema check
// and the sibling-file check on the build path.
//
// The check is intentionally conservative: it collects every string
// `field` under an `encoding.<channel>` block and under transforms that
// declare a `field` (aggregate, groupby, calculate, joinaggregate,
// stack…), then intersects that set against the columns parsed from the
// spec's declared top-level `data.url`. Aggregate encodings whose
// `field` is `"*"` (count) are exempt. Nested-key access (`field:
// "a.b"`) is accepted if either the dotted path or its first segment
// exists — Vega-Lite treats `a.b` as a property path when `a` is an
// object column.
//
// The data file is read through {@link readConfinedSibling} so this
// check applies the SAME containment rules as the runtime Vega loader.
// A regression that let a symlinked file through the field-check would
// otherwise leak the target's first line into the CI error message
// (`"Columns in the file: [root:x:0:0…]"`); sharing the helper closes
// that hole once, not twice.

import { parse as parseYaml } from "yaml";
import { isObject, walkObjects } from "../content/utils/vega-lite-walk.ts";
import { readConfinedSibling } from "./plot-file-io.ts";

/** Collect every string `field` reference that must resolve to a data
 * column. Skips the aggregate wildcard (`"*"`) and non-string values
 * (Vega-Lite also accepts `field: {repeat: …}` etc., which we let
 * through — the schema already narrows what a plot spec may carry). */
export function collectFieldReferences(spec: unknown): string[] {
  const fields = new Set<string>();
  walkObjects(spec, (node) => {
    if (typeof node.field === "string" && node.field.length > 0 && node.field !== "*") {
      fields.add(node.field);
    }
  });
  return [...fields].sort();
}

/** Read the columns of a CSV/TSV file: the first non-empty line is the
 * header row. Splits on `,` (CSV) or `\t` (TSV); a quoted comma column
 * (`"a,b"`) is honoured. */
function parseDelimitedColumns(text: string, delimiter: string): string[] {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    return parseDelimitedRow(line, delimiter);
  }
  return [];
}

/** Parse a single delimited row with basic quote handling — the header
 * row is enough for column validation; full row parsing is Vega's job. */
function parseDelimitedRow(row: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < row.length; i += 1) {
    const character = row[i] as string;
    if (character === '"') {
      if (inQuotes && row[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && character === delimiter) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

/** Read the columns Vega-Lite sees for a JSON data file: takes the union
 * of the keys of every top-level object element (arrays of records) or
 * of the object itself. */
function readJsonColumns(text: string): string[] {
  const parsed: unknown = JSON.parse(text);
  const keys = new Set<string>();
  if (Array.isArray(parsed)) {
    for (const row of parsed) {
      if (isObject(row)) for (const key of Object.keys(row)) keys.add(key);
    }
  } else if (isObject(parsed)) {
    for (const key of Object.keys(parsed)) keys.add(key);
  }
  return [...keys].sort();
}

/** Read the columns of a plot's top-level data file. Handles CSV, TSV,
 * JSON (arrays / records) and YAML (arrays / records); other formats
 * return `null`, which tells the caller to skip the column check rather
 * than fail on an unknown shape.
 *
 * Uses {@link readConfinedSibling} so a symlink to `/etc/passwd`
 * (`plots/x/link.csv -> /etc/passwd`) is refused BEFORE its contents
 * reach us — the raised error carries no bytes from the target file. */
export async function readDataColumns(
  specDir: string,
  url: string,
  format?: { type?: string },
): Promise<string[] | null> {
  const explicitType = format?.type?.toLowerCase();
  const extensionMatch = url.match(/\.([a-z0-9]+)$/i);
  const kind = explicitType ?? extensionMatch?.[1]?.toLowerCase() ?? "";
  // Unknown format: schema still guards the sibling shape, and we don't
  // even open the file — keeping the confined helper as the only door
  // to a data file's contents.
  if (kind !== "csv" && kind !== "tsv" && kind !== "json" && kind !== "yaml" && kind !== "yml") {
    return null;
  }
  const { text } = await readConfinedSibling(specDir, url);
  if (kind === "csv") return parseDelimitedColumns(text, ",");
  if (kind === "tsv") return parseDelimitedColumns(text, "\t");
  if (kind === "json") return readJsonColumns(text);
  // yaml / yml
  const parsed: unknown = parseYaml(text);
  return readJsonColumns(JSON.stringify(parsed));
}

/** Check that every referenced field exists in the columns list. A
 * dotted field (`"a.b"`) resolves against its first path segment so a
 * JSON column of records still passes. */
function isFieldPresent(field: string, columns: ReadonlySet<string>): boolean {
  if (columns.has(field)) return true;
  const firstSegment = field.split(/[.[\]]/)[0];
  return typeof firstSegment === "string" && firstSegment.length > 0 && columns.has(firstSegment);
}

/** Extract the top-level `data.url` and `data.format` from a spec. The
 * schema guarantees a top-level `data` block exists; when its `url` is
 * absent (e.g. a spec that names a sub-dataset in every layer instead),
 * we skip the column check rather than error — the schema still guards
 * that shape. */
function extractTopLevelDataUrl(spec: unknown): { url: string; format?: { type?: string } } | null {
  if (!isObject(spec) || !isObject(spec.data)) return null;
  const url = spec.data.url;
  const format = isObject(spec.data.format) ? { type: (spec.data.format.type as string | undefined) } : undefined;
  if (typeof url !== "string" || url.length === 0) return null;
  return { url, format };
}

/**
 * Fail loudly when a plot spec references a field that does not exist
 * in its data file's columns. Skips the check when the data format is
 * unknown to us (returns `null` from `readDataColumns`) or when there is
 * no top-level `data.url` — a spec that fans out across nested data
 * blocks is validated only at render time.
 */
export async function assertPlotFieldsExist(spec: unknown, specDir: string): Promise<void> {
  const dataInfo = extractTopLevelDataUrl(spec);
  if (dataInfo === null) return;
  const columns = await readDataColumns(specDir, dataInfo.url, dataInfo.format);
  if (columns === null) return;
  const columnSet = new Set(columns);
  const missing: string[] = [];
  for (const field of collectFieldReferences(spec)) {
    if (!isFieldPresent(field, columnSet)) missing.push(field);
  }
  if (missing.length > 0) {
    throw new Error(
      `field(s) ${JSON.stringify(missing)} referenced by the spec are not columns of ${dataInfo.url}. ` +
        `Columns in the file: ${JSON.stringify(columns)}.`,
    );
  }
}
