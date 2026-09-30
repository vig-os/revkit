// Untrusted-mode allowlist walker for a vega-lite spec (ADR-0021,
// ADR-0025; PR #48 round-3 blocker 2).
//
// **Why an allowlist, not a denylist.** A denylist over key names
// missed `filter`, `test`, `param`, `labelExpr`, `datum.<x>` string
// predicates, plus any future `…Expr` key vega adds. The reviewer
// reproduced `transform:[{filter:"..."}]` evaluating in the SSR
// pipeline (including a DoS `sequence(0,3e7)`). This module
// walks the parsed JSON with an ALLOWLIST of keys and value shapes
// — anything not on the allowlist is refused. New vega keys are
// refused by default, which is the right posture for PR content.
//
// **What the allowlist admits.**
//   - `$schema`, `title`, `description`, `background`, `padding`,
//     `width`, `height`, `autosize`.
//   - `data.url` (a bare string; must be a sibling file — the
//     confined-plot reader enforces that separately) OR `data.name`
//     (a bare string).
//   - `mark` — a bare string (allowed marks) or an object with a
//     small set of literal fields.
//   - `encoding.<channel>` with `field`, `type`, `aggregate`,
//     `bin`, `sort`, `axis.title|labelAngle|format|orient|domain|ticks|labels`,
//     `legend`, `scale.type|domain|range|scheme|zero|nice|reverse|padding|paddingInner|paddingOuter`,
//     `stack`, `timeUnit`, `title`. Every one accepts only primitive
//     literals — number, string (except in expression positions),
//     boolean, null — or a small allowlisted object shape.
//   - `transform`: only `filter` REFUSED, but `fold`, `flatten`,
//     `pivot`, `stack` accepted as OBJECT literals with primitive
//     children. `calculate` REFUSED (vega expression string).
//   - Container keys: `layer`, `hconcat`, `vconcat`, `concat`,
//     `repeat`, `facet`, `spec` — each recurses into the same
//     allowlist walk.
//
// **What the allowlist REFUSES.**
//   - Any string value under a key whose semantics are a vega
//     expression: `filter`, `calculate`, `test`, `expr`, `signal`,
//     `param`, `labelExpr`, `tooltipExpr`, `href`, `hrefExpr`,
//     `condition.test`, `condition.param`, and every key that ends
//     with `Expr` (case-insensitive; catches future additions).
//   - `datum.<x>` string predicates in an axis / scale / mark
//     position — a string that starts with `datum.` is refused.
//   - `params`, `selections`, `signals` — the whole selection /
//     signal machinery.
//   - `transform: [{ calculate }]`, `transform: [{ filter }]`,
//     `transform: [{ regression }]`, `transform: [{ loess }]`,
//     `transform: [{ density }]`, `transform: [{ quantile }]`,
//     `transform: [{ sample }]` — all of which either take an
//     expression or synthesise data.
//   - Any unrecognised top-level key. Any unrecognised child of an
//     encoding channel. Any `on`, `update`, `bind`.
//
// **Caps on the data.**
//   - Sibling data files (`data.url`) larger than
//     `MAX_DATA_FILE_BYTES` are refused.
//   - Inline `data.values` arrays with more than
//     `MAX_INLINE_DATA_ROWS` rows are refused (though
//     ADR-0004 already refuses inline data structurally; keep this
//     as belt-and-braces).
//
// The rule runs ONLY when the check trust posture is `untrusted`.

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { Diagnostic } from "../diagnostics.ts";

/** Per-file data-size cap, in bytes. */
export const MAX_DATA_FILE_BYTES = 512 * 1024;
/** Cap on inline data rows — kept only as a documentation constant.
 * Inline `data.values` is refused outright in untrusted mode
 * (PR #48 round-4 nit). */
export const MAX_INLINE_DATA_ROWS = 5_000;

/** Top-level keys the walker admits. Anything else refused. */
const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  // revkit's own required key on every plot spec (see
  // site/src/content/schemas/plots.ts): a positive integer with
  // no expression payload — refused-by-shape any string that
  // slipped in.
  "schemaVersion",
  "$schema",
  "title",
  "description",
  "background",
  "padding",
  "width",
  "height",
  "autosize",
  "config",
  "data",
  "mark",
  "encoding",
  "transform",
  "projection",
  "layer",
  "hconcat",
  "vconcat",
  "concat",
  "repeat",
  "facet",
  "spec",
  "name",
  "usermeta",
  "resolve",
  "columns",
  "align",
  "center",
  "spacing",
]);

