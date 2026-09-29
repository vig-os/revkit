// component-registry (C1, ADR-0002 + ADR-0005).
//
// **Allowlist, not blocklist**: content may
//   - import ONLY from `@revkit/components` (and subpaths, e.g.
//     `@revkit/components/Plot`) or Starlight's component module
//     (`@astrojs/starlight/components`)
//   - run ONLY plain `import` statements at the top of an ESM block —
//     no `export`, no top-level await, no side-effect-only import
//   - use ONLY JSX component names that are bound by one of those
//     imports (an uppercase JSX tag whose binding is not imported is
//     refused as a code smuggler)
//   - carry ONLY comment-only `{/* … */}` expressions — every other
//     `mdxFlowExpression` / `mdxTextExpression` is a violation
//   - pass attributes whose values are either plain string literals or
//     statically-evaluable literal expressions (string / number /
//     boolean / null, or arrays / objects of those) — no spreads, no
//     template literals with substitutions, no identifiers
//   - never carry `style`, event handlers (`on*`), `dangerouslySet-
//     InnerHTML`, or a URL-bearing attribute whose value (after HTML-
//     entity decoding, whitespace + control-char stripping and
//     lowercasing) starts with `javascript:`, `data:` or `vbscript:`.
//
// `.md` raw HTML rule: only HTML comments are allowed as raw HTML —
// anything else is a violation (defensive allowlist mirroring the
// reason `<!-- guardrails:derived cmd="…" -->` needs to survive).
//
// Escape hatch: `{/* revkit-allow: #N */}` exempts EXACTLY the next
// sibling JSX element (never a line-window scan). ADR-0005: the issue
// must exist, be open and carry the exact label `component-request`
// (the `--online` verifier lives in `allow-annotation.ts`).

import type { Nodes, Parent } from "mdast";
import type { AllowAnnotation } from "../allow-annotation.ts";
import { parseAllowAnnotation } from "../allow-annotation.ts";
import type { Diagnostic } from "../diagnostics.ts";
import { lineOf, parseSourceFor, walkMdast } from "../mdx-parse.ts";
import type { EsmAnalysis } from "../mdx-imports.ts";
import { analyseEsm, looksLikeDynamicImport } from "../mdx-imports.ts";
import {
  evalStaticExpression,
  isStaticExpression,
  unwrapProgramExpression,
} from "../static-eval.ts";
import { REFUSED_URL_SCHEMES, URL_BEARING_ATTRIBUTES, isRefusedUrl } from "../url-scheme.ts";

/** Module specifiers content is allowed to import from. Case-sensitive
 * (npm names are case-sensitive) and NEVER relative — every registered
 * component lives under `@revkit/components` (a `.astro` proxy is a
 * legitimate subpath, e.g. `@revkit/components/Plot`). Starlight's
 * built-ins reach content only through its published component module
 * (`@astrojs/starlight/components`); other Starlight subpaths (types,
 * config helpers) are for site plumbing, never for content. */
const ALLOWED_IMPORT_SPECIFIERS: readonly string[] = [
  "@revkit/components",
  "@astrojs/starlight/components",
];

/** Return `true` when `specifier` names one of the allowed roots
 * exactly or one of their subpaths (`@revkit/components/Plot`).
 * Relative imports (`./`, `../`) always return `false` — content
 * imports the registered set by bare specifier only. */
export function isAllowedImportSpecifier(specifier: string): boolean {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  // Test-only paths are never importable, no matter which root they
  // sit under — a fixture or unit test is not a registered component.
  if (/(?:^|\/)([^/]+\.)?test(?:\.[jt]sx?)?(?:$|\/)/i.test(specifier)) return false;
  return ALLOWED_IMPORT_SPECIFIERS.some(
    (root) => specifier === root || specifier.startsWith(`${root}/`),
  );
}

/** Attribute names never allowed on a content element. `style` is
 * refused in every form (string or expression); `dangerouslySetInner-
 * HTML` bypasses the DOM sanitiser; `on*` names install script. Also
 * refused: SVG's `xlink:href` isn't in this set — its URL variant is
 * handled by URL_BEARING_ATTRIBUTES; the string-only refusal here is
 * for the JSX-attribute pass-through, e.g. `style={...}`. */
const REFUSED_ATTRIBUTE_NAMES: ReadonlySet<string> = new Set([
  "style",
  "dangerouslySetInnerHTML",
]);

