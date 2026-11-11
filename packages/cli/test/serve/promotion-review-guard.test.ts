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

describe("#155 remote lifecycle destination guard", () => {
  const pending = { id: "PRR_A", databaseId: 1, state: "PENDING", commitSha: review.headSha, submittedAt: null } as const;
  test("pending authorization is read remotely and must name the current review", async () => {
    const reads: string[] = [];
    const adapter = { async getReviewById(id: string) { reads.push(id); return pending; } };
    expect(await guardModule.guardPendingPromotionDestination("PRR_A", promotion, adapter)).toEqual({ ok: true });
    expect(await guardModule.guardPendingPromotionDestination("PRR_B", promotion, adapter)).toMatchObject({ ok: false, error: "promotion-review-mismatch" });
    expect(reads).toEqual(["PRR_A", "PRR_A"]);
  });
  test("remote terminal and missing reviews override stale local pending state", async () => {
    for (const remote of [null, { ...pending, state: "COMMENTED", submittedAt: promotion.ts }] as const) {
      expect(await guardModule.guardPendingPromotionDestination("PRR_A", promotion, { async getReviewById() { return remote; } }))
        .toMatchObject({ ok: false, error: "promotion-review-not-pending" });
    }
  });
  test("unbound promotions fail closed without a remote lookup", async () => {
    const adapter = { async getReviewById() { throw new Error("unbound must never query GitHub"); } };
    expect(await guardModule.guardPendingPromotionDestination("PRR_A", undefined, adapter)).toMatchObject({ ok: false, error: "promotion-review-unbound" });
    expect(await guardModule.guardPendingPromotionDestination("PRR_A", {}, adapter)).toMatchObject({ ok: false, error: "promotion-review-unbound" });
  });
});
