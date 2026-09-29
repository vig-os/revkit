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
