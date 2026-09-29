# ADR-0009: Auth: GitHub App user-to-server, invite links, Authentik later

- Status: Proposed
- Date: 2026-09-29
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)
- Stories: B2, B3, B5

## Context

Comments must post as the reviewer (B2, B3); non-GitHub reviewers need access (B5).

## Decision

A **GitHub App** with user-to-server tokens (`pull_requests: write`, `contents: read`). Guests use **self-minted
per-person invite links** (random token, stored hashed, scoped to repo/PR, expiring, revocable, exchanged for an
HttpOnly session). Guest comments are mirrored via the App as "Name (guest)" and cannot count as GitHub approvals.
Authentik OIDC is a follow-up (#4).

## Consequences

Invite minting requires write access.
