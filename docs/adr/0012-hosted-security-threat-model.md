# ADR-0012: Hosted security: threat model, CSP and isolation

- Status: Accepted
- Date: 2026-09-29
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)

## Context

Agent-authored and fork-contributed content is rendered on a shared, authenticated origin (`review.exoma.org`), with
previews path-based rather than per-subdomain (ADR-0008).

## Decision

- **Content can't carry code:** MDX is compiled at build with the registry-only guard (ADR-0005); raw HTML, `<script>`,
  `<style>`, inline handlers and `javascript:` URLs fail the build, so they never deploy.
- **Strict CSP** on every response: `default-src 'self'`; scripts only from hashed/self bundles (no `unsafe-inline`,
  no `unsafe-eval`); `frame-ancestors 'none'`; `object-src 'none'`; `base-uri 'none'`.
- **Sessions:** HttpOnly, Secure, SameSite=Lax cookies scoped to `/`; every state-changing API call needs a per-session
  CSRF token in a header; the API only accepts `application/json`.
- **Authorization per request:** a GitHub session must still have read access to the repo (cached ≤ 5 min); a guest
  invite is checked for scope, type and expiry on each call.
- **Abuse limits:** rate limits on invite redemption and comment posting per identity and IP (Durable Object counters);
  invite tokens are 256-bit random, stored as HMAC.
- **Fork PRs:** previews build with no secrets (ADR-0014) and are labelled "untrusted fork" in the UI.

## Consequences

Stories: B1–B5. Blocks M3. Isolation weaker than per-subdomain origins is accepted in exchange for zero certificate
cost; revisit if third-party (non-org) repos are ever onboarded.