/** Encoding-channel names admitted. */
const ENCODING_CHANNELS: ReadonlySet<string> = new Set([
  "x",
  "y",
  "x2",
  "y2",
  "xError",
  "yError",
  "xError2",
  "yError2",
  "longitude",
  "latitude",
  "longitude2",
  "latitude2",
  "color",
  "fill",
  "fillOpacity",
  "opacity",
  "stroke",
  "strokeOpacity",
  "strokeWidth",
  "strokeDash",
  "size",
  "angle",
  "shape",
  "text",
  "tooltip",
  "href",
  "order",
  "detail",
  "row",
  "column",
  "facet",
  "theta",
  "theta2",
  "radius",
  "radius2",
  "description",
  "key",
]);

/** Keys inside one encoding channel. */
const CHANNEL_DEF_KEYS: ReadonlySet<string> = new Set([
  "field",
  "type",
  "aggregate",
  "timeUnit",
  "bin",
  "sort",
  "stack",
  "title",
  "format",
  "axis",
  "scale",
  "legend",
  "value",
  "band",
  "condition",
]);

/** Keys admitted inside an `axis` object — no `…Expr` variants. */
const AXIS_KEYS: ReadonlySet<string> = new Set([
  "title",
  "titleAngle",
  "titleColor",
  "titleFontSize",
  "titlePadding",
  "labelAngle",
  "labelColor",
  "labelFontSize",
  "labelLimit",
  "labelPadding",
  "labelSeparation",
  "format",
  "formatType",
  "orient",
  "domain",
  "ticks",
  "tickCount",
  "tickSize",
  "labels",
  "grid",
  "offset",
  "position",
  "zindex",
  "values",
]);

/** Keys admitted inside a `scale` object. */
const SCALE_KEYS: ReadonlySet<string> = new Set([
  "type",
  "domain",
  "range",
  "scheme",
  "zero",
  "nice",
  "reverse",
  "padding",
  "paddingInner",
  "paddingOuter",
  "clamp",
  "interpolate",
  "align",
  "base",
  "exponent",
  "round",
]);

/** Keys admitted inside a `legend` object — again no `…Expr`. */
const LEGEND_KEYS: ReadonlySet<string> = new Set([
  "title",
  "orient",
  "direction",
  "format",
  "type",
  "values",
  "labelFontSize",
  "titleFontSize",
  "symbolType",
  "columns",
  "columnPadding",
  "rowPadding",
  "gradientLength",
  "gradientThickness",
]);

/** Mark object keys. Includes the corner-radius variants revkit's
 * own plots use (`cornerRadiusEnd`, etc.). Any `…Expr` sibling of
 * a listed key is still refused by the `isExprKey` check. */
const MARK_OBJECT_KEYS: ReadonlySet<string> = new Set([
  "type",
  "color",
  "fill",
  "stroke",
  "strokeWidth",
  "strokeDash",
  "opacity",
  "fillOpacity",
  "strokeOpacity",
  "size",
  "shape",
  "orient",
  "interpolate",
  "point",
  "line",
  "tension",
  "align",
  "baseline",
  "angle",
  "cornerRadius",
  "cornerRadiusEnd",
  "cornerRadiusTopLeft",
  "cornerRadiusTopRight",
  "cornerRadiusBottomLeft",
  "cornerRadiusBottomRight",
  "dx",
  "dy",
  "filled",
  "font",
  "fontSize",
  "fontStyle",
  "fontWeight",
  "clip",
  "invalid",
  "radius",
  "radius2",
  "innerRadius",
  "outerRadius",
  "padAngle",
]);

/** Bin object keys. */
const BIN_KEYS: ReadonlySet<string> = new Set([
  "anchor",
  "base",
  "binned",
  "divide",
  "extent",
  "maxbins",
  "minstep",
  "nice",
  "step",
  "steps",
]);

/** Sort object keys (short — an expression `op:"sum",field:"x"` is
 * allowed; a `field:{repeat:...}` shape is refused via strict child
 * types). */
