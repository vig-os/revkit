// Unit tests for the Callout attribute helpers (see calloutAttrs.ts for the
// split rationale). The full JSX rendering path is exercised end-to-end by
// the Playwright smoke against the built Astro site (ADR-0016).
import { describe, expect, test } from "bun:test";
import {
  calloutKindClass,
  calloutKinds,
  defaultCalloutKind,
} from "../src/calloutAttrs.ts";

describe("calloutKinds", () => {
  test("covers exactly the four documented tones", () => {
    expect([...calloutKinds]).toEqual(["info", "success", "warning", "danger"]);
  });

  test("has the default tone in the set", () => {
    expect(calloutKinds).toContain(defaultCalloutKind);
  });
});

describe("calloutKindClass", () => {
  test.each(calloutKinds.map((kind) => [kind]))(
    "returns the BEM modifier for %s",
    (kind) => {
      expect(calloutKindClass(kind)).toBe(`revkit-callout--${kind}`);
    },
  );

  test("is a total function over the exported kinds (no undefined entries)", () => {
    for (const kind of calloutKinds) {
      const result = calloutKindClass(kind);
      expect(result.startsWith("revkit-callout--")).toBe(true);
      expect(result.length).toBeGreaterThan("revkit-callout--".length);
    }
  });
});
