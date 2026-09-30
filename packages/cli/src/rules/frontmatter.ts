// frontmatter (C1, ADR-0002 + ADR-0005) — extends the component-
// registry rule's allowlist model to YAML frontmatter.
//
// Starlight's `docsSchema` accepts several fields the browser then
// renders as raw HTML or a live URL — enough surface to defeat every
// source-level guard when the frontmatter is left unchecked (bypass
// #4 in PR #23 round-2 review):
//
//   - `head: [{tag: "script", content: "…"}]` — injects `<script>`
//     verbatim into the built `<head>`.
//   - `banner.content: "<img onerror=…>"` — rendered as HTML.
//   - `hero.actions[].link: "javascript:…"` — becomes a live href.
//
// The rule refuses any frontmatter key not on the allowlist, and
// recursively refuses keys inside nested objects (sidebar, hero) the
// same way. URL-carrying fields (`prev.link`, `next.link`,
// `hero.actions[].link` when hero.actions is later accepted per a
// component-specific opt-in) are scheme-checked with `isRefusedUrl`.
//
// Reused for the repo-docs loader's synthesised frontmatter as well
// (the loader is a producer of frontmatter; the shape it emits must
// pass this same allowlist).

import { parseFrontmatter } from "@astrojs/internal-helpers/frontmatter";
import type { Diagnostic } from "../diagnostics.ts";
import { isRefusedUrl } from "../url-scheme.ts";

// Astro's own frontmatter parser (from `@astrojs/internal-helpers`) is
// what the build uses to pull `frontmatter` off a `.md`/`.mdx` file, so
// the guard MUST use the same code path or a differential silently
// re-opens the door (round-3 review: an indented `---` inside a block
// scalar closed the extractor early; a BOM or leading whitespace moved
// the fence past the check; `+++` TOML frontmatter bypassed the YAML
// parse entirely — each rendered raw HTML through Starlight).
//
// On top of Astro's parser we ALSO refuse:
//
//   - BOM at the very first byte (allowed by Astro, refused here so
//     the source is byte-for-byte plain UTF-8).
//   - Any leading whitespace / blank line before the fence (Astro
//     accepts it; content authoring in revkit is strict — the fence
//     is byte 0).
//   - `+++` TOML — revkit content is YAML frontmatter only.
//
// After that, the key allowlist below applies to the parsed object.

/** Top-level keys accepted in content frontmatter. Everything else is
 * a violation. Descriptions (for the diagnostic message when a caller
 * lists what is allowed):
 *
 *   - `title` / `description`: Starlight metadata (strings).
 *   - `template`: `"splash"` | `"doc"` — safe enum, no HTML/URL surface.
 *   - `sidebar`: nested object with a limited sub-allowlist (see
 *     `SIDEBAR_ALLOWED_KEYS`).
 *   - `tableOfContents`: nested object with `minHeadingLevel` /
 *     `maxHeadingLevel` numbers.
 *   - `pagefind`: boolean — indexing hint, no rendered surface.
 *   - `draft`: boolean.
 *   - `lastUpdated`: ISO date string or boolean.
 *   - `prev` / `next`: booleans, strings, or {label, link} — link
 *     scheme-checked.
 *   - `hero`: nested object with `tagline` / `title` / `image` only;
 *     `actions` and `html` are explicitly refused.
 *   - `revkitStatus`: revkit-specific field the repo-docs loader
 *     lifts from an ADR's `- Status:` line. */
const TOP_LEVEL_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "title",
  "description",
  "template",
  "sidebar",
  "tableOfContents",
  "pagefind",
  "draft",
  "lastUpdated",
  "prev",
  "next",
  "hero",
  "revkitStatus",
]);

/** Sub-keys allowed inside `sidebar`. `badge` may be a string OR a
 * {text, variant} object with text/variant only (both strings). */
const SIDEBAR_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "label",
  "order",
  "hidden",
  "badge",
]);

/** Sub-keys allowed inside a `sidebar.badge` object. */
const SIDEBAR_BADGE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "text",
  "variant",
]);

/** Sub-keys allowed inside `hero`. `actions` and `html` are refused
 * outright — no way to smuggle a URL or raw HTML from a hero block. */
const HERO_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "tagline",
  "title",
  "image",
]);

/** Sub-keys allowed inside `hero.image`. Every value must be a
 * relative path string (starts-with-`/` or `.`). No `http(s):`, no
 * `javascript:`, no `data:`. */
const HERO_IMAGE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "file",
  "dark",
  "light",
  "alt",
  "html",
]);

/** Sub-keys allowed on a `prev` / `next` object. */
const NAV_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "label",
  "link",
]);

/** Sub-keys allowed inside `tableOfContents`. */
const TOC_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "minHeadingLevel",
  "maxHeadingLevel",
]);