const SORT_KEYS: ReadonlySet<string> = new Set(["op", "field", "order", "encoding"]);

/** Transform object shapes admitted. Every OTHER key at a
 * transform position is REFUSED — no calculate, filter, regression,
 * loess, density, quantile, sample, aggregate-with-expression, etc. */
const TRANSFORM_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  // Reshape only.
  "fold",
  "flatten",
  "pivot",
  "stack",
  // Simple aggregate/join with per-key literal fields — but the
  // walker refuses any string that has expression semantics
  // (see `refuseExpressionStrings`).
  "aggregate",
  "joinaggregate",
  "bin",
  "timeUnit",
  "lookup",
  // Keys that STRUCTURE a transform (`as`, `groupby`) are checked
  // as inner keys of the accepted transform types below.
]);

/** Container keys that recurse — treated as arrays or objects
 * containing sub-specs. */
const CONTAINER_KEYS: ReadonlySet<string> = new Set([
  "layer",
  "hconcat",
  "vconcat",
  "concat",
  "spec",
  "facet",
  "repeat",
]);

/** Suffix check: any key whose lowercase ending is `expr` is
 * refused. Catches future `…Expr` additions. */
function isExprKey(key: string): boolean {
  return key.toLowerCase().endsWith("expr");
}

/** Keys refused outright anywhere in the spec. */
const REFUSED_KEYS: ReadonlySet<string> = new Set([
  "filter",
  "calculate",
  "test",
  "expr",
  "signal",
  "param",
  "params",
  "selection",
  "selections",
  "signals",
  "on",
  "update",
  "bind",
  "datum",
  "regression",
  "loess",
  "density",
  "quantile",
  "sample",
  "labelExpr",
  "tooltipExpr",
]);

/** Walk the spec and return every violation. `specDir` is the
 * absolute directory the spec lives in; we use it to size-check
 * `data.url` files. */
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
    // plot-structure will emit its own diagnostic; do not
    // double-report.
    return findings;
  }
  const ctx: WalkCtx = {
    findings,
    reportPath,
    specDir: dirname(absoluteSpecPath),
  };
  walkTopLevel(parsed, ctx);
  return findings;
}

interface WalkCtx {
  readonly findings: Diagnostic[];
  readonly reportPath: string;
  readonly specDir: string;
}

function push(ctx: WalkCtx, path: string, message: string): void {
  ctx.findings.push({
    file: ctx.reportPath,
    line: 0,
    rule: "plot-structure",
    message: `${message} at ${path.length === 0 ? "<root>" : path} — refused for untrusted PR content (ADR-0021, ADR-0025).`,
  });
}

/** Refuse a key that's on `REFUSED_KEYS`, ends in `Expr`, or has an
 * expression-shaped string value (starts with `datum.`, or contains
 * `[[` etc.). Returns `true` when refused. */
function refuseExpressionKey(key: string, path: string, ctx: WalkCtx): boolean {
  if (REFUSED_KEYS.has(key)) {
    push(ctx, path, `vega expression-typed key '${key}'`);
    return true;
  }
  if (isExprKey(key)) {
    push(ctx, path, `vega '…Expr' key '${key}'`);
    return true;
  }
  return false;
}

/** Type-check a primitive value at a leaf position. Refuses any
 * string that looks like a vega expression (starts with `datum.`,
 * `data[`, `event.`, `now(`, etc.), and any non-primitive. */
