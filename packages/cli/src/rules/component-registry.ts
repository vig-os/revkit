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
 * imports the registered set by bare specifier only. `..` anywhere
 * in the specifier (e.g. `@revkit/components/../evil`) also refuses,
 * so a subpath cannot walk out of the allowed root. */
export function isAllowedImportSpecifier(specifier: string): boolean {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  // Path traversal: reject any `..` segment inside the specifier. A
  // resolver may treat `@revkit/components/../secrets/env` as reaching
  // outside the root; refuse it at the syntax level, not by trusting
  // the resolver to be strict.
  if (specifier.split("/").some((segment) => segment === "..")) return false;
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

// Comment-only expression check driven by the estree, NOT by a
// regex — a regex disagrees with the JS parser on inputs where a
// line comment on one line hides real JSX in the middle and another
// line comment on the last line hides a block-comment closer at the
// end. A naive block-comment stripper reads the whole thing as one
// long comment; the real parser reads it as "line comment, then JSX,
// then line comment" (bypass #1 in PR #23 round 2 review).
//
// Rule: comments-only means the ESTree Program has an empty `body`
// (whitespace and comments live on `Program.comments` from
// `estree-util-visit`-style parsers, not in `body`). Anything with
// executable substance produces at least one body node.
function isCommentOnlyExpression(estree: unknown): boolean {
  if (estree === null || typeof estree !== "object") return false;
  const program = estree as { type?: string; body?: readonly unknown[] };
  if (program.type !== "Program") return false;
  return Array.isArray(program.body) && program.body.length === 0;
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
  //    whose estree is a statically-evaluable primitive Literal
  //    (string / number / boolean / null) — arrays and objects are
  //    refused on ALL attributes (no per-component schema exists yet,
  //    so we default-deny; without this, a `href={["javascript:…"]}`
  //    array-typed URL still reaches the DOM through JSX's
  //    array-to-string coercion — bypass #2 in the round-2 review).
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
        message: `attribute '${name}' on <${displayName}> has a non-static expression value — refused (only literal strings / numbers / booleans / null; ADR-0002, C1).`,
      };
    }
    // Refuse Array / Object expression values on ALL attributes — no
    // per-component schema, no coercion surface. A URL attribute
    // gets a stricter branch below (string / number only).
    const exprType = (expr as { type?: string }).type;
    if (exprType === "ArrayExpression" || exprType === "ObjectExpression") {
      return {
        file,
        line: elementLine,
        rule: "component-registry",
        message: `attribute '${name}' on <${displayName}> uses an array/object expression — refused (attributes must be primitive literals; ADR-0002, C1).`,
      };
    }
    resolved = evalStaticExpression(expr);
  }

  // 4) URL-bearing attribute: after the array/object refusal above the
  //    resolved value can only be a string, number, boolean or null.
  //    Refuse boolean/null there too (a URL is not a boolean) and
  //    scheme-check the string form.
  if (URL_BEARING_ATTRIBUTES.has(name.toLowerCase())) {
    if (typeof resolved !== "string" && typeof resolved !== "number") {
      return {
        file,
        line: elementLine,
        rule: "component-registry",
        message: `attribute '${name}' on <${displayName}> must be a string or number URL (got ${JSON.stringify(resolved)}).`,
      };
    }
    if (typeof resolved === "string" && isRefusedUrl(resolved)) {
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

/** Linear-scan check that `value` contains only ASCII whitespace and
 * complete HTML comments (`<!-- … -->`). Written by hand instead of a
 * regex because the regex form (`^\s*(?:<!--[\s\S]*?-->\s*)+$`) can
 * backtrack exponentially on `<!--<!--…` inputs (CodeQL js/redos) and
 * a linear scan proves that impossible. Uses `indexOf` for the closing
 * `-->` which is O(n) with no backtracking. */
function isCommentsOnlyHtml(value: string): boolean {
  let index = 0;
  const length = value.length;
  while (index < length) {
    while (index < length && isAsciiWhitespace(value.charCodeAt(index))) index += 1;
    if (index >= length) return true;
    if (value.charCodeAt(index) !== 0x3C /* < */) return false;
    if (value.slice(index, index + 4) !== "<!--") return false;
    const closeIndex = value.indexOf("-->", index + 4);
    if (closeIndex === -1) return false;
    index = closeIndex + 3;
  }
  return true;
}

/** Find the first non-whitespace, non-comment character run in `value`
 * and return up to `maxLength` characters starting there. Used to build
 * an error-message excerpt without a regex `.replace()` that could hide
 * `<!--` inside its output (CodeQL js/incomplete-multi-character-
 * sanitization). Linear scan, no backtracking. */
function firstNonCommentExcerpt(value: string, maxLength: number): string {
  let index = 0;
  const length = value.length;
  while (index < length) {
    if (isAsciiWhitespace(value.charCodeAt(index))) {
      index += 1;
      continue;
    }
    if (value.slice(index, index + 4) === "<!--") {
      const closeIndex = value.indexOf("-->", index + 4);
      if (closeIndex === -1) return "";
      index = closeIndex + 3;
      continue;
    }
    return value.slice(index, index + maxLength);
  }
  return "";
}

/** WHATWG ASCII whitespace set (tab, LF, FF, CR, space). Matches the
 * set the `.replace(/\s+/, "")` call would have used, without a regex
 * engine. */
function isAsciiWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0C || code === 0x0D;
}

/** Diagnostics for one `html` mdast node. Because the allowlist is a
 * whitelist ("only HTML comments"), a linear scan is enough; if the
 * scan refuses the value, the whole raw-HTML node is flagged with one
 * diagnostic naming the first offending run. */
function rawHtmlDiagnostic(
  value: string,
  line: number,
  file: string,
): Diagnostic | null {
  if (isCommentsOnlyHtml(value)) return null;
  const excerpt = firstNonCommentExcerpt(value, 60);
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

/** Turn a parse-time exception into a `file:line: rule: message`
 * diagnostic. remark-mdx / micromark set `.line` / `.column` /
 * `.place` on their VFileMessage-flavoured errors; a plain `Error`
 * falls back to line 0 (the whole file). */
function parseErrorDiagnostic(error: unknown, file: string): Diagnostic {
  let line = 0;
  let reason = "";
  if (error !== null && typeof error === "object") {
    const err = error as {
      line?: number;
      column?: number;
      place?: { line?: number };
      reason?: string;
      message?: string;
    };
    line = err.line ?? err.place?.line ?? 0;
    reason = typeof err.reason === "string" ? err.reason : (err.message ?? "");
  }
  return {
    file,
    line,
    rule: "component-registry",
    message: `parse error: ${reason.split("\n")[0] ?? "(no message)"}`,
  };
}

/** Result of checking one file. */
export interface ComponentRegistryFileResult {
  readonly diagnostics: Diagnostic[];
  readonly usedAllowAnnotations: readonly {
    readonly annotation: AllowAnnotation;
    readonly line: number;
  }[];
}

/** Check one MDX / MD file against the component-registry rule. A
 * parse error surfaces as a `file:line: component-registry: parse …`
 * diagnostic — never a raw micromark / acorn stack — so the CLI's
 * output stays legible in a pre-commit log (nit 1 in the round-2
 * review). `preparsedRoot` lets the orchestrator hand a shared parse
 * to every rule that reads the same file. */
export function checkComponentRegistryFile(
  source: string,
  file: string,
  preparsedRoot?: Parent,
): ComponentRegistryFileResult {
  let root: Parent;
  try {
    root = preparsedRoot ?? parseSourceFor(file, source);
  } catch (error) {
    return {
      diagnostics: [parseErrorDiagnostic(error, file)],
      usedAllowAnnotations: [],
    };
  }
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
    const estree = (child as unknown as { data?: { estree?: unknown } }).data?.estree;
    const line = lineOf(child);
    const annotation = parseAllowAnnotation(rawValue);
    if (annotation !== null) {
      // The exempt sibling is the NEXT sibling — resolved later when
      // phase 3 sees the element (we key by the annotation node here
      // and match in phase 3 by "prev is this node").
      annotationBySibling.set(child, annotation);
      return;
    }
    // An empty estree body means the expression contains only comments
    // and whitespace. When estree is missing (a hand-built fixture), the
    // check refuses too — no estree means "not statically verified".
    if (isCommentOnlyExpression(estree)) return;
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

  // Phase 5: markdown `link` / `image` / `definition` URL scheme check.
  // `[x](javascript:alert(1))` renders a live javascript: href in the
  // built HTML; `[r]: javascript:...` becomes an autolink definition
  // that any `[r]` reference then uses (bypass #3 in the round-2
  // review). Apply the same isRefusedUrl the JSX attribute path uses
  // so a scheme trick that survives that path is also refused here.
  walkMdast(root as unknown as Nodes, (node) => {
    const kind = node.type;
    if (kind !== "link" && kind !== "image" && kind !== "definition") return;
    const url = (node as unknown as { url?: unknown }).url;
    if (typeof url !== "string") return;
    if (!isRefusedUrl(url)) return;
    const shape = kind === "link" ? "[…](url)" : kind === "image" ? "![…](url)" : "[ref]: url";
    diagnostics.push({
      file,
      line: lineOf(node),
      rule: "component-registry",
      message: `markdown ${kind} (${shape}) uses a refused URL scheme (one of: ${[...REFUSED_URL_SCHEMES].join(", ")}); refused after HTML-entity decoding and whitespace/control-char strip (ADR-0002, C1).`,
    });
  });

  return { diagnostics, usedAllowAnnotations };
}