/** Extract the frontmatter block by delegating to Astro's own parser,
 * so the guard sees the same input Starlight will render. Returns
 * either the parsed object (and its raw text), or a structural
 * refusal — a BOM at byte 0, leading whitespace before the fence, or
 * a `+++` TOML fence — before parsing runs. This keeps guard and
 * build in lockstep and rejects the placements that only Astro
 * accepts. */
export interface FrontmatterExtractResult {
  readonly kind: "empty" | "ok" | "structural-refusal";
  readonly parsed?: Record<string, unknown>;
  readonly rawFrontmatter?: string;
  readonly startLine?: number;
  readonly message?: string;
}

/** Byte-0 fence check: the source must start with `---\n` — no BOM,
 * no leading whitespace / blank lines, no `+++`. Returns a refusal
 * message when the shape is wrong, `null` when it's fine. */
function structuralRefusal(source: string): string | null {
  // Empty file or files with no fence at all: not a frontmatter
  // violation (the file has no frontmatter to check).
  if (source.length === 0) return null;
  const first = source.charCodeAt(0);
  if (first === 0xFEFF) {
    return "frontmatter: BOM at byte 0 is refused (Astro accepts it; revkit content must be plain UTF-8).";
  }
  // No fence anywhere → treat as "no frontmatter", not a refusal.
  if (!/^\s*(?:---|\+\+\+)/.test(source)) return null;
  // `+++` TOML fence at any position (Astro's regex accepts leading
  // whitespace before it): refuse.
  if (/^\s*\+\+\+/.test(source)) {
    return "frontmatter: `+++` TOML fence is refused (revkit content uses YAML frontmatter only).";
  }
  // Leading whitespace before a `---` fence: refuse.
  if (!source.startsWith("---")) {
    return "frontmatter: fence must be at byte 0 (no leading whitespace or blank lines before `---`).";
  }
  return null;
}

export function extractFrontmatterBlock(source: string): FrontmatterExtractResult {
  const refusal = structuralRefusal(source);
  if (refusal !== null) {
    return { kind: "structural-refusal", message: refusal };
  }
  // At this point the source is well-shaped for Astro: `---` at byte 0
  // OR no frontmatter fence at all. Run Astro's parser.
  const { frontmatter, rawFrontmatter } = parseFrontmatter(source);
  if (rawFrontmatter.length === 0) {
    return { kind: "empty" };
  }
  return {
    kind: "ok",
    parsed: frontmatter,
    rawFrontmatter,
    // 1-based line the YAML content starts on (line 2, after the
    // opening `---` on line 1).
    startLine: 2,
  };
}

/** Produce a diagnostic pointing at the frontmatter block for a
 * specific message. `path` is a dot/bracket path into the YAML tree
 * so the reader can find the offending key. */
function fmDiagnostic(
  file: string,
  line: number,
  keyPath: string,
  message: string,
): Diagnostic {
  return {
    file,
    line,
    rule: "component-registry",
    message: `frontmatter (${keyPath}): ${message}`,
  };
}

/** Recursively refuse anything a caller did not opt in to via the
 * allowlist parameter. `parsed` is the value at `keyPath`; `allowed`
 * is the set of sub-keys allowed at this level (or `null` when the
 * caller wants a leaf-only value). */
function walkAllowlist(
  parsed: unknown,
  keyPath: string,
  allowed: ReadonlySet<string>,
  file: string,
  line: number,
  onLeaf: (path: string, value: unknown) => Diagnostic | null,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const leaf = onLeaf(keyPath, parsed);
    if (leaf !== null) out.push(leaf);
    return out;
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!allowed.has(key)) {
      out.push(fmDiagnostic(
        file,
        line,
        `${keyPath}.${key}`,
        `unknown / disallowed key. Allowed: ${[...allowed].join(", ")} (frontmatter allowlist; ADR-0005).`,
      ));
      continue;
    }
    const nested = onLeaf(`${keyPath}.${key}`, value);
    if (nested !== null) out.push(nested);
  }
  return out;
}

/** Recursively refuse any string value in the frontmatter tree that
 * contains `<` or `&`. Round-4 review: Starlight's `Hero.astro`
 * emits `hero.title` / `hero.tagline` through `set:html`, so a
 * tagline string like `<svg><title><img src=x onerror=…></title></svg>`
 * renders as live DOM. The key-shape allowlist already refuses `hero.
 * actions` and `banner.content`; the string-content check closes
 * every remaining `set:html` sink at once — content authors write
 * prose, not markup, so a `<` in a title is a bug anyway. */
