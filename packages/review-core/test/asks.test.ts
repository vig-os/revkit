// Tests for the ask (question spec) schema (DESIGN-0001 §5.1, ADR-0003,
// ADR-0007). Moved from `site/src/content/schemas/asks.test.ts` when the
// schema itself moved into `@revkit/review-core` (ADR-0025). The
// guarantees exercised here are: (a) each kind's happy path validates,
// (b) an unknown kind fails and names the allowed set, (c) schemaVersion
// is enforced, (d) kind-specific invariants hold (choice needs >= 2
// options with unique ids, scale needs min < max), and (e) strict shape
// — a stray body field (including the removed `id`) fails, since the
// daemon assigns ids from filenames (ADR-0007 acceptance).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION, askKinds, askSchema } from "../src/index.ts";

const baseOf = (kind: string): Record<string, unknown> => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  kind,
  title: `Example ${kind}`,
});

/** The committed fixture stays in the site tree because Playwright and
 * other site-side tooling reads it too; this test resolves it from the
 * repo root so a move of either half is a loud break, not a silent one. */
const FIXTURE_PATH = fileURLToPath(
  new URL("../../../site/tests/fixtures/asks/example-choice.json", import.meta.url),
);

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

  test("scale accepts numeric bounds where min < max and defaults step to 1", () => {
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

  test("the committed fixture (site/tests/fixtures/asks/example-choice.json) validates", async () => {
    const parsed = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as unknown;
    const result = askSchema.safeParse(parsed);
    expect(result.success).toBe(true);
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

  test("an `id` in the body is rejected (id = filename per ADR-0007)", () => {
    const result = askSchema.safeParse({
      ...baseOf("text"),
      id: "would-be-body-id",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toContain("id");
  });

  test("a stray extra field is rejected — the schema is strict", () => {
    const result = askSchema.safeParse({
      ...baseOf("text"),
      bogus: 1,
    });
    expect(result.success).toBe(false);
  });

  test("choice with fewer than 2 options is rejected", () => {
    const result = askSchema.safeParse({
      ...baseOf("choice"),
      options: [{ id: "only", label: "The only option" }],
    });
    expect(result.success).toBe(false);
  });

  test("choice with duplicate option ids is rejected, naming the offender", () => {
    const result = askSchema.safeParse({
      ...baseOf("choice"),
      options: [
        { id: "a", label: "A" },
        { id: "a", label: "A again" },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toContain("duplicate option id 'a'");
  });

  test("scale with min >= max is rejected", () => {
    const equal = askSchema.safeParse({ ...baseOf("scale"), min: 5, max: 5 });
    expect(equal.success).toBe(false);
    const flipped = askSchema.safeParse({ ...baseOf("scale"), min: 10, max: 0 });
    expect(flipped.success).toBe(false);
  });

  test("region and review require a target", () => {
    expect(askSchema.safeParse({ ...baseOf("region") }).success).toBe(false);
    expect(askSchema.safeParse({ ...baseOf("review") }).success).toBe(false);
  });
});
