# ADR-0008: Hosting: one Cloudflare Worker per org, `revkit deploy`

- Status: Proposed
- Date: 2026-09-29
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)
- Stories: B1, B5, D2

## Context

PR previews need auth, a thread API, GitHub sync and live fan-out per org (B1–B5, D2).

## Decision

One **Cloudflare Worker per org**, using R2 (one built site per repo and PR), D1 (threads, invites, sessions) and
Durable Objects (live fan-out). Previews are served at `pr-<n>--<repo>.<domain>`. Set up with the guided, idempotent
`revkit deploy init|enable|status|destroy`; the upload secret is declared through an org-config PR.

## Consequences

GitHub Pages only for public read-only previews (no auth; the Free plan excludes private repos).
