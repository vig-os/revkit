// Build-time Vega-Lite -> Vega -> SVG renderer for the `plots` collection
// (ADR-0004, C4). Called from the `<Plot>` component; extracted as a pure
// function so unit tests can exercise real Vega/Vega-Lite behaviour against
// fixture specs without standing up an Astro build.
//
// - Vega-Lite is compiled to a Vega spec, then parsed and rendered via a
//   `View` in `renderer: 'none'` mode with `toSVG()` — no headless browser
//   or DOM, no client JS shipped to the reader.
// - The file loader is restricted to the spec's directory: `data.url`
//   resolves relative to `specDir`, and any resolved path that escapes it
//   (e.g. `../../etc/passwd`, an HTTP URL, an absolute path) is refused
//   before Vega reads it. This is defence in depth on top of the schema
//   check that already rejects non-sibling URLs (site/src/content/schemas/plots.ts).
// - The returned SVG is sanitised: any `<script>` element or `on*` /
//   `javascript:` handler that would run in the DOM is stripped, so the
//   fragment is safe to inline inside a page under the ADR-0012 CSP
//   (`default-src 'none'`, no inline scripts outside the revkit hash
//   allowlist). Vega's SVG renderer does not emit scripts today; the strip
//   is a permanent contract, not a bug workaround.

import type { View } from "vega";
import {
  parse as vegaParse,
  View as VegaView,
  loader as vegaLoader,
  Error as VegaError,
} from "vega";
import { compile as vegaLiteCompile } from "vega-lite";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

/** Options for {@link renderPlotToSvg}. */
export interface RenderPlotOptions {
  /** Absolute path to the directory that holds the spec and its sibling
   * data files. Every `data.url` in the spec is resolved against this
   * directory and MUST land inside it. */
  specDir: string;
  /** Optional accessible name. Rendered inside the SVG as `<title>` so
   * assistive tech announces it. Falls back to the spec's `title` /
   * `description`; empty when neither is present. */
  accessibleName?: string;
  /** Optional accessible description. Rendered inside the SVG as `<desc>`. */
  accessibleDescription?: string;
}

/** A Vega-Lite spec — kept as `unknown` so the caller decides how to type
 * it. The spec is validated by the plots schema (ADR-0004) before it
 * reaches us; here we treat it as opaque JSON. */
export type PlotSpec = unknown;

/** Loader adapter shape Vega expects. We build one that reads only files
 * under {@link RenderPlotOptions.specDir}. */
interface RestrictedLoader {
  load(uri: string, options?: { type?: string }): Promise<string>;
  sanitize(uri: string, options?: { type?: string }): Promise<{ href: string }>;
  http?: (uri: string) => Promise<string>;
  file?: (filename: string) => Promise<string>;
}

/** Build a Vega loader that resolves data URLs relative to `specDir` and
 * refuses anything that would escape it — no HTTP fetches, no absolute
 * paths, no `..` traversal. Overrides `sanitize`, `load`, `file` and
 * `http` on the base loader so every path Vega uses to fetch a dataset
 * flows through the sibling-directory check. */
function buildRestrictedLoader(specDir: string): RestrictedLoader {
  const baseVegaLoader = vegaLoader();
  const normalisedSpecDir = specDir.endsWith(sep) ? specDir.slice(0, -1) : specDir;

  async function resolveInside(uri: string): Promise<string> {
    if (typeof uri !== "string" || uri.length === 0) {
      throw new Error(`plot loader refused an empty uri`);
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) {
      throw new Error(`plot loader refused a scheme-qualified uri: ${uri}`);
    }
    if (isAbsolute(uri)) {
      throw new Error(`plot loader refused an absolute path: ${uri}`);
    }
    const resolved = resolve(normalisedSpecDir, uri);
    if (
      resolved !== normalisedSpecDir &&
      !resolved.startsWith(`${normalisedSpecDir}${sep}`)
    ) {
      throw new Error(
        `plot loader refused to read outside the spec dir: ${uri} ` +
          `(resolved to ${resolved}, spec dir ${normalisedSpecDir})`,
      );
    }
    return resolved;
  }

  // Start from the base loader (so any helper Vega reaches for still
  // exists), then override every code path that could fetch data. The
  // spread comes FIRST so the overrides win.
  return {
    ...(baseVegaLoader as unknown as Record<string, unknown>),
    async sanitize(uri: string) {
      const absolute = await resolveInside(uri);
      return { href: absolute };
    },
    async load(uri: string) {
      const absolute = await resolveInside(uri);
      return readFile(absolute, "utf8");
    },
    async file(filename: string) {
      const absolute = await resolveInside(filename);
      return readFile(absolute, "utf8");
    },
    async http() {
      throw new Error(`plot loader refused an HTTP fetch (data.url must be a sibling file)`);
    },
  } as unknown as RestrictedLoader;
}

/** Strip `<script>` elements and inline event / `javascript:` handlers
 * from an SVG fragment so it is safe to inline in an HTML page under the
 * ADR-0012 CSP. Applied unconditionally — Vega's SVG renderer does not
 * emit scripts today and never should for us. */
export function stripScriptsFromSvg(svg: string): string {
  return svg
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\bjavascript:/gi, "");
}

/** Read a spec's `title` and `description` (Vega-Lite grammar) into plain
 * strings, if they exist. Kept small — full spec shape is opaque to us. */
