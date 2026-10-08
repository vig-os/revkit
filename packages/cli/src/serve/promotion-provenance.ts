import type { ReviewEvent, ThreadStore } from "@revkit/review-core";

type Promotion = Extract<ReviewEvent, { kind: "draft.promoted" }>;

/** Provenance of the latest machine intent for each AGENT-authored
 * comment. Bind to the promotion preceding that intent, not a later
 * promotion: a fresh reviewer approval must append a fresh intent too.
 * Existing and healed intents use the same derivation, so old events
 * need no migration. Missing/legacy authorization stays explicitly
 * unbound. Reviewer-authored intents are absent from this map. */
export function promotedCommentIntents(events: readonly ReviewEvent[]): ReadonlyMap<string, Promotion | undefined> {
  const authors = new Map<string, ReviewEvent["actor"]["kind"]>();
  const promotions = new Map<string, Promotion>();
  const intents = new Map<string, Promotion | undefined>();
  for (const event of events) {
    if (event.kind === "comment.created" || event.kind === "comment.replied") {
      authors.set(event.commentId, event.actor.kind);
    } else if (event.kind === "draft.promoted" && event.target === "comment" && event.commentId !== undefined) {
      promotions.set(event.commentId, event);
    } else if (event.kind === "comment.sync_requested" && authors.get(event.commentId) === "agent") {
      intents.set(event.commentId, promotions.get(event.commentId));
    }
  }
  return intents;
}

/** ThreadStore exposes ordered since() but no single-event lookup. Read
 * its first result and check the identity rather than scanning the tail.
 * A missing record is a log inconsistency, not a legacy unbound event. */
export async function promotionAtSeq(store: ThreadStore, seq: number): Promise<Promotion | undefined> {
  const event = (await store.since(seq - 1))[0];
  return event?.seq === seq && event.kind === "draft.promoted" ? event : undefined;
}
