# ADR-0012: Hosted security: threat model, CSP and isolation

- Status: Accepted
- Date: 2026-09-29
- Stories: B1–B5
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)

## Context

Agent-authored and fork-contributed content is rendered on a shared, authenticated origin (`review.exoma.org`), with
previews path-based rather than per-subdomain (ADR-0008).

## Decision

- **Preview paths never serve executable content.** Under `/<repo>/pr-<n>/` the Worker serves only HTML, JSON, images
  (PNG/JPEG/WebP/AVIF) and fonts; `.js`, `.mjs`, `.css`, `.wasm` and anything else are refused. SVG is served with
  `Content-Security-Policy: sandbox` and `Content-Disposition: inline` so it can't run script.
- **All scripts and stylesheets come from a revkit-owned path**, `/_revkit/<version>/`, deployed by revkit's own
  release (never from a PR artifact).
- **Content Security Policy** on every HTML response: `default-src 'none'`; `script-src
  https://review.exoma.org/_revkit/ 'sha256-…'` (only revkit's bundle path plus the hashes of the inline bootstrap
  scripts Astro/Starlight emit: island loader, theme toggle); `style-src 'self' 'unsafe-inline'` (KaTeX, Vega SVG and
  Starlight need inline styles; styles can't execute script); `img-src 'self' data:
  https://avatars.githubusercontent.com`; `font-src 'self'`; `connect-src 'self'` (API and WebSocket);
  `frame-ancestors 'none'`; `base-uri 'none'`; `form-action 'self'`; `object-src 'none'`.
- **The inline-script hash allowlist ships with the revkit release**, produced by the build (Astro's CSP hashing if
  the pinned version supports it, otherwise a revkit post-build step that hashes every inline script), and the Worker
  applies the allowlist of the revkit version it runs, never hashes found in an artifact.
- **Content can't carry code at build:** MDX is compiled with the registry-only guard (ADR-0005); raw HTML,
  `<script>`, `<style>`, inline handlers and `javascript:` URLs fail the build. For fork PRs this is defence in depth
  only, since a fork can alter its own build; the path and CSP rules above are what hold.
- **Sessions:** HttpOnly, Secure, SameSite=Lax cookies; every state-changing call needs a per-session CSRF token in a
  header; the API accepts only `application/json`.
- **Authorization per request:** a GitHub session must still have read access to the repo (cached ≤ 5 min); a guest
  invite is checked for scope, type and expiry on each call.
- **Abuse limits:** rate limits on invite redemption and comment posting per identity and IP (Durable Object
  counters); invite tokens are 256-bit random, stored as HMAC.
- **Fork previews** are published only after a maintainer approves (ADR-0014) and are labelled "untrusted fork".

## Consequences

Blocks M3. Isolation weaker than per-subdomain origins is accepted in exchange for zero certificate cost; revisit if
third-party (non-org) repos are ever onboarded.
