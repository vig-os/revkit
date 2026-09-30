// Validator transition rules for review-lifecycle events (M3 part 2b).
// - review.opened: refuses a duplicate reviewNodeId (`duplicate-review`).
// - review.submitted / abandoned: refuses on a missing / already-terminal
//   review (`review-not-pending` with `currentStatus`).

import { describe, expect, test } from "bun:test";
import { emptyLogState, validateNext, type LogState } from "../src/index.ts";
import type { ReviewEvent } from "../src/index.ts";

const t = "2026-09-30T12:00:00Z";
const actor = { kind: "local" as const, id: "u-1" };
const HEAD = "a".repeat(40);

function opened(seq: number, reviewNodeId: string, headSha: string): ReviewEvent {
  return { seq, ts: t, actor, kind: "review.opened", reviewNodeId, headSha };
}
function submitted(seq: number, reviewNodeId: string): ReviewEvent {
  return { seq, ts: t, actor, kind: "review.submitted", reviewNodeId, event: "COMMENT" };
}
function abandoned(seq: number, reviewNodeId: string): ReviewEvent {
  return { seq, ts: t, actor, kind: "review.abandoned", reviewNodeId };
}

function withValidated(events: ReviewEvent[]): LogState {
  const s = emptyLogState();
  for (const e of events) {
    const r = validateNext(s, e);
    if (!r.ok) throw new Error(`unexpected reject ${e.kind}: ${r.rejection.kind}`);
  }
  return s;
}

describe("validator — review-lifecycle transitions (M3 part 2b)", () => {
  test("review.opened accepted; duplicate opened refused with duplicate-review", () => {
    const s = withValidated([opened(1, "R_1", HEAD)]);
    const r = validateNext(s, opened(2, "R_1", HEAD));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.kind).toBe("duplicate-review");
    if (r.rejection.kind !== "duplicate-review") return;
    expect(r.rejection.reviewNodeId).toBe("R_1");
  });

  test("review.submitted after opened: accepted; second terminal refused with review-not-pending(submitted)", () => {
    const s = withValidated([opened(1, "R_1", HEAD), submitted(2, "R_1")]);
    const r = validateNext(s, abandoned(3, "R_1"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.kind).toBe("review-not-pending");
    if (r.rejection.kind !== "review-not-pending") return;
    expect(r.rejection.currentStatus).toBe("submitted");
    expect(r.rejection.attempted).toBe("abandoned");
  });

  test("review.abandoned after opened: accepted; second terminal refused with review-not-pending(abandoned)", () => {
    const s = withValidated([opened(1, "R_1", HEAD), abandoned(2, "R_1")]);
    const r = validateNext(s, submitted(3, "R_1"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.kind).toBe("review-not-pending");
    if (r.rejection.kind !== "review-not-pending") return;
    expect(r.rejection.currentStatus).toBe("abandoned");
    expect(r.rejection.attempted).toBe("submitted");
  });

  test("review.submitted on unknown reviewNodeId: review-not-pending(missing)", () => {
    const s = emptyLogState();
    const r = validateNext(s, submitted(1, "R_ghost"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.kind).toBe("review-not-pending");
    if (r.rejection.kind !== "review-not-pending") return;
    expect(r.rejection.currentStatus).toBe("missing");
  });

  test("after abandon, a NEW opened with a DIFFERENT reviewNodeId is accepted", () => {
    const s = withValidated([opened(1, "R_1", HEAD), abandoned(2, "R_1")]);
    const r = validateNext(s, opened(3, "R_2", "b".repeat(40)));
    expect(r.ok).toBe(true);
  });
});
