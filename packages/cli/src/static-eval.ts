// Static evaluator over the ESTree subset MDX attribute expressions may
// use. Called by the component-registry rule to answer two questions:
//
//   1) "Is this expression allowed at all?" — the allowlist is
//      Literal (string / number / boolean / null; not RegExp), plus
//      ArrayExpression and ObjectExpression whose elements/properties
//      are themselves in this same allowlist. Nothing else — no
//      identifier lookups, no template literals with substitutions, no
//      unary/binary/logical operators, no call/member/new expressions,
//      no spreads. A URL that hides behind `"java" + "script:"` is
//      rejected as "not statically evaluable", never mis-classified.
//
//   2) "What value would it produce?" — for the same subset, produce
//      the concrete JS value so the URL-scheme check can inspect the
//      string.
//
// Runs off the estree from mdast-util-mdx-jsx (`data.estree`); never
// invokes `eval` or `new Function` — the check would defeat itself.

/** Minimal projection of an ESTree node — anything with a `type`. */
interface EstreeNode {
  readonly type: string;
}

/** ArrayExpression / ObjectExpression accept `null` elements
 * (sparse arrays). Nested nodes go back through `isStaticExpression`. */
interface Literal extends EstreeNode {
  readonly type: "Literal";
  readonly value: unknown;
  readonly regex?: unknown;
}

interface ArrayExpression extends EstreeNode {
  readonly type: "ArrayExpression";
  readonly elements: readonly (EstreeNode | null)[];
}

interface Property extends EstreeNode {
  readonly type: "Property";
  readonly key: EstreeNode & { name?: string; value?: unknown; type: string };
  readonly value: EstreeNode;
  readonly computed: boolean;
  readonly kind: string;
  readonly shorthand: boolean;
}

interface ObjectExpression extends EstreeNode {
  readonly type: "ObjectExpression";
  readonly properties: readonly EstreeNode[];
}

/** Is `expr` in the allowed subset? */
export function isStaticExpression(expr: unknown): boolean {
  if (expr === null || typeof expr !== "object") return false;
  const node = expr as EstreeNode;
  switch (node.type) {
    case "Literal": {
      // Reject RegExp literals; `Literal.value` is the RegExp object.
      if ((node as Literal).regex !== undefined) return false;
      const value = (node as Literal).value;
      return (
        value === null
        || typeof value === "string"
        || typeof value === "number"
        || typeof value === "boolean"
      );
    }
    case "ArrayExpression": {
      const elements = (node as ArrayExpression).elements;
      // A sparse hole (null) is fine — it evaluates to undefined at that
      // slot, but the SHAPE is allowed.
      return elements.every((element) => element === null || isStaticExpression(element));
    }
    case "ObjectExpression": {
      const properties = (node as ObjectExpression).properties;
      for (const raw of properties) {
        if (raw.type !== "Property") return false;
        const property = raw as Property;
        if (property.kind !== "init") return false;
        if (property.computed) return false;
        // Key must be Identifier (`foo`) or Literal string / number.
        if (property.key.type !== "Identifier" && property.key.type !== "Literal") return false;
        if (!isStaticExpression(property.value)) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

/** Evaluate a statically-checked expression. Callers must gate with
 * `isStaticExpression` first — this function does not re-check.
 * Returns the concrete JS value. */
export function evalStaticExpression(expr: unknown): unknown {
  const node = expr as EstreeNode;
  switch (node.type) {
    case "Literal":
      return (node as Literal).value;
    case "ArrayExpression": {
      const elements = (node as ArrayExpression).elements;
      return elements.map((element) => element === null ? undefined : evalStaticExpression(element));
    }
    case "ObjectExpression": {
      const properties = (node as ObjectExpression).properties;
      const out: Record<string, unknown> = {};
      for (const raw of properties) {
        const property = raw as Property;
        const key = property.key.type === "Identifier"
          ? (property.key.name as string)
          : String((property.key as { value?: unknown }).value);
        out[key] = evalStaticExpression(property.value);
      }
      return out;
    }
    default:
      // Unreachable if the caller gated with `isStaticExpression`.
      return undefined;
  }
}

/** Program-shaped wrapper mdast puts around a JSX attribute expression:
 * `Program { body: [ExpressionStatement { expression: <expr> }] }`.
 * Returns the inner expression or `null` if the shape is unexpected. */
export function unwrapProgramExpression(estree: unknown): unknown {
  if (estree === null || typeof estree !== "object") return null;
  const program = estree as { type?: string; body?: readonly unknown[] };
  if (program.type !== "Program") return null;
  if (!Array.isArray(program.body) || program.body.length !== 1) return null;
  const statement = program.body[0] as { type?: string; expression?: unknown };
  if (statement.type !== "ExpressionStatement") return null;
  return statement.expression ?? null;
}