function extractSpecMetadata(spec: PlotSpec): { title?: string; description?: string } {
  if (spec === null || typeof spec !== "object") return {};
  const record = spec as Record<string, unknown>;
  const out: { title?: string; description?: string } = {};
  if (typeof record.title === "string") out.title = record.title;
  else if (record.title !== null && typeof record.title === "object") {
    const textValue = (record.title as Record<string, unknown>).text;
    if (typeof textValue === "string") out.title = textValue;
  }
  if (typeof record.description === "string") out.description = record.description;
  return out;
}

/** Escape text before inserting it inside an SVG `<title>` / `<desc>`. */
function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape an attribute value inserted inside an SVG root tag. */
function escapeXmlAttribute(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Turn a Vega SVG fragment into an accessible inline SVG:
 * - The root `<svg>` gets `role="img"` and `aria-label="<name>"` (unless
 *   an existing `role`/`aria-label` is already present, in which case the
 *   caller wins).
 * - A `<title>` element is inserted after the opening tag so a hovered
 *   plot surfaces its name as a tooltip, and a `<desc>` when a
 *   description was provided.
 *
 * When both `name` and `description` are absent, the SVG is returned
 * unchanged — the caller can then wrap it or hide it with `aria-hidden`.
 */
function injectAccessibleLabels(
  svg: string,
  name: string | undefined,
  description: string | undefined,
): string {
  const openMatch = svg.match(/^\s*<svg\b[^>]*>/i);
  if (!openMatch) return svg;
  let openTag = openMatch[0];

  if (name && !/\brole\s*=/.test(openTag)) {
    openTag = openTag.replace(/<svg\b/, '<svg role="img"');
  }
  if (name && !/\baria-label\s*=/.test(openTag)) {
    openTag = openTag.replace(
      /<svg\b/,
      `<svg aria-label="${escapeXmlAttribute(name)}"`,
    );
  }

  const inner: string[] = [];
  if (name) inner.push(`<title>${escapeXmlText(name)}</title>`);
  if (description) inner.push(`<desc>${escapeXmlText(description)}</desc>`);

  return `${openTag}${inner.join("")}${svg.slice(openMatch[0].length)}`;
}

/**
 * Render a Vega-Lite {@link PlotSpec} to a static SVG string.
 *
 * The spec must have already passed the plots schema (ADR-0004); this
 * function does not re-validate its shape. Missing data files, restricted
 * URLs, or a Vega-Lite / Vega compilation error surface as thrown errors
 * — the caller (a build-time component) should let them propagate so the
 * build fails loudly rather than shipping an empty plot.
 */
export async function renderPlotToSvg(
  spec: PlotSpec,
  options: RenderPlotOptions,
): Promise<string> {
  const { spec: vegaSpec } = vegaLiteCompile(
    spec as Parameters<typeof vegaLiteCompile>[0],
  );
  const runtime = vegaParse(vegaSpec);
  const loader = buildRestrictedLoader(options.specDir);

  // Vega's default logger swallows data-load failures as `warn` logs and
  // the View still renders — an empty scenegraph, but no thrown error.
  // That is the exact "silently ships an empty plot" regression ADR-0004
  // warns against, so a custom logger watches for the two signatures a
  // failed data fetch produces ("Loading failed …" from Vega itself, and
  // the "plot loader refused …" strings thrown by our restricted loader)
  // and we re-throw after the dataflow settles.
  const loadErrors: string[] = [];
  function isLoadFailure(message: string): boolean {
    return (
      message.includes("Loading failed") || message.includes("plot loader refused")
    );
  }
  function formatArgs(args: readonly unknown[]): string {
    return args
      .map((a) => (a instanceof Error ? a.message : String(a)))
      .join(" ");
  }
  const capturingLogger = {
    level(): number {
      return VegaError;
    },
    error(...args: unknown[]) {
      loadErrors.push(formatArgs(args));
      return capturingLogger;
    },
    warn(...args: unknown[]) {
      const formatted = formatArgs(args);
      if (isLoadFailure(formatted)) loadErrors.push(formatted);
      return capturingLogger;
    },
    info() {
      return capturingLogger;
    },
    debug() {
      return capturingLogger;
    },
  };

  const view: View = new VegaView(runtime, {
    renderer: "none",
    loader: loader as unknown as ReturnType<typeof vegaLoader>,
  });
  // Vega exposes `logger(custom)` on the inherited Dataflow prototype
  // (not the View class itself), so replacing the default console logger
  // is a runtime method call rather than a constructor option.
  (view as unknown as { logger: (l: unknown) => unknown }).logger(capturingLogger);
  try {
    // Vega 6's `View.toSVG()` no longer awaits the async dataflow before
    // rendering — a plot whose `data.url` is still loading would emit an
    // empty scenegraph (paths but no marks). Running the dataflow
    // explicitly first waits for the sibling data file to arrive through
    // the restricted loader before the SVG is produced.
    await view.runAsync();
    if (loadErrors.length > 0) {
      throw new Error(`plot render failed: ${loadErrors.join("; ")}`);
    }
    const svg = await view.toSVG();
    const meta = extractSpecMetadata(spec);
    const name = options.accessibleName ?? meta.title;
    const description = options.accessibleDescription ?? meta.description;
    return stripScriptsFromSvg(injectAccessibleLabels(svg, name, description));
  } finally {
    // `View.finalize` releases the runtime's timers / subscriptions so the
    // build process exits cleanly after rendering many plots.
    view.finalize();
  }
}
