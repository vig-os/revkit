# ADR-0015: Data retention and privacy

- Status: Accepted
- Date: 2026-09-29
- Stories: B5, D2
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)

## Context

Hosted mode stores review threads and guest identities for an org.

## Decision

- **Previews** are deleted 30 days after the PR closes (R2 lifecycle rule on `<repo>/pr-<n>/`).
- **Threads are kept** in D1 as the review record (they are mirrored on GitHub anyway), including guest attribution.
- **Guests:** display name required; email optional, used only for notifications, never shown in PR comments, and
  deleted 30 days after the invite is revoked or expires.
- **Logs** carry no comment bodies, emails or tokens (ADR-0020).
- A guest or member can ask for deletion of their data; `revkit data delete --identity <id>` removes it and replaces
  their comments' author with "deleted user". Guest comments mirrored to GitHub were posted by the App, so revkit
  deletes those mirrors too; a member's own GitHub review comments belong to GitHub and must be deleted there.

## Consequences

## Amendment (2026-10-04, issue #9) — `sessions` rows are personal data with no sweep

M4 slice 2 made the `sessions` table real: a row per issued session, carrying an
`identity_kind`, an opaque `identity_id`, `created_at` and `expires_at`.

- **Nothing deletes a session row.** Expiry is a *decision* the gate makes on every
  read, not a deletion, and there is no retention job, no sweep and no
  `revkit data delete` for sessions. `test/authorization.test.ts` asserts that an
  expired session is refused *while its row is still present*, so the distinction
  cannot be quietly collapsed. ADR-0015's clock above starts at the guests table;
  sessions need the same treatment and do not have it yet.
- **`identity_id` is opaque, and stays that way.** It is never a login, an email or
  a guest display name, which is what makes a session row a pseudonymous record
  rather than a personal one (ADR-0020). The gate logs `identity_kind` and never
  `identity_id` or the session id, and `test/logger.test.ts` drives genuinely
  minted values through the redactor to prove it.
- **The guest linkage arrives in slice 3**, when `identity_id` becomes a guest id
  and ADR-0015's "deleted 30 days after the invite is revoked or expires" applies
  to it. Until then a session row's `identity_kind` is `operator` — a deployment's
  own first session — and is not a guest record.

## Amendment (2026-10-04, issue #9, slice 3) — the guest clock, and what it
## anonymises rather than deletes

`sessions.identity_id` is a guest id from slice 3, so a session row is now a
pseudonymous record of a named person and ADR-0015's clock has a subject. The
deletion itself ships: `purgeStaleGuests`
(`packages/worker/src/retention.ts`) anonymises every guest whose invite was
revoked or expired more than 30 days ago.

**It ANONYMISES; it does not DELETE the row.** `display_name` becomes the fixed
string `deleted user`, `email` becomes NULL, `deleted_at` is stamped. Deleting
the row would break two things this ADR itself requires:

- **"Threads are kept … including guest attribution."** The authorization gate
  turns a session into its invite through
  `sessions.identity_id → invite_redemptions.guest_id`, so a deleted guest row
  turns every live session that guest holds into "no grant" — the purge would
  REVOKE sessions, which is the opposite of keeping the record.
- **"Replaces author with 'deleted user'"** is a statement about what a reader
  sees, and a reader looks the author up by id. There has to be something to
  resolve to.

**Which event starts the 30 days, when both apply.** An invite can be expired AND
revoked, and this ADR says "revoked or expires" without ranking them. The
**later** of the two is used (`MAX(COALESCE(revoked_at, ''), expires_at)`),
because the later event is the one an operator would name when asked when this
guest became deletable, and using the earlier one would delete a guest whose
revocation had not happened yet. `COALESCE` is load-bearing rather than
decorative: SQLite's two-argument scalar `MAX` returns NULL if either argument
is NULL, which every un-revoked invite is, so without it the predicate is
`NULL <= cutoff` and the sweep silently never fires. The boundary is inclusive —
a guest exactly at the deadline IS purged — and `deleted_at IS NULL` makes the
sweep idempotent, so a second run reports 0 and cannot restamp a `deleted_at`
that a later answer to "a guest can ask for deletion of their data" may want to
keep distinct from the automatic sweep.

**The schedule is NOT wired, and that is the honest gap.** A Cloudflare Cron
Trigger is declared in `wrangler.jsonc` and cannot be exercised by this repo's
offline harness (miniflare dispatches `fetch`; a `scheduled` event is a separate
entry, so a trigger line would be a claim no test could check). Adding it
un-tested would be exactly the "the ADR says it happens" claim the 2026-10-04
slice-2 amendment above exists to prevent. So the trigger lands with the rest of
the provisioning that needs an account (`revkit deploy init`, #34), and
`revkit deploy status` (slice 7) is where an operator learns that no sweep is
running. **Until then guests are retained indefinitely**, which is the wrong
direction for a privacy clock and is stated rather than left to be assumed.

**Guest attribution inside `events.payload` is untouched, because nothing has
written one.** `POST /api/threads` is a 501, so no guest-authored event exists
in any database this code has touched; the payload's shape for a guest author is
the hosted write's to define (slice 4). A test asserts the clock against the
`guests` table and says nothing about payloads, because there is nothing to say
yet.

**`sessions` rows are STILL never deleted** — the slice-2 amendment's gap is
unchanged by this slice, and it is now sharper: a session row names a guest, so
deleting it is a personal-data decision this ADR has not yet made. Expiry
remains a *decision* the gate makes per request, not a deletion, and
`test/invites.test.ts` asserts a revoked invite's session is refused *while its
row is still present*.
