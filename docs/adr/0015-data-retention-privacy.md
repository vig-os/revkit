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
