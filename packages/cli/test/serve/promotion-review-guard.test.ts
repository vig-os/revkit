import { describe, expect, test } from "bun:test";
import type { OpenPendingReview } from "@revkit/review-core";
import * as guardModule from "../../src/serve/promotion-review-guard.ts";
import { guardPromotionReview } from "../../src/serve/promotion-review-guard.ts";

const review: OpenPendingReview = { reviewNodeId: "PRR_A", headSha: "a".repeat(40), comments: [] };
const promotion = { seq: 1, ts: "2026-10-08T00:00:00Z", actor: { kind: "local", id: "reviewer" },
  kind: "draft.promoted", threadId: "th-1", target: "resolve", reviewNodeId: "PRR_A" } as const;

describe("promotion-review guard", () => {
  test("a new click requires an open review", () => {
    expect(guardPromotionReview(review)).toEqual({ ok: true, review });
    expect(guardPromotionReview(null)).toMatchObject({ ok: false, error: "no-open-pending-review" });
  });
  test("a retry requires the same review", () => {
    expect(guardPromotionReview(review, promotion)).toEqual({ ok: true, review });
    expect(guardPromotionReview({ ...review, reviewNodeId: "PRR_B" }, promotion)).toMatchObject({ ok: false, error: "promotion-review-mismatch" });
  });
  test("legacy binding is refused; a closed review keeps the existing refusal", () => {
    const { reviewNodeId, ...legacy } = promotion;
    expect(guardPromotionReview(review, legacy)).toMatchObject({ ok: false, error: "promotion-review-unbound" });
    expect(guardPromotionReview(null, promotion)).toMatchObject({ ok: false, error: "no-open-pending-review" });
  });
  test("the destination rejects missing, mismatched, and terminal bindings", () => {
    expect(guardModule.guardPromotionDestination).toBeFunction();
    const guard = guardModule.guardPromotionDestination;
    expect(guard("PRR_A", promotion)).toEqual({ ok: true });
    expect(guard("PRR_A", undefined)).toMatchObject({ ok: false, error: "promotion-review-unbound" });
    expect(guard("PRR_A", {})).toMatchObject({ ok: false, error: "promotion-review-unbound" });
    expect(guard("PRR_B", promotion)).toMatchObject({ ok: false, error: "promotion-review-mismatch" });
    expect(guard(null, promotion)).toMatchObject({ ok: false, error: "promotion-review-mismatch" });
    expect(guard("PRR_A", promotion, new Set(["PRR_A"]))).toMatchObject({ ok: false, error: "promotion-review-not-pending" });
    expect(guard("PRR_B", promotion, new Set(["PRR_A"]))).toMatchObject({ ok: false, error: "promotion-review-not-pending" });
  });
});
