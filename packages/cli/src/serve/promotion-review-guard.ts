import type { OpenPendingReview, ReviewEvent } from "@revkit/review-core";

type Promotion = Extract<ReviewEvent, { kind: "draft.promoted" }>;

type PromotionReviewGuard =
  | { readonly ok: true; readonly review: OpenPendingReview }
  | {
      readonly ok: false;
      readonly error: "no-open-pending-review" | "promotion-review-unbound" | "promotion-review-mismatch";
      readonly detail: string;
    };

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
    if (promotion.reviewNodeId === undefined) {
      return {
        ok: false,
        error: "promotion-review-unbound",
        detail: "the recorded promotion has no review identity, so its target review cannot be verified.",
      };
    }
    if (promotion.reviewNodeId !== openPending.reviewNodeId) {
      return {
        ok: false,
        error: "promotion-review-mismatch",
        detail: `the promotion belongs to review '${promotion.reviewNodeId}', but the open review is '${openPending.reviewNodeId}'.`,
      };
    }
  }
  return { ok: true, review: openPending };
}
