// Tests for the ask (question spec) schema (DESIGN-0001 §5.1, ADR-0003).
// The schema is a discriminated union on `kind`, so the guarantees to prove
// are: (a) each kind's happy path validates, (b) an unknown kind fails,
// (c) schemaVersion is enforced, and (d) kind-specific invariants hold
// (choice needs >= 2 options, scale needs numeric bounds, etc.).
import { describe, expect, test } from "bun:test";
import { askKinds, askSchema } from "./asks.ts";
import { CURRENT_SCHEMA_VERSION } from "./shared.ts";

const baseOf = (kind: string): Record<string, unknown> => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  id: `example-${kind}`,
  kind,
  title: `Example ${kind}`,
});

describe("askSchema — happy paths", () => {
  test("choice accepts >= 2 options and defaults multi/allowOther to false", () => {
    const result = askSchema.safeParse({
      ...baseOf("choice"),
      options: [
        { id: "a", label: "Option A" },
        { id: "b", label: "Option B" },
      ],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.kind !== "choice") throw new Error("discriminant lost");
    expect(result.data.allowOther).toBe(false);
    expect(result.data.multi).toBe(false);
  });

  test("scale accepts numeric bounds and defaults step to 1", () => {
    const result = askSchema.safeParse({
      ...baseOf("scale"),
      min: 0,
      max: 10,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.kind !== "scale") throw new Error("discriminant lost");
    expect(result.data.step).toBe(1);
  });

  test("text, region, review round-trip with their minimum fields", () => {
    expect(askSchema.safeParse({ ...baseOf("text") }).success).toBe(true);
    expect(askSchema.safeParse({ ...baseOf("region"), target: "plots/x/spec.vl.json" }).success).toBe(true);
    expect(askSchema.safeParse({ ...baseOf("review"), target: "docs/adr/0001-x.md" }).success).toBe(true);
  });
});

describe("askSchema — rejections", () => {
  test("unknown kind is rejected, and the message lists at least one valid kind", () => {
    const result = askSchema.safeParse({ ...baseOf("bogus") });
    expect(result.success).toBe(false);
    if (result.success) return;
    const message = JSON.stringify(result.error.issues);
    expect(askKinds.some((kind) => message.includes(kind))).toBe(true);
  });

  test("missing schemaVersion is rejected", () => {
    const spec = baseOf("text");
    delete spec.schemaVersion;
    const result = askSchema.safeParse(spec);
    expect(result.success).toBe(false);
  });

  test("choice with fewer than 2 options is rejected", () => {
    const result = askSchema.safeParse({
      ...baseOf("choice"),
      options: [{ id: "only", label: "The only option" }],
    });
    expect(result.success).toBe(false);
  });

  test("region and review require a target", () => {
    expect(askSchema.safeParse({ ...baseOf("region") }).success).toBe(false);
    expect(askSchema.safeParse({ ...baseOf("review") }).success).toBe(false);
  });
});