function refuseMarkupInStrings(value: unknown, keyPath: string, file: string, line: number, out: Diagnostic[]): void {
  if (typeof value === "string") {
    if (value.includes("<") || value.includes("&")) {
      out.push(fmDiagnostic(
        file,
        line,
        keyPath,
        "string value contains `<` or `&` — refused (Starlight can render frontmatter strings as HTML via set:html; ADR-0005 round-4).",
      ));
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const [i, entry] of value.entries()) {
      refuseMarkupInStrings(entry, `${keyPath}[${i}]`, file, line, out);
    }
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    refuseMarkupInStrings(v, `${keyPath}.${k}`, file, line, out);
  }
}

/** Check one frontmatter object against the top-level allowlist and
 * every nested allowlist. Called on the parsed YAML root; produces
 * diagnostics anchored at `frontmatterLine` (the line the YAML starts
 * on in the source). */
export function checkFrontmatterValue(
  parsed: unknown,
  file: string,
  frontmatterLine: number,
): Diagnostic[] {
  const findings: Diagnostic[] = [];
  if (parsed === null) return findings; // empty frontmatter — OK
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    findings.push(fmDiagnostic(
      file,
      frontmatterLine,
      "(root)",
      "frontmatter must be a YAML mapping (got array / primitive).",
    ));
    return findings;
  }
  const record = parsed as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (!TOP_LEVEL_ALLOWED_KEYS.has(key)) {
      findings.push(fmDiagnostic(
        file,
        frontmatterLine,
        key,
        `unknown / disallowed key. Allowed: ${[...TOP_LEVEL_ALLOWED_KEYS].join(", ")} (frontmatter allowlist; ADR-0005).`,
      ));
      continue;
    }
    findings.push(...checkKey(key, value, file, frontmatterLine));
  }
  // String-content refusal runs regardless of the key allowlist —
  // catches the round-4 Hero set:html sink even when the key that
  // carries the payload (title / tagline / description) is allowed.
  refuseMarkupInStrings(record, "(root)", file, frontmatterLine, findings);
  return findings;
}

/** Dispatch a top-level key to its sub-allowlist checker. */
function checkKey(
  key: string,
  value: unknown,
  file: string,
  line: number,
): Diagnostic[] {
  switch (key) {
    case "title":
    case "description":
    case "revkitStatus":
      return typeof value === "string"
        ? []
        : [fmDiagnostic(file, line, key, "must be a string.")];
    case "template":
      return value === "splash" || value === "doc"
        ? []
        : [fmDiagnostic(file, line, key, "must be \"splash\" or \"doc\".")];
    case "pagefind":
    case "draft":
      return typeof value === "boolean"
        ? []
        : [fmDiagnostic(file, line, key, "must be a boolean.")];
    case "lastUpdated":
      return typeof value === "boolean" || typeof value === "string"
        ? []
        : [fmDiagnostic(file, line, key, "must be a boolean or ISO date string.")];
    case "sidebar":
      return checkSidebar(value, file, line);
    case "tableOfContents":
      return walkAllowlist(value, "tableOfContents", TOC_ALLOWED_KEYS, file, line, (path, v) => {
        if (typeof v === "number") return null;
        return fmDiagnostic(file, line, path, "must be a number.");
      });
    case "prev":
    case "next":
      return checkNav(key, value, file, line);
    case "hero":
      return checkHero(value, file, line);
    default:
      return [];
  }
}

function checkSidebar(value: unknown, file: string, line: number): Diagnostic[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [fmDiagnostic(file, line, "sidebar", "must be an object.")];
  }
  const findings: Diagnostic[] = [];
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (!SIDEBAR_ALLOWED_KEYS.has(key)) {
      findings.push(fmDiagnostic(
        file,
        line,
        `sidebar.${key}`,
        `unknown / disallowed key. Allowed: ${[...SIDEBAR_ALLOWED_KEYS].join(", ")}.`,
      ));
      continue;
    }
    if (key === "label" && typeof v !== "string") {
      findings.push(fmDiagnostic(file, line, "sidebar.label", "must be a string."));
    }
    if (key === "order" && typeof v !== "number") {
      findings.push(fmDiagnostic(file, line, "sidebar.order", "must be a number."));
    }
    if (key === "hidden" && typeof v !== "boolean") {
      findings.push(fmDiagnostic(file, line, "sidebar.hidden", "must be a boolean."));
    }
    if (key === "badge") findings.push(...checkSidebarBadge(v, file, line));
  }
  return findings;
}

