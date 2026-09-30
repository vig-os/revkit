// Import-declaration analyzer. Walks the ESTree Program that
// remark-mdx sets on every `mdxjsEsm` node and answers, per node:
//
//   • Are ALL top-level nodes `ImportDeclaration`s? (Any `export`,
//     any variable declaration, any expression at the top level of an
//     ESM block is a violation — the content author is trying to
//     smuggle code into a docs page.)
//
//   • For each ImportDeclaration, what specifier does it import from,
//     and what local names does it bind (default / namespace / named
//     specifiers)?
//
//   • Does the declaration bind at least one name? (`import "sideFx"`
//     is refused: no name to reference, only a side effect.)
//
// The result is consumed by the component-registry rule to (1) refuse
// an import from a specifier outside the allowlist, (2) refuse an ESM
// block that carries anything other than plain imports, and (3) build
// the set of bound JSX component names — an uppercase JSX name that is
// not in this set is a component used without being imported.

/** One import binding discovered in an mdxjsEsm block. */
export interface ImportBinding {
  readonly localName: string;
  /** For a named import, the ORIGINAL export name (e.g. `LinkCard`
   * in `import { LinkCard as X } from …`). Same as `localName` when
   * the two coincide. `null` for default / namespace imports. */
  readonly importedName: string | null;
  readonly specifier: string;
  readonly line: number;
}

/** Result of analysing one mdxjsEsm ESM block. `bindings` is empty
 * when the block is refused for structural reasons — callers should
 * check `violations` first. */
export interface EsmAnalysis {
  readonly bindings: readonly ImportBinding[];
  readonly violations: readonly EsmViolation[];
}

/** A single problem the analyser found in one ESM block. */
export interface EsmViolation {
  /** 1-based line inside the source file. */
  readonly line: number;
  /** Machine-readable kind (used by tests to assert which policy fired). */
  readonly kind:
    | "unexpected-top-level"
    | "side-effect-import"
    | "export-declaration"
    | "dynamic-import"
    | "unparsable-estree";
  /** Human-readable message the rule surfaces to the reader. */
  readonly message: string;
}

/** Minimal ESTree projection — enough for import declarations. */
interface ProgramNode {
  readonly type: "Program";
  readonly body: readonly BodyNode[];
}

interface BodyNode {
  readonly type: string;
  readonly loc?: { readonly start?: { readonly line?: number } };
}

interface ImportDeclarationNode extends BodyNode {
  readonly type: "ImportDeclaration";
  readonly source: { readonly value?: unknown };
  readonly specifiers: readonly ImportSpecifierNode[];
}

interface ImportSpecifierNode {
  readonly type: string;
  readonly local: { readonly name: string };
  readonly imported?: { readonly name?: string };
}

/** Analyse the estree of one mdxjsEsm node. `esmLine` is used as the
 * fallback line number if the estree lacks position info. */
export function analyseEsm(estree: unknown, esmLine: number): EsmAnalysis {
  if (estree === null || typeof estree !== "object") {
    return {
      bindings: [],
      violations: [{
        line: esmLine,
        kind: "unparsable-estree",
        message: "content ESM block did not parse to an estree Program — refused.",
      }],
    };
  }
  const program = estree as ProgramNode;
  if (program.type !== "Program" || !Array.isArray(program.body)) {
    return {
      bindings: [],
      violations: [{
        line: esmLine,
        kind: "unparsable-estree",
        message: "content ESM block did not parse to an estree Program — refused.",
      }],
    };
  }
  const bindings: ImportBinding[] = [];
  const violations: EsmViolation[] = [];
  for (const node of program.body) {
    const line = node.loc?.start?.line ?? esmLine;
    if (node.type === "ExportNamedDeclaration"
      || node.type === "ExportDefaultDeclaration"
      || node.type === "ExportAllDeclaration") {
      violations.push({
        line,
        kind: "export-declaration",
        message: "content ESM block contains an `export` — content is data, not a module (ADR-0002, C1).",
      });
      continue;
    }
    if (node.type !== "ImportDeclaration") {
      violations.push({
        line,
        kind: "unexpected-top-level",
        message: `content ESM block contains a top-level ${node.type} — only plain \`import\` statements are allowed (ADR-0002, C1).`,
      });
      continue;
    }
    const decl = node as ImportDeclarationNode;
    const specifier = typeof decl.source?.value === "string" ? decl.source.value : "";
    if (decl.specifiers.length === 0) {
      violations.push({
        line,
        kind: "side-effect-import",
        message: `content ESM block runs a side-effect-only import from ${JSON.stringify(specifier)} — refused (ADR-0002, C1).`,
      });
      continue;
    }
    for (const spec of decl.specifiers) {
      // Namespace imports (`import * as X from …`) refuse content-
      // wide (round-5 review): a namespace binding exposes every
      // export from the module, so the Card/LinkCard named-export
      // denylist would not apply to `X.Card`. Named + default only.
      if (spec.type === "ImportNamespaceSpecifier") {
        violations.push({
          line,
          kind: "unexpected-top-level",
          message: `content ESM block uses a namespace import (\`import * as ${spec.local.name}\`) from ${JSON.stringify(specifier)} — refused (named imports only; denylisted named exports must remain unreachable).`,
        });
        continue;
      }
      if (
        spec.type !== "ImportDefaultSpecifier"
        && spec.type !== "ImportSpecifier"
      ) {
        violations.push({
          line,
          kind: "unexpected-top-level",
          message: `content ESM block uses an unsupported import specifier ${spec.type}.`,
        });
        continue;
      }
      // `imported.name` is present on ImportSpecifier only; ES modules
      // treat default bindings as having no original name.
      const importedName = spec.type === "ImportSpecifier"
        ? spec.imported?.name ?? null
        : null;
      bindings.push({ localName: spec.local.name, importedName, specifier, line });
    }
  }
  return { bindings, violations };
}

/** Scan the raw expression value for a top-level dynamic `import(...)`
 * or `await import(...)`. Called from the expression handler because
 * these live inside MdxFlowExpression / MdxTextExpression bodies, not
 * ESM blocks. Regex is safe here — the estree path treats the whole
 * expression as a violation already (non-comment-only); this pins the
 * message so a reviewer sees WHY. */
export function looksLikeDynamicImport(value: string): boolean {
  return /(?:^|[^.\w])import\s*\(/.test(value);
}
