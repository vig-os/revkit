# ADR-0009: Auth: GitHub App user-to-server, invite links, Authentik later

- Status: Accepted
- Date: 2026-09-29
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)
- Stories: B2, B3, B5
- Amended by: [ADR-0025](0025-hybrid-review-one-core.md) — the GitHub App is the **hosted** surface's `TokenSource`;
  the local `revkit review` surface uses the reviewer's own `gh auth token` and needs no App.

## Context

Comments must post as the reviewer (B2, B3); non-GitHub reviewers need access (B5).

## Decision

A **GitHub App** with user-to-server tokens (`pull_requests: write`, `contents: read`). Guests use **self-minted
per-person invite links** (random token, stored hashed, scoped to repo/PR, expiring, revocable, exchanged for an
HttpOnly session). Guest comments are mirrored via the App as "Name (guest)" and cannot count as GitHub approvals.
Authentik OIDC is a follow-up (#4).

## Consequences

Invite minting requires write access.

## Acceptance (2026-09-29)

- **Share types** (`revkit invite --type`): `personal` is the default (14 days, bound to the first browser that opens
  it, can comment); `team` (30 days, several browsers, can comment) and `view` (30 days, several browsers, read-only)
  are opt-in. All are revocable and scoped to the repo, optionally one PR.
- Guest data per ADR-0015. App webhook events: `installation`, `installation_repositories`, `pull_request`,
  `pull_request_review`, `pull_request_review_comment`, `issue_comment`.