function isEventHandlerAttribute(name: string): boolean {
  // Both React-style camelCase (`onClick`) and lowercase HTML
  // (`onclick`) — allow either through the JSX parser, refuse both.
  return /^on[A-Z]/.test(name) || /^on[a-z]+$/.test(name);
}

/** Minimal MdxJsx projection — matches the runtime shape from
 * remark-mdx without pulling the mdast-util-mdx-jsx type-only import. */
interface MdxJsxLike {
  readonly type: "mdxJsxFlowElement" | "mdxJsxTextElement";
  readonly name: string | null;
  readonly attributes: readonly MdxJsxAttrLike[];
}

interface MdxJsxAttrLike {
  readonly type: "mdxJsxAttribute" | "mdxJsxExpressionAttribute";
  readonly name?: string;
  readonly value?: string | MdxJsxAttrValueExpr | null;
}

interface MdxJsxAttrValueExpr {
  readonly type: "mdxJsxAttributeValueExpression";
  readonly value: string;
  readonly data?: { readonly estree?: unknown };
}

/** Every JSX component name a content author uses must resolve to an
 * import binding. Uppercase-first name = component; lowercase = HTML
 * intrinsic (already refused earlier). Dotted names like `Icons.Foo`
 * resolve on the head identifier. Returns the head identifier when it
 * is component-shaped (uppercase), `null` otherwise. */
function headComponentName(name: string | null): string | null {
  if (name === null) return null;
  const head = name.split(".")[0] ?? "";
  if (head.length === 0) return null;
  const firstChar = head[0] ?? "";
  return firstChar >= "A" && firstChar <= "Z" ? head : null;
}

/** Regex for a JSX comment-only expression body: whitespace + one or
 * more JS block/line comments and nothing else. `{/* … *\/}` is the
 * only expression form allowed in content — anything with executable
 * substance is smuggling code into a docs page. */
function isCommentOnlyExpression(rawValue: string): boolean {
  const stripped = rawValue
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  return /^\s*$/.test(stripped);
}

/** Extract the attribute name from an MdxJsxAttribute; returns "" for
 * an expression-attribute (`{...spread}`), which the caller flags
 * separately. */
function attributeName(attribute: MdxJsxAttrLike): string {
  return typeof attribute.name === "string" ? attribute.name : "";
}

/** Attribute-value inspection produces at most one diagnostic per
 * attribute (the first, most-specific failure). Returns `null` when
 * the attribute is fine. `attrLine` is passed in so the diagnostic
 * points at the element line, not the attribute-specific line (mdast
 * position for attributes is often the same as the element line). */
function attributeValueDiagnostic(
  element: MdxJsxLike,
  attribute: MdxJsxAttrLike,
  file: string,
  elementLine: number,
): Diagnostic | null {
  const name = attributeName(attribute);
  const displayName = element.name ?? "fragment";

  // 1) Spread: `{...whatever}` — refused unconditionally. A spread
  //    could smuggle in a `style` prop, an `onClick`, a `dangerously-`
  //    field. The allowlist model refuses it whether or not the RHS is
  //    static — a reviewer scanning content should see EVERY attribute
  //    the element carries.
  if (attribute.type === "mdxJsxExpressionAttribute") {
    return {
      file,
      line: elementLine,
      rule: "component-registry",
      message: `<${displayName}> uses a spread attribute — refused (attributes must be named + statically-evaluable literals; ADR-0002, C1).`,
    };
  }

  // 2) Refused-by-name (style, dangerouslySetInnerHTML, on* handlers).
  if (REFUSED_ATTRIBUTE_NAMES.has(name) || isEventHandlerAttribute(name)) {
    return {
      file,
      line: elementLine,
      rule: "component-registry",
      message: `attribute '${name}' on <${displayName}> is refused (no inline styles, event handlers or dangerouslySetInnerHTML in content; ADR-0002, C1).`,
    };
  }

  // 3) Value shape: string OK, or an mdxJsxAttributeValueExpression
  //    whose estree is a statically-evaluable literal.
  const value = attribute.value;
  let resolved: unknown;
  if (typeof value === "string") {
    resolved = value;
  } else if (value === null || value === undefined) {
    // Boolean attribute (`<Foo required>`) — nothing to evaluate.
    resolved = true;
  } else {
    const expr = unwrapProgramExpression(value.data?.estree);
    if (expr === null || !isStaticExpression(expr)) {
      return {
        file,
        line: elementLine,
        rule: "component-registry",
        message: `attribute '${name}' on <${displayName}> has a non-static expression value — refused (only literal strings / numbers / booleans / null and arrays/objects of those; ADR-0002, C1).`,
      };
    }
    resolved = evalStaticExpression(expr);
  }

  // 4) URL-bearing attribute: check the resolved string, if it IS a
  //    string, against the refused scheme set.
  if (URL_BEARING_ATTRIBUTES.has(name.toLowerCase()) && typeof resolved === "string") {
    if (isRefusedUrl(resolved)) {
      return {
        file,
        line: elementLine,
        rule: "component-registry",
        message: `attribute '${name}' on <${displayName}> uses a refused URL scheme (one of: ${[...REFUSED_URL_SCHEMES].join(", ")}); refused after HTML-entity decoding and whitespace/control-char strip (ADR-0002, C1).`,
      };
    }
  }

  return null;
}

