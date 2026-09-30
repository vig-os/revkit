// Static evaluator tests — the allowlist for JSX attribute expression
// values. `isStaticExpression` and `evalStaticExpression` are the only
// door a URL-scheme check has to look through, so they must reject
// EVERYTHING the reviewer could smuggle behind a compile-time
// evaluation (identifiers, calls, template literals with holes,
// binary/unary ops).
import { describe, expect, test } from "bun:test";
import {
  evalStaticExpression,
  isStaticExpression,
  unwrapProgramExpression,
} from "../src/static-eval.ts";

// Handy ESTree factories — small so the intent of each test is obvious.
const lit = (value: unknown) => ({ type: "Literal", value });
const arr = (elements: readonly unknown[]) => ({ type: "ArrayExpression", elements });
const obj = (props: readonly { key: string; value: unknown }[]) => ({
  type: "ObjectExpression",
  properties: props.map((p) => ({
    type: "Property",
    key: { type: "Identifier", name: p.key },
    value: p.value,
    computed: false,
    kind: "init",
    shorthand: false,
  })),
});

describe("isStaticExpression", () => {
  test("accepts primitive Literals", () => {
    expect(isStaticExpression(lit("hi"))).toBe(true);
    expect(isStaticExpression(lit(42))).toBe(true);
    expect(isStaticExpression(lit(true))).toBe(true);
    expect(isStaticExpression(lit(null))).toBe(true);
  });

  test("refuses RegExp literals", () => {
    expect(isStaticExpression({ type: "Literal", value: /x/, regex: { pattern: "x", flags: "" } })).toBe(false);
  });

  test("accepts nested arrays and objects of literals", () => {
    expect(isStaticExpression(arr([lit(1), lit("x"), lit(null)]))).toBe(true);
    expect(isStaticExpression(obj([{ key: "a", value: arr([lit(1), lit(2)]) }]))).toBe(true);
  });

  test("refuses identifier references", () => {
    expect(isStaticExpression({ type: "Identifier", name: "React" })).toBe(false);
  });

  test("refuses call expressions", () => {
    expect(isStaticExpression({
      type: "CallExpression",
      callee: { type: "Identifier", name: "alert" },
      arguments: [lit(1)],
    })).toBe(false);
  });

  test("refuses template literals with substitutions", () => {
    expect(isStaticExpression({
      type: "TemplateLiteral",
      quasis: [{ type: "TemplateElement" }, { type: "TemplateElement" }],
      expressions: [{ type: "Identifier", name: "x" }],
    })).toBe(false);
  });

  test("refuses binary + concat (`\"java\" + \"script:\"`)", () => {
    expect(isStaticExpression({
      type: "BinaryExpression",
      operator: "+",
      left: lit("java"),
      right: lit("script:"),
    })).toBe(false);
  });

  test("refuses spread inside array/object", () => {
    expect(isStaticExpression(arr([{ type: "SpreadElement", argument: { type: "Identifier", name: "x" } }]))).toBe(false);
    expect(isStaticExpression({
      type: "ObjectExpression",
      properties: [{ type: "SpreadElement", argument: { type: "Identifier", name: "x" } }],
    })).toBe(false);
  });

  test("refuses computed object keys", () => {
    expect(isStaticExpression({
      type: "ObjectExpression",
      properties: [{
        type: "Property",
        key: { type: "Identifier", name: "x" },
        value: lit(1),
        computed: true,
        kind: "init",
        shorthand: false,
      }],
    })).toBe(false);
  });
});

describe("evalStaticExpression", () => {
  test("evaluates a Literal to its JS value", () => {
    expect(evalStaticExpression(lit("hi"))).toBe("hi");
    expect(evalStaticExpression(lit(42))).toBe(42);
    expect(evalStaticExpression(lit(null))).toBe(null);
  });

  test("evaluates a nested object/array to an equal JS structure", () => {
    const expr = obj([
      { key: "url", value: lit("javascript:alert(1)") },
      { key: "n", value: arr([lit(1), lit(2)]) },
    ]);
    expect(evalStaticExpression(expr)).toEqual({ url: "javascript:alert(1)", n: [1, 2] });
  });
});

describe("unwrapProgramExpression", () => {
  test("returns the single ExpressionStatement's expression", () => {
    const program = {
      type: "Program",
      body: [{ type: "ExpressionStatement", expression: lit(3) }],
    };
    expect(unwrapProgramExpression(program)).toEqual(lit(3));
  });

  test("returns null when the shape does not match", () => {
    expect(unwrapProgramExpression(null)).toBeNull();
    expect(unwrapProgramExpression({ type: "Literal", value: 3 })).toBeNull();
    expect(unwrapProgramExpression({ type: "Program", body: [] })).toBeNull();
  });
});
