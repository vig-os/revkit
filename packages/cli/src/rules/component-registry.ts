// component-registry (C1, ADR-0002 + ADR-0005): MDX/MD content may import
// only from `@revkit/components` and Starlight's own component modules,
// and may not use raw HTML — `<script>`, `<style>`, `<img>`, `<div>`, an
// inline `style=` attribute, an event handler attribute or a
// `javascript:` URL.
//
// Escape hatch: `{/* revkit-allow: #<n> */}` on the line immediately
// preceding the offending element (ADR-0005). The shape check runs
// offline; the online verification (issue open + labeled
// `component-request`) runs when `--online` is set.

import type { Nodes, Parent } from "mdast";
import type { AllowAnnotation } from "../allow-annotation.ts";
import { parseAllowAnnotation } from "../allow-annotation.ts";
import type { Diagnostic } from "../diagnostics.ts";
import { lineOf, parseSourceFor, walkMdast } from "../mdx-parse.ts";

/** Module specifiers that content is allowed to import from. `@revkit/components`
 * is the registry (ADR-0002); Starlight's built-ins seed the set per ADR-0001,
 * so any subpath of `@astrojs/starlight/components` (Aside, Tabs, Steps, Cards,
 * FileTree, Badge) or `@astrojs/starlight/*` type/util module is permitted.
 * A relative import into a repo-owned component (`../../components/Plot.astro`
 * inside site/src/content) is ALSO permitted, because those live in the
 * allowlisted `site/src/components/**` tree the no-hand-rolled-UI rule
 * checks separately — refusing them here would double-count. */
const ALLOWED_MODULE_PREFIXES: readonly string[] = [
  "@revkit/components",
  "@astrojs/starlight",
];

/** HTML/JSX names that are always forbidden in content, regardless of case:
 * they either run script (`script`), embed styles (`style`) or fetch a
 * remote resource on load (`iframe`, `object`, `embed`, `img`). The check
 * fires for lowercase HTML names (raw HTML in markdown, JSX intrinsics) and
 * for a same-name JSX element with an uppercase alias in components (the
 * message says which). */
const ALWAYS_FORBIDDEN_ELEMENTS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
]);

/** Attribute names that install JS behaviour or a stylesheet on the
 * rendered element. `style` is a raw CSS injection; `on*` are event
 * handlers; `dangerouslySetInnerHTML` is React's inline-HTML escape. */
function isForbiddenAttribute(name: string): boolean {
  if (name === "style") return true;
  if (name === "dangerouslySetInnerHTML") return true;
  return /^on[A-Z]/.test(name) || /^on[a-z]+$/.test(name);
}

/** Import specifiers parsed out of an mdxjsEsm node's raw value. Simple
 * regex over `from "…"` / `from '…'`: the AST-level ESTree walk is more
 * precise but pulls another type-only dep and adds no coverage (a `from`
 * literal can only appear in an import declaration in this position). */
function importsFromEsmValue(value: string): string[] {
  const results: string[] = [];
  const re = /from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    results.push(match[1] as string);
  }
  return results;
}