/** Line-cased HTML entities a `.md` raw-HTML node may contain. Only
 * comments are legal; `<`, `>`, `"` inside prose are fine, but a
 * complete tag is not. */
const HTML_COMMENT_ONLY = /^\s*(?:<!--[\s\S]*?-->\s*)+$/;

/** Diagnostics for one `html` mdast node. Because the allowlist is a
 * whitelist ("only HTML comments"), the check is a single regex; if it
 * fails, the whole raw-HTML value is flagged with one diagnostic. */
function rawHtmlDiagnostic(
  value: string,
  line: number,
  file: string,
): Diagnostic | null {
  if (HTML_COMMENT_ONLY.test(value)) return null;
  // Take the first non-comment character run as the excerpt so the
  // reader sees WHICH tag started the trouble.
  const withoutComments = value.replace(/<!--[\s\S]*?-->/g, "").trim();
  const excerpt = withoutComments.slice(0, 60);
  return {
    file,
    line,
    rule: "component-registry",
    message: `raw HTML in content is not allowed (only <!-- comments -->). First offender: ${JSON.stringify(excerpt)}. Use a registered component (ADR-0002, C1).`,
  };
}

/** Iterate every parent node's children in order, invoking `visit`
 * for each (child, prevSibling) pair. Used to implement the escape-
 * hatch's exact-sibling adjacency check. */
function forEachChild(
  root: Parent,
  visit: (child: Nodes, prev: Nodes | null, parent: Parent) => void,
): void {
  // DFS on parents; recurse into their children lists in order.
  const parents: Parent[] = [root];
  while (parents.length > 0) {
    const parent = parents.pop() as Parent;
    const children = parent.children as readonly Nodes[];
    let previous: Nodes | null = null;
    for (const child of children) {
      visit(child, previous, parent);
      if ((child as Parent).children !== undefined) {
        parents.push(child as Parent);
      }
      previous = child;
    }
  }
}

/** Result of checking one file. */
export interface ComponentRegistryFileResult {
  readonly diagnostics: Diagnostic[];
  readonly usedAllowAnnotations: readonly {
    readonly annotation: AllowAnnotation;
    readonly line: number;
  }[];
}