function checkSidebarBadge(value: unknown, file: string, line: number): Diagnostic[] {
  if (typeof value === "string") return [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [fmDiagnostic(file, line, "sidebar.badge", "must be a string or {text, variant} object.")];
  }
  const findings: Diagnostic[] = [];
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (!SIDEBAR_BADGE_ALLOWED_KEYS.has(key)) {
      findings.push(fmDiagnostic(
        file,
        line,
        `sidebar.badge.${key}`,
        `unknown / disallowed key. Allowed: ${[...SIDEBAR_BADGE_ALLOWED_KEYS].join(", ")}.`,
      ));
      continue;
    }
    if (typeof v !== "string") {
      findings.push(fmDiagnostic(file, line, `sidebar.badge.${key}`, "must be a string."));
    }
  }
  return findings;
}

function checkNav(key: string, value: unknown, file: string, line: number): Diagnostic[] {
  if (typeof value === "boolean" || typeof value === "string") return [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [fmDiagnostic(file, line, key, "must be a boolean, string, or {label, link} object.")];
  }
  const findings: Diagnostic[] = [];
  for (const [subKey, v] of Object.entries(value as Record<string, unknown>)) {
    if (!NAV_ALLOWED_KEYS.has(subKey)) {
      findings.push(fmDiagnostic(
        file,
        line,
        `${key}.${subKey}`,
        `unknown / disallowed key. Allowed: ${[...NAV_ALLOWED_KEYS].join(", ")}.`,
      ));
      continue;
    }
    if (typeof v !== "string") {
      findings.push(fmDiagnostic(file, line, `${key}.${subKey}`, "must be a string."));
      continue;
    }
    if (subKey === "link" && isRefusedUrl(v)) {
      findings.push(fmDiagnostic(
        file,
        line,
        `${key}.link`,
        "URL uses a refused scheme (javascript:, data:, vbscript:).",
      ));
    }
  }
  return findings;
}

function checkHero(value: unknown, file: string, line: number): Diagnostic[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [fmDiagnostic(file, line, "hero", "must be an object.")];
  }
  const findings: Diagnostic[] = [];
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (!HERO_ALLOWED_KEYS.has(key)) {
      // Explicit friendly error for the three the reviewer highlighted.
      const hint = key === "actions"
        ? " `hero.actions[].link` bypasses attribute URL checks — put the CTA as a body link with a registered component instead."
        : key === "html"
        ? " `hero.html` is raw HTML injection — refused (ADR-0005)."
        : "";
      findings.push(fmDiagnostic(
        file,
        line,
        `hero.${key}`,
        `unknown / disallowed key. Allowed: ${[...HERO_ALLOWED_KEYS].join(", ")}.${hint}`,
      ));
      continue;
    }
    if (key === "tagline" || key === "title") {
      if (typeof v !== "string") {
        findings.push(fmDiagnostic(file, line, `hero.${key}`, "must be a string."));
      }
      continue;
    }
    if (key === "image") findings.push(...checkHeroImage(v, file, line));
  }
  return findings;
}

function checkHeroImage(value: unknown, file: string, line: number): Diagnostic[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [fmDiagnostic(file, line, "hero.image", "must be an object.")];
  }
  const findings: Diagnostic[] = [];
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (!HERO_IMAGE_ALLOWED_KEYS.has(key)) {
      findings.push(fmDiagnostic(
        file,
        line,
        `hero.image.${key}`,
        `unknown / disallowed key. Allowed: ${[...HERO_IMAGE_ALLOWED_KEYS].join(", ")}.`,
      ));
      continue;
    }
    if (typeof v !== "string") {
      findings.push(fmDiagnostic(file, line, `hero.image.${key}`, "must be a string."));
      continue;
    }
    // `html` here is Starlight's own escape hatch on hero.image — refuse
    // it in every form (mirrors the top-level `hero.html` refusal).
    if (key === "html") {
      findings.push(fmDiagnostic(
        file,
        line,
        "hero.image.html",
        "raw HTML in hero.image.html is refused (ADR-0005).",
      ));
      continue;
    }
    if (isRefusedUrl(v)) {
      findings.push(fmDiagnostic(
        file,
        line,
        `hero.image.${key}`,
        "URL uses a refused scheme (javascript:, data:, vbscript:).",
      ));
    }
  }
  return findings;
}

/** Entry point: check the frontmatter of `source` from `file`. */
export function checkFrontmatter(source: string, file: string): Diagnostic[] {
  let block: FrontmatterExtractResult;
  try {
    block = extractFrontmatterBlock(source);
  } catch (error) {
    // Astro's parser throws on malformed YAML / TOML.
    return [{
      file,
      line: 1,
      rule: "component-registry",
      message: `frontmatter: parse error: ${(error as Error).message.split("\n")[0]}`,
    }];
  }
  if (block.kind === "empty") return [];
  if (block.kind === "structural-refusal") {
    return [{
      file,
      line: 1,
      rule: "component-registry",
      message: block.message ?? "frontmatter: structural refusal.",
    }];
  }
  return checkFrontmatterValue(block.parsed ?? null, file, block.startLine ?? 2);
}