/** Is `specifier` reachable through one of the allowed prefixes? */
function isAllowedImport(specifier: string): boolean {
  // Relative imports (./foo, ../components/Plot.astro) are handled by the
  // no-hand-rolled-UI rule: they must land under the allowlisted trees.
  if (specifier.startsWith(".")) return true;
  return ALLOWED_MODULE_PREFIXES.some(
    (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`),
  );
}

/** Scan an mdxjsEsm value for any `import` — regex over the raw source
 * (multi-line, all shapes). An `export` line is a re-export; treated as
 * an import for purposes of the registry rule. */
function esmHasDeclarations(value: string): boolean {
  return /(^|\n)\s*(import|export)\b/.test(value);
}

/** Map an element name to its violation category. `null` = OK. */
function elementForbidReason(name: string | null): string | null {
  if (name === null) return null; // fragment
  const lower = name.toLowerCase();
  if (ALWAYS_FORBIDDEN_ELEMENTS.has(lower)) {
    return `<${name}> is not allowed in content — it runs script or embeds an outbound resource. Use @revkit/components or open a component-request issue (ADR-0005).`;
  }
  // Any lowercase JSX name is an intrinsic HTML element in MDX / an inline
  // raw-HTML tag in Markdown. Content must go through the registry.
  if (name === lower && /^[a-z]/.test(name)) {
    return `<${name}> is a raw HTML element; content may only use registered components from @revkit/components (ADR-0002, C1).`;
  }
  return null;
}

/** Walk a JSX element's attributes and produce one diagnostic per
 * violation (style=, on*=, dangerously…, javascript: URLs). */
function attributeDiagnostics(
  element: MdxJsxLike,
  file: string,
): Diagnostic[] {
  const findings: Diagnostic[] = [];
  const line = lineOf(element as unknown as Nodes);
  for (const attr of element.attributes) {
    if (attr.type !== "mdxJsxAttribute") continue;
    const attribute = attr as MdxJsxAttribute;
    if (isForbiddenAttribute(attribute.name)) {
      findings.push({
        file,
        line,
        rule: "component-registry",
        message: `attribute '${attribute.name}' on <${element.name ?? "fragment"}> is not allowed in content (no inline styles, no event handlers; ADR-0002, C1).`,
      });
    }
    // Refuse a `javascript:` URL as the string value of href / src / action —
    // it would run when the reader clicks the link. Values that are JSX
    // expressions (not plain strings) are refused too, because a content
    // expression that hides a JS URL is exactly what this guard blocks.
    if (
      (attribute.name === "href" || attribute.name === "src" || attribute.name === "action")
      && typeof attribute.value === "string"
      && /^\s*javascript:/i.test(attribute.value)
    ) {
      findings.push({
        file,
        line,
        rule: "component-registry",
        message: `attribute '${attribute.name}' on <${element.name ?? "fragment"}> uses a javascript: URL, forbidden in content (ADR-0002, C1).`,
      });
    }
  }
  return findings;
}

/** Minimal projection of the mdx-jsx element types so the module does not
 * pull in mdast-util-mdx-jsx just for a two-field TypeScript check —
 * that package is a peer of remark-mdx and is already reachable at
 * runtime. */
interface MdxJsxLike {
  readonly type: "mdxJsxFlowElement" | "mdxJsxTextElement";
  readonly name: string | null;
  readonly attributes: readonly MdxJsxAttribute[];
}
interface MdxJsxAttribute {
  readonly type: "mdxJsxAttribute" | "mdxJsxExpressionAttribute";
  readonly name: string;
  readonly value: string | { readonly type: string; readonly value?: string } | null;
}

/** Collect every element node's line number together with the line
 * numbers of every `revkit-allow` annotation, so an element can consult
 * the annotation that sits on the line immediately above it. */
interface Annotated {
  readonly element: MdxJsxLike;
  readonly line: number;
  readonly allow: AllowAnnotation | null;
}

/** Gather elements + escape-hatch annotations from an mdast tree.
 * `mdxFlowExpression` / `mdxTextExpression` on the line just before an
 * element node scopes to that element. */
function gatherAnnotated(root: Parent): Annotated[] {
  interface Marker {
    readonly line: number;
    readonly annotation: AllowAnnotation;
  }
  const markers: Marker[] = [];
  const elements: { element: MdxJsxLike; line: number }[] = [];
  walkMdast(root as unknown as Nodes, (node) => {
    if (node.type === "mdxFlowExpression" || node.type === "mdxTextExpression") {
      const value = (node as unknown as { value: string }).value;
      const parsed = parseAllowAnnotation(value);
      if (parsed !== null) {
        markers.push({ line: lineOf(node), annotation: parsed });
      }
      return;
    }
    if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
      elements.push({ element: node as unknown as MdxJsxLike, line: lineOf(node) });
    }
  });
  return elements.map((entry) => {
    // Match the closest annotation on a prior line (allow-annotation may
    // sit one blank line above; a JSX expression consumes at least one
    // line). Look back up to 2 lines to cover both `{/* … */}\n<Foo/>`
    // and `{/* … */}\n\n<Foo/>`.
    const allow = markers.find(
      (marker) => entry.line - marker.line >= 1 && entry.line - marker.line <= 2,
    );
    return { element: entry.element, line: entry.line, allow: allow?.annotation ?? null };
  });
}

/** Regex for raw HTML content of an `html` mdast node that we want to
 * refuse without a full HTML parser. Fires on the opening tag of any
 * always-forbidden element (`<script`, `<style`, `<iframe`, …) with a
 * word boundary so `<styled>` is safe. */
const RAW_HTML_FORBIDDEN = /<\s*(script|style|iframe|object|embed)\b/i;

/** Regex for an inline event handler in raw HTML (`onclick=`, `onLoad=`, …). */
const RAW_HTML_EVENT_HANDLER = /\son[a-zA-Z]+\s*=/;

/** Regex for a `javascript:` URL in raw HTML attributes. */
const RAW_HTML_JS_URL = /(?:href|src|action)\s*=\s*["']\s*javascript:/i;

/** Regex for an inline `style="…"` attribute in raw HTML. */
const RAW_HTML_STYLE_ATTR = /\sstyle\s*=/i;

/** What a raw-HTML violation looks like as diagnostics. */
function rawHtmlDiagnostics(value: string, line: number, file: string): Diagnostic[] {
  const results: Diagnostic[] = [];
  const forbiddenMatch = RAW_HTML_FORBIDDEN.exec(value);
  if (forbiddenMatch) {
    results.push({
      file,
      line,
      rule: "component-registry",
      message: `raw <${forbiddenMatch[1]?.toLowerCase()}> in markdown is not allowed — use a registered component (ADR-0002, C1).`,
    });
  }
  if (RAW_HTML_EVENT_HANDLER.test(value)) {
    results.push({
      file,
      line,
      rule: "component-registry",
      message: "inline event handler attribute in raw HTML is not allowed (ADR-0002, C1).",
    });
  }
  if (RAW_HTML_JS_URL.test(value)) {
    results.push({
      file,
      line,
      rule: "component-registry",
      message: "javascript: URL in raw HTML is not allowed (ADR-0002, C1).",
    });
  }
  if (RAW_HTML_STYLE_ATTR.test(value)) {
    results.push({
      file,
      line,
      rule: "component-registry",
      message: "inline style= attribute in raw HTML is not allowed (ADR-0002, C1).",
    });
  }
  return results;
}

/** Result of checking one file: findings, plus every allow annotation that
 * survived to guard something, so `--online` can verify each one exactly
 * once per file. */
export interface ComponentRegistryFileResult {
  readonly diagnostics: Diagnostic[];
  readonly usedAllowAnnotations: readonly {
    readonly annotation: AllowAnnotation;
    readonly line: number;
  }[];
}

/** Check one MDX / MD file against the component-registry rule. Pure over
 * (source, file) — used from both the CLI orchestrator and unit tests. */
export function checkComponentRegistryFile(
  source: string,
  file: string,
): ComponentRegistryFileResult {
  const root = parseSourceFor(file, source);
  const diagnostics: Diagnostic[] = [];
  const usedAllowAnnotations: {
    annotation: AllowAnnotation;
    line: number;
  }[] = [];

  // 1) Import declarations: only from allowed module prefixes.
  walkMdast(root as unknown as Nodes, (node) => {
    if (node.type !== "mdxjsEsm") return;
    const value = (node as unknown as { value: string }).value;
    if (!esmHasDeclarations(value)) return;
    for (const specifier of importsFromEsmValue(value)) {
      if (!isAllowedImport(specifier)) {
        diagnostics.push({
          file,
          line: lineOf(node),
          rule: "component-registry",
          message: `import from ${JSON.stringify(specifier)} — content may only import from @revkit/components or @astrojs/starlight/* (ADR-0002, C1).`,
        });
      }
    }
  });

  // 2) JSX elements: forbid raw-HTML names, banned attributes, javascript:
  //    URLs. Respect the `{/* revkit-allow: #N */}` annotation per element.
  const annotated = gatherAnnotated(root);
  for (const entry of annotated) {
    const elementViolations: Diagnostic[] = [];
    const reason = elementForbidReason(entry.element.name);
    if (reason !== null) {
      elementViolations.push({
        file,
        line: entry.line,
        rule: "component-registry",
        message: reason,
      });
    }
    elementViolations.push(...attributeDiagnostics(entry.element, file));
    if (elementViolations.length === 0) continue;
    if (entry.allow !== null) {
      usedAllowAnnotations.push({ annotation: entry.allow, line: entry.line });
      continue;
    }
    diagnostics.push(...elementViolations);
  }

  // 3) Raw HTML nodes in markdown source (`<div>hi</div>` outside JSX
  //    context). Same forbidden set as element name check.
  walkMdast(root as unknown as Nodes, (node) => {
    if (node.type !== "html") return;
    const value = (node as unknown as { value: string }).value;
    const line = lineOf(node);
    diagnostics.push(...rawHtmlDiagnostics(value, line, file));
  });

  return { diagnostics, usedAllowAnnotations };
}