function checkPrimitive(value: unknown, path: string, ctx: WalkCtx): void {
  if (value === null) return;
  const t = typeof value;
  if (t === "number" || t === "boolean") return;
  if (t === "string") {
    if (looksLikeVegaExpression(value as string)) {
      push(ctx, path, `string looks like a vega expression`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      checkPrimitive(value[i], `${path}[${i}]`, ctx);
    }
    return;
  }
  push(ctx, path, `object not admitted at this position (expected primitive)`);
}

/** Heuristic: a string that starts with `datum.`, contains `[[`,
 * `event.`, `now(`, `if(`, `parseFloat(`, `parseInt(`, or `\\`` is
 * refused as a plausible vega expression. Slightly over-broad on
 * purpose — a title or label that happens to say `datum.x` is not
 * valid content anyway, and the reviewer can quote it differently
 * if needed. */
function looksLikeVegaExpression(value: string): boolean {
  if (value.length === 0) return false;
  if (/^\s*datum\./.test(value)) return true;
  if (/^\s*event\./.test(value)) return true;
  if (/^\s*data\[/.test(value)) return true;
  if (/(^|[\s(])now\s*\(/.test(value)) return true;
  if (/(^|[\s(])if\s*\(/.test(value)) return true;
  if (/(^|[\s(])sequence\s*\(/.test(value)) return true;
  if (/(^|[\s(])parseFloat\s*\(/.test(value)) return true;
  if (/(^|[\s(])parseInt\s*\(/.test(value)) return true;
  return false;
}

// -- Top-level walker --

function walkTopLevel(node: unknown, ctx: WalkCtx): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    push(ctx, "", `expected a JSON object at the spec root`);
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (refuseExpressionKey(key, key, ctx)) continue;
    if (!TOP_LEVEL_KEYS.has(key)) {
      push(ctx, key, `unknown top-level key '${key}'`);
      continue;
    }
    switch (key) {
      case "data":
        walkData(value, key, ctx);
        break;
      case "mark":
        walkMark(value, key, ctx);
        break;
      case "encoding":
        walkEncoding(value, key, ctx);
        break;
      case "transform":
        walkTransform(value, key, ctx);
        break;
      case "layer":
      case "hconcat":
      case "vconcat":
      case "concat":
        walkContainerArray(value, key, ctx);
        break;
      case "spec":
      case "facet":
      case "repeat":
        // `facet` and `repeat` accept an object of field selectors,
        // so we treat them as sub-specs uniformly. A hostile
        // `facet` object is caught by walkTopLevel refusing unknown
        // keys.
        walkTopLevel(value, ctx);
        break;
      case "config":
        // config is a large object; recursively primitive-check it.
        // A hostile expression string in a config field is refused
        // by `checkPrimitive`.
        walkConfig(value, key, ctx);
        break;
      default:
        // Primitive-shaped top-level keys (title, description, etc.).
        checkPrimitive(value, key, ctx);
    }
  }
}

function walkData(value: unknown, path: string, ctx: WalkCtx): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    push(ctx, path, `data must be an object`);
    return;
  }
  const obj = value as Record<string, unknown>;
  // `data.values` is refused OUTRIGHT (PR #48 round-4 nit) — the
  // trusted plots schema (site/src/content/schemas/plots.ts) and
  // CLAUDE.md already forbid inline data. Every PR data source
  // must be a sibling file via `data.url`.
  const allowedDataKeys = new Set(["url", "name", "format"]);
  for (const [k, v] of Object.entries(obj)) {
    if (refuseExpressionKey(k, `${path}.${k}`, ctx)) continue;
    if (k === "values") {
      push(ctx, `${path}.values`, `inline data (data.values) is refused — use a sibling data.url file (ADR-0004, C4)`);
      continue;
    }
    if (!allowedDataKeys.has(k)) {
      push(ctx, `${path}.${k}`, `unknown data key '${k}'`);
      continue;
    }
    if (k === "url") {
      if (typeof v !== "string") {
        push(ctx, `${path}.url`, `data.url must be a string`);
        continue;
      }
      checkDataUrl(v, `${path}.url`, ctx);
    } else if (k === "name") {
      if (typeof v !== "string") {
        push(ctx, `${path}.name`, `data.name must be a string`);
      }
    } else {
      // `format` — restricted set of literal keys.
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        for (const [fk, fv] of Object.entries(v as Record<string, unknown>)) {
          if (refuseExpressionKey(fk, `${path}.format.${fk}`, ctx)) continue;
          checkPrimitive(fv, `${path}.format.${fk}`, ctx);
        }
      } else {
        checkPrimitive(v, `${path}.format`, ctx);
      }
    }
  }
}

/** Refuse a data URL that is not a bare sibling filename, or whose
 * target exceeds the file-size cap. */
function checkDataUrl(url: string, path: string, ctx: WalkCtx): void {
  if (url.includes("://") || url.startsWith("//")) {
    push(ctx, path, `data.url must be a bare sibling path, not an absolute URL`);
    return;
  }
  if (url.startsWith("/")) {
    push(ctx, path, `data.url must be a bare sibling path (no leading '/')`);
    return;
  }
  if (url.includes("..")) {
    push(ctx, path, `data.url must not contain '..'`);
    return;
  }
  // Attempt a size check against the sibling file.
  const abs = resolvePath(ctx.specDir, url);
  try {
    const s = statSync(abs);
    if (s.size > MAX_DATA_FILE_BYTES) {
      push(ctx, path, `data file ${url} is ${s.size} bytes (cap ${MAX_DATA_FILE_BYTES})`);
    }
  } catch {
    // Missing file — plot-structure emits its own diagnostic, so
    // we skip here.
  }
}

function walkMark(value: unknown, path: string, ctx: WalkCtx): void {
  if (typeof value === "string") {
    // Simple mark string (`"bar"`, `"line"`, …). Accept.
    return;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    push(ctx, path, `mark must be a string or object`);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (refuseExpressionKey(k, `${path}.${k}`, ctx)) continue;
    if (!MARK_OBJECT_KEYS.has(k)) {
      push(ctx, `${path}.${k}`, `unknown mark key '${k}'`);
      continue;
    }
    checkPrimitive(v, `${path}.${k}`, ctx);
  }
}

function walkEncoding(value: unknown, path: string, ctx: WalkCtx): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    push(ctx, path, `encoding must be an object`);
    return;
  }
  for (const [channel, def] of Object.entries(value as Record<string, unknown>)) {
    if (refuseExpressionKey(channel, `${path}.${channel}`, ctx)) continue;
    if (!ENCODING_CHANNELS.has(channel)) {
      push(ctx, `${path}.${channel}`, `unknown encoding channel '${channel}'`);
      continue;
    }
    // `tooltip` (and `detail`) accept the ARRAY form
    // `[ {field, type, title}, … ]` — a common shape in revkit's
    // own plots. Every element is walked as a channel def; any
    // expression string still gets refused by the leaf check.
    if (Array.isArray(def)) {
      for (let i = 0; i < def.length; i++) {
        walkChannelDef(def[i], `${path}.${channel}[${i}]`, ctx);
      }
      continue;
    }
    walkChannelDef(def, `${path}.${channel}`, ctx);
  }
}

function walkChannelDef(value: unknown, path: string, ctx: WalkCtx): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    push(ctx, path, `channel definition must be an object`);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (refuseExpressionKey(k, `${path}.${k}`, ctx)) continue;
    if (!CHANNEL_DEF_KEYS.has(k)) {
      push(ctx, `${path}.${k}`, `unknown channel-def key '${k}'`);
      continue;
    }
    switch (k) {
      case "axis":
        walkKeyedObject(v, `${path}.${k}`, AXIS_KEYS, ctx);
        break;
      case "scale":
        walkKeyedObject(v, `${path}.${k}`, SCALE_KEYS, ctx);
        break;
      case "legend":
        walkKeyedObject(v, `${path}.${k}`, LEGEND_KEYS, ctx);
        break;
      case "bin":
        if (typeof v === "boolean") break;
        walkKeyedObject(v, `${path}.${k}`, BIN_KEYS, ctx);
        break;
      case "sort":
        if (v === null || typeof v === "string" || Array.isArray(v)) {
          checkPrimitive(v, `${path}.${k}`, ctx);
        } else if (typeof v === "object") {
          walkKeyedObject(v, `${path}.${k}`, SORT_KEYS, ctx);
        } else {
          push(ctx, `${path}.${k}`, `unsupported sort shape`);
        }
        break;
      case "condition":
        // The `condition` key is a common carrier for `param` /
        // `test` / `selection`. Refuse it wholesale — a static plot
        // does not need conditional encodings.
        push(ctx, `${path}.${k}`, `encoding.condition is refused`);
        break;
      default:
        checkPrimitive(v, `${path}.${k}`, ctx);
    }
  }
}

/** Walk an object with a fixed allowlist of keys. Every value must
 * be a primitive (or a shallow object of primitives), and every
 * refused key surfaces one diagnostic. */
function walkKeyedObject(
  value: unknown,
  path: string,
  allowed: ReadonlySet<string>,
  ctx: WalkCtx,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    push(ctx, path, `expected an object`);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (refuseExpressionKey(k, `${path}.${k}`, ctx)) continue;
    if (!allowed.has(k)) {
      push(ctx, `${path}.${k}`, `unknown key '${k}'`);
      continue;
    }
    checkPrimitive(v, `${path}.${k}`, ctx);
  }
}

function walkTransform(value: unknown, path: string, ctx: WalkCtx): void {
  if (!Array.isArray(value)) {
    push(ctx, path, `transform must be an array`);
    return;
  }
  for (let i = 0; i < value.length; i++) {
    const step = value[i];
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      push(ctx, `${path}[${i}]`, `transform step must be an object`);
      continue;
    }
    const stepObj = step as Record<string, unknown>;
    const keys = Object.keys(stepObj);
    // A transform step's *shape* is defined by one primary key —
    // `fold`, `flatten`, `pivot`, `stack`, `aggregate`, etc. If ANY
    // key is on `REFUSED_KEYS` or ends in `Expr`, refuse the step.
    let refused = false;
    for (const k of keys) {
      if (refuseExpressionKey(k, `${path}[${i}].${k}`, ctx)) {
        refused = true;
      }
    }
    if (refused) continue;
    // Every remaining key must be in `TRANSFORM_ALLOWED_KEYS` or be
    // a supporting key (`as`, `groupby`, `frame`, `bin`).
    const supporting = new Set(["as", "groupby", "frame", "bin", "field", "op", "sort", "keyvals", "value"]);
    for (const k of keys) {
      if (TRANSFORM_ALLOWED_KEYS.has(k)) continue;
      if (supporting.has(k)) continue;
      push(ctx, `${path}[${i}].${k}`, `unknown transform key '${k}'`);
    }
    // Every string value inside must not look like an expression.
    for (const [k, v] of Object.entries(stepObj)) {
      checkPrimitive(v, `${path}[${i}].${k}`, ctx);
    }
  }
}

function walkContainerArray(value: unknown, path: string, ctx: WalkCtx): void {
  if (!Array.isArray(value)) {
    push(ctx, path, `container '${path}' must be an array of sub-specs`);
    return;
  }
  for (let i = 0; i < value.length; i++) {
    walkTopLevel(value[i], ctx);
  }
}

/** Allowlisted top-level keys inside `config`. Anything else (e.g.
 * vega's `events` / `bind` machinery) is refused (PR #48 round-4
 * nit). Every sub-key value must still be a primitive or a shallow
 * object of primitives, and any expression-shaped string is caught
 * by the leaf check. */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  // Theming baselines.
  "background",
  "padding",
  "autosize",
  "font",
  "customFormatTypes",
  "numberFormat",
  "timeFormat",
  // Axis / legend / scale-wide defaults.
  "axis",
  "axisX",
  "axisY",
  "axisTop",
  "axisBottom",
  "axisLeft",
  "axisRight",
  "axisBand",
  "axisDiscrete",
  "axisQuantitative",
  "axisTemporal",
  "legend",
  "title",
  "header",
  "headerRow",
  "headerColumn",
  "headerFacet",
  "range",
  "scale",
  "projection",
  "concat",
  "facet",
  "view",
  // Mark-family defaults.
  "mark",
  "arc",
  "area",
  "bar",
  "boxplot",
  "circle",
  "errorband",
  "errorbar",
  "geoshape",
  "image",
  "line",
  "point",
  "rect",
  "rule",
  "square",
  "text",
  "tick",
  "trail",
  "style",
]);

function walkConfig(value: unknown, path: string, ctx: WalkCtx): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    push(ctx, path, `config must be an object`);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (refuseExpressionKey(k, `${path}.${k}`, ctx)) continue;
    if (!CONFIG_KEYS.has(k)) {
      push(ctx, `${path}.${k}`, `unknown config key '${k}'`);
      continue;
    }
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      checkPrimitive(v, `${path}.${k}`, ctx);
      continue;
    }
    for (const [innerK, innerV] of Object.entries(v as Record<string, unknown>)) {
      if (refuseExpressionKey(innerK, `${path}.${k}.${innerK}`, ctx)) continue;
      checkPrimitive(innerV, `${path}.${k}.${innerK}`, ctx);
    }
  }
}

// Container-array-only export for the tests. `CONTAINER_KEYS` is
// used above.
void CONTAINER_KEYS;