/** Check one MDX / MD file against the component-registry rule. */
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

  // Phase 1: ESM analysis — collect import bindings, refuse anything
  // that is not a plain `import` declaration, refuse imports from a
  // specifier outside the allowlist. The resulting binding set is
  // used to check JSX component names in phase 3.
  const importedNames = new Set<string>();
  walkMdast(root as unknown as Nodes, (node) => {
    if (node.type !== "mdxjsEsm") return;
    const line = lineOf(node);
    const value = (node as unknown as { value: string; data?: { estree?: unknown } });
    if (value.value.trim().length === 0) return;
    const analysis: EsmAnalysis = analyseEsm(value.data?.estree, line);
    for (const violation of analysis.violations) {
      diagnostics.push({
        file,
        line: violation.line,
        rule: "component-registry",
        message: violation.message,
      });
    }
    for (const binding of analysis.bindings) {
      if (!isAllowedImportSpecifier(binding.specifier)) {
        diagnostics.push({
          file,
          line: binding.line,
          rule: "component-registry",
          message: `import from ${JSON.stringify(binding.specifier)} — content may only import from ${ALLOWED_IMPORT_SPECIFIERS.map((s) => JSON.stringify(s)).join(" or ")} (ADR-0002, C1).`,
        });
        continue;
      }
      importedNames.add(binding.localName);
    }
  });

  // Phase 2: expressions — refuse everything except comment-only.
  // Escape-hatch annotations count as "comment-only" and are captured
  // for phase 3's escape-hatch matching.
  const annotationBySibling = new Map<Nodes, AllowAnnotation>();
  forEachChild(root, (child, prev, _parent) => {
    if (child.type !== "mdxFlowExpression" && child.type !== "mdxTextExpression") return;
    const rawValue = (child as unknown as { value: string }).value;
    const line = lineOf(child);
    const annotation = parseAllowAnnotation(rawValue);
    if (annotation !== null) {
      // The exempt sibling is the NEXT sibling — resolved later when
      // phase 3 sees the element (we key by the annotation node here
      // and match in phase 3 by "prev is this node").
      annotationBySibling.set(child, annotation);
      return;
    }
    if (isCommentOnlyExpression(rawValue)) return;
    // Non-comment expression: refuse. Pin the message to the shape so
    // the reader knows what was blocked.
    const looksDynamic = looksLikeDynamicImport(rawValue);
    diagnostics.push({
      file,
      line,
      rule: "component-registry",
      message: looksDynamic
        ? "dynamic `import(...)` expression in content is not allowed (content is data, not a module; ADR-0002, C1)."
        : "expression in content is not allowed (only `{/* comments */}` — no executable expressions; ADR-0002, C1).",
    });
    void prev;
  });

  // Phase 3: JSX elements — refuse lowercase / HTML tags, refuse
  // component names that are not in `importedNames`, walk attributes,
  // honour the escape-hatch annotation attached to the immediately
  // preceding sibling.
  forEachChild(root, (child, prev, _parent) => {
    if (child.type !== "mdxJsxFlowElement" && child.type !== "mdxJsxTextElement") return;
    const element = child as unknown as MdxJsxLike;
    const line = lineOf(child);
    const displayName = element.name ?? "fragment";

    const elementFindings: Diagnostic[] = [];

    // Head-component check: uppercase JSX name must be an imported
    // binding. `null` (a fragment) is fine. Lowercase names are HTML
    // intrinsics — refused unconditionally.
    if (element.name !== null) {
      const first = element.name[0] ?? "";
      const isComponent = first >= "A" && first <= "Z";
      if (!isComponent) {
        elementFindings.push({
          file,
          line,
          rule: "component-registry",
          message: `<${displayName}> is a raw HTML element; content must use registered components from ${ALLOWED_IMPORT_SPECIFIERS[0]} (ADR-0002, C1).`,
        });
      } else {
        const head = headComponentName(element.name);
        if (head !== null && !importedNames.has(head)) {
          elementFindings.push({
            file,
            line,
            rule: "component-registry",
            message: `<${displayName}> is used without an allowed import — component names must be bound by an import from ${ALLOWED_IMPORT_SPECIFIERS[0]} or ${ALLOWED_IMPORT_SPECIFIERS[1]} (ADR-0002, C1).`,
          });
        }
      }
    }

    // Attribute checks.
    for (const attribute of element.attributes) {
      const diagnostic = attributeValueDiagnostic(element, attribute, file, line);
      if (diagnostic !== null) elementFindings.push(diagnostic);
    }

    if (elementFindings.length === 0) return;

    // Escape hatch: the previous sibling being an allow-annotation
    // exempts THIS element (exactly one). The annotation is
    // consumed — a second element on the same parent needs its own
    // annotation.
    const annotation = prev !== null ? annotationBySibling.get(prev) ?? null : null;
    if (annotation !== null) {
      usedAllowAnnotations.push({ annotation, line });
      annotationBySibling.delete(prev as Nodes);
      return;
    }
    diagnostics.push(...elementFindings);
  });

  // Phase 4: raw HTML nodes (only in `.md`, since `.mdx` parses raw
  // HTML as JSX or expressions). Allowlist = comments only.
  walkMdast(root as unknown as Nodes, (node) => {
    if (node.type !== "html") return;
    const value = (node as unknown as { value: string }).value;
    const finding = rawHtmlDiagnostic(value, lineOf(node), file);
    if (finding !== null) diagnostics.push(finding);
  });

  return { diagnostics, usedAllowAnnotations };
}
