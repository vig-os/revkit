# ADR-0008: Hosting: one Cloudflare Worker per org, `revkit deploy`

- Status: Accepted
- Date: 2026-09-29
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)
- Stories: B1, B5, D2

## Context

PR previews need auth, a thread API, GitHub sync and live fan-out per org (B1–B5, D2).

## Decision

One **Cloudflare Worker per org**, using R2 (one built site per repo and PR), D1 (threads, invites, sessions) and
Durable Objects (live fan-out). Previews are served path-based at `<domain>/<repo>/pr-<n>/` (see Acceptance). Set up
with the guided, idempotent
`revkit deploy init|enable|status|destroy`; the upload secret is declared through an org-config PR.

## Consequences

GitHub Pages only for public read-only previews (no auth; the Free plan excludes private repos).

## Acceptance (2026-09-29)

- **Domain:** `exoma.org` (unused EXOMA org domain) moves to the EXOMA Cloudflare account on the Free plan; the app is
  at
  **`review.exoma.org`** (Workers Custom Domain, free certificate).
- **Previews are path-based:** `review.exoma.org/<repo>/pr-<n>/`. A nested wildcard (`*.review.exoma.org`) would need a
  paid certificate, and a wildcard over `*.exoma.org` would capture the whole domain; the isolation that subdomains
  would
  give is provided instead by ADR-0012 (CSP, registry-only content, CSRF).
- **Plan:** Workers Free covers v1 (R2, D1, SQLite-backed Durable Objects); revisit at the free-tier limits.
- **Order:** the Worker and `revkit deploy init` (M4 #9) land before M3's preview deploys (#8).
- Production deploys go through the GitHub `production` environment with **all vig-os org owners** as required
  reviewers; secrets per ADR-0014.
