// ADR-0015's guest retention clock: "Guests … deleted 30 days after the
// invite is revoked or expires."
//
// ADR-0015's 2026-10-04 amendment (slice 2) recorded that `sessions` rows are
// personal data with nothing deleting them. Slice 3 makes the GUESTS half real:
// `sessions.identity_id` is a guest id from here on, so a session row is a
// pseudonymous record of a named person (ADR-0020), and the clock ADR-0015
// started specifying now has a subject.
//
// ── Why this ANONYMISES and does not DELETE ───────────────────────────────
//
// ADR-0015 says two things that pull against each other, and both are
// load-bearing:
//
//   - "**Threads are kept** in D1 as the review record (they are mirrored on
//     GitHub anyway), **including guest attribution**."
//   - "deleted 30 days after the invite is revoked or expires" and "`revkit
//     data delete --identity <id>` replaces author with 'deleted user'".
//
// So the guest ROW is retained as a tombstone and the personal data in it is
// destroyed: `display_name` becomes the fixed string `deleted user`, `email`
// becomes NULL, `deleted_at` is stamped. Deleting the row instead would break
// two things this slice depends on:
//
//   1. **`sessions.identity_id` would dangle.** The authorization gate turns a
//      session into its invite through
//      `sessions.identity_id -> invite_redemptions.guest_id`, and a session
//      with no guest row resolves to no invite, which the gate refuses. A
//      purge that deleted guests would therefore REVOKE every live session
//      that guest held — the opposite of "threads are kept".
//   2. **ADR-0015's own redaction rule needs the row.** "Replaces author with
//      'deleted user'" is a statement about what a reader sees, and the reader
//      looks up the author by id. There has to be something to resolve to.
//
// What is NOT in scope here, and named so the next slice does not assume it:
// rewriting guest attribution INSIDE `events.payload`. `POST /api/threads` is
// still 501, so no guest-authored event exists in any database this code has
// touched, and the payload's shape for a guest author is the hosted write's to
// define (slice 4). A test asserts the clock is applied to the `guests` table
// and says nothing about payloads, because there is nothing to say yet.
//
// ── Why the trigger is not wired, and what is missing ─────────────────────
//
// `purgeStaleGuests` is the whole deletion; what is NOT here is anything that
// CALLS it on a schedule. A Cloudflare Cron Trigger is declared in
// `wrangler.jsonc` and cannot be exercised by this repo's offline harness
// (miniflare dispatches `fetch`; a `scheduled` event is a separate entry and
// the trigger line would be a claim no test could check). Adding the cron
// without a test would be exactly the kind of "the ADR says it happens" claim
// ADR-0012's amendment exists to prevent, so the trigger lands with the rest
// of the provisioning that needs an account (`revkit deploy init`, #34), and
// this slice ships the deletion with the retention window proven and the
// schedule honestly absent. `revkit deploy status` (slice 7) is where an
// operator learns that no sweep is running.

/** How long after an invite is revoked or expires a guest is anonymised.
 * ADR-0015's "deleted 30 days after the invite is revoked or expires". */
export const GUEST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** What a purged guest's `display_name` becomes. ADR-0015's literal,
 * `"deleted user"`, and it is a CONSTANT rather than a formatted string so a
 * test can assert on it and so no part of the old name survives in it. */
export const GUEST_DELETED_NAME = "deleted user";

export interface PurgeResult {
  /** Guest rows this call anonymised. */
  readonly purged: number;
  /** The instant the sweep treats as "now", ISO-8601. Returned so an operator
   * tool can report the window it used rather than asking the caller to
   * recompute it. */
  readonly asOf: string;
  /** ISO-8601: the newest revoked/expired instant that is still INSIDE the
   * 30-day window, i.e. the boundary this call refused to cross. */
  readonly cutoff: string;
}

/**
 * Anonymise every guest whose invite was revoked or expired more than
 * `GUEST_RETENTION_MS` ago.
 *
 * ── Which clock, when both apply ──────────────────────────────────────────
 *
 * An invite can be both expired AND revoked, and ADR-0015 says "revoked or
 * expires" without saying which wins. The LATER of the two is used, because
 * the later event is the one an operator would name when asked when this guest
 * became deletable, and using the earlier one would delete a guest whose
 * revocation had not happened yet. `MAX(COALESCE(revoked_at, ''), expires_at)`
 * does that with ISO-8601 strings, which sort chronologically — and
 * `COALESCE` is load-bearing, because SQLite's two-argument scalar `MAX`
 * returns NULL if either argument is NULL, which every un-revoked invite would
 * be. Measured rather than assumed: see `test/invites.test.ts`.
 *
 * The trigger is `<= cutoff`, so a guest exactly at the boundary IS purged:
 * "30 days after" is an inclusive deadline, and the alternative leaves a
 * guest alive forever if the sweep runs at a moment that never equals it.
 *
 * ── The `expires_at IS NOT NULL` disjunction that WAS here ────────────────
 *
 * This predicate used to carry `(i.revoked_at IS NOT NULL OR i.expires_at IS NOT
 * NULL)`. It is gone because it is a tautology: `expires_at` is `TEXT NOT NULL`
 * in `migrations/0001_init.sql`, so the right-hand side is always true and the
 * disjunction always reduces to `true`. The mutation run agreed — deleting it
 * changed **zero** of 92 tests — and the deletion is not tidiness, it is
 * removing a clause that only LOOKED like it was saying "the invite has ended".
 * A reader checking whether expiry alone starts the clock had to reason about a
 * term that could never be false. What actually starts the clock is the
 * `MAX(COALESCE(...)) <= ?` comparison below, and `expires_at` participates in
 * it directly.
 *
 * ── Why `deleted_at IS NULL` is in the WHERE ──────────────────────────────
 *
 * It makes the sweep idempotent AND self-limiting: a guest already anonymised
 * is not re-selected, so a second run reports 0 and cannot restamp a
 * `deleted_at` that a later ADR-0015 answer ("a guest can ask for deletion of
 * their data") may want to keep distinct from the automatic sweep. The
 * `display_name` is rewritten unconditionally within a matched row, so even a
 * row whose name somehow differed is normalised to the one tombstone string.
 *
 * One statement, not a read-then-write loop: D1 has no interactive
 * transaction (`migrations/0001_init.sql`), so a loop would be N round trips
 * with a window where a concurrent redemption sees a half-swept table. A
 * single `UPDATE … WHERE EXISTS (correlated subquery)` is one atomic write.
 */
export async function purgeStaleGuests(
  db: D1Database,
  options: { readonly now?: number } = {},
): Promise<PurgeResult> {
  const now = options.now ?? Date.now();
  const cutoff = new Date(now - GUEST_RETENTION_MS).toISOString();
  const asOf = new Date(now).toISOString();
  const result = await db
    .prepare(
      "UPDATE guests SET display_name = ?, email = NULL, deleted_at = ? " +
        "WHERE deleted_at IS NULL AND EXISTS (" +
        "SELECT 1 FROM invite_redemptions r JOIN invites i ON i.id = r.invite_id " +
        "WHERE r.guest_id = guests.id " +
        "AND MAX(COALESCE(i.revoked_at, ''), i.expires_at) <= ?)",
    )
    .bind(GUEST_DELETED_NAME, asOf, cutoff)
    .run();
  return { purged: result.meta?.changes ?? 0, asOf, cutoff };
}
