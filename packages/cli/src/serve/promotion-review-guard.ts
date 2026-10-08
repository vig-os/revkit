import type { OpenPendingReview, ReviewEvent } from "@revkit/review-core";

type Promotion = Extract<ReviewEvent, { kind: "draft.promoted" }>;

type Refusal = {
  readonly ok: false;
  readonly error: "no-open-pending-review" | "promotion-review-unbound" | "promotion-review-mismatch" | "promotion-review-not-pending";
  readonly detail: string;
};

type PromotionReviewGuard = { readonly ok: true; readonly review: OpenPendingReview } | Refusal;

/** The binding follows the intent to its actual destination. A missing
 * promotion is unbound; it must never be treated as a new reviewer click.
 * Terminal reviews are refused even when their node id matches. */
export function guardPromotionDestination(
  destinationReviewNodeId: string | null,
  promotion: Pick<Promotion, "reviewNodeId"> | undefined,
  terminalReviewNodeIds: ReadonlySet<string> = new Set(),
): { readonly ok: true } | Refusal {
  if (promotion?.reviewNodeId === undefined) {
    return {
      ok: false,
      error: "promotion-review-unbound",
      detail: "the recorded promotion has no review identity; promote the draft into your current review.",
    };
  }
  if (terminalReviewNodeIds.has(promotion.reviewNodeId)) {
    return {
      ok: false,
      error: "promotion-review-not-pending",
      detail: "the approved review is closed; promote the draft into your current review.",
    };
  }
  if (promotion.reviewNodeId !== destinationReviewNodeId) {
    return {
      ok: false,
      error: "promotion-review-mismatch",
      detail: `the promotion belongs to review '${promotion.reviewNodeId}', but the destination review is '${destinationReviewNodeId}'.`,
    };
  }
  return { ok: true };
}

/** One authorization rule for both the promote route and crash healing.
 * No promotion means a new click into the current review. An existing
 * promotion can only be resumed in the review that click recorded. */
export function guardPromotionReview(
  openPending: OpenPendingReview | null,
  promotion?: Promotion,
): PromotionReviewGuard {
  if (openPending === null) {
    return {
      ok: false,
      error: "no-open-pending-review",
      detail: "there is no open pending review to promote into — comment first, then promote.",
    };
  }
  if (promotion !== undefined) {
    const bound = guardPromotionDestination(openPending.reviewNodeId, promotion);
    if (!bound.ok) return bound;
  }
  return { ok: true, review: openPending };
}
