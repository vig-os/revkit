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
  https://review.exoma.org/_revkit/<current-version>/ 'sha256-…'` (only revkit's bundle path plus the hashes of the
  inline bootstrap scripts Astro/Starlight emit: island loader, theme toggle); `style-src 'self' 'unsafe-inline'`
  (KaTeX, Vega SVG and Starlight need inline styles; styles can't execute script); `img-src 'self' data:
  https://avatars.githubusercontent.com`; `font-src 'self'`; `connect-src 'self'` (API and WebSocket);
  `frame-ancestors 'none'`; `base-uri 'none'`; `form-action 'self'`; `object-src 'none'`.
- **The inline-script hash allowlist ships with the revkit release**, produced by the build (Astro's CSP hashing if
  the pinned version supports it, otherwise a revkit post-build step that hashes every inline script), and the Worker
  applies the allowlist of the revkit version it runs, never hashes found in an artifact.
- **Response hygiene:** every response sets `X-Content-Type-Options: nosniff`; the Worker derives `Content-Type` from
  the file extension against its own allowlist, never from artifact or object metadata.
- **`/_revkit/` never redirects** (no trailing-slash or `latest` aliases): browsers drop the path part of a CSP source
  after a redirect, which would widen `script-src`. `script-src` names only the **current** revkit version, so a page
  can't load an older, possibly vulnerable bundle.
- **Fork HTML can still carry `<astro-island>` elements with props it controls** and trigger the allowed loader. So
  component props and preview JSON are **untrusted input**: components never render them through `innerHTML` or
  equivalent, and no component makes a state-changing call without an explicit user action.
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

## Amendment (2026-09-30)

Clarifications from the M2 build-out of the CSP on `revkit serve` (issue #22; see also the ADR-0013 amendment on the
same date for the local daemon's per-directive specifics).

- **Inline-script hash allowlist as a release artefact.** The M2 daemon consumes the same set. The site build emits
  `dist/.revkit/csp-hashes.json` (version `1`, algorithm `sha256`, a sorted deduped array of hex digests) from the
  same parse5 walk `revkit check-dist` uses; a hash `check-dist` allows on disk is a hash the daemon serves the
  CSP for. The Worker (M3/M4) will read the same artefact from the release bundle rather than reprocessing HTML.
- **`script-src` path scoping.** The M2 daemon lists the exact loopback URLs for its script sources
  (`http://127.0.0.1:<port>/-/rail.js` and `.../_astro/`). The hosted Worker will use `/_revkit/<version>/` on the
  revkit-owned origin as this ADR already prescribes; the daemon exception is documented in ADR-0013.
- **`'unsafe-eval'` scope.** ADR-0012's `script-src` never contains `'unsafe-eval'`, and the M2 daemon does not
  either: the rail is JSX-compiled at build time with `babel-preset-solid`, so the bundle has no runtime template
  compilation. The mutation guards in `test/serve/headers.test.ts` and `test/rail/injector.test.ts` refuse a
  regression. See ADR-0013 amendment.
- **`connect-src` and WebSocket.** CSP L3 (Chromium ≥ 96, Firefox ≥ 99) treats `'self'` as covering `ws://` on the
  same origin; the hosted Worker keeps `'self'` alone. The local daemon adds an explicit `ws://127.0.0.1:<port>` for
  older WebKit builds.
- **Response hygiene beyond `nosniff`.** Every response also carries `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, and a `Permissions-Policy`
  denying camera / microphone / geolocation / payment / USB / WebAuthn / display-capture / … . API JSON, launch-code
  responses, and the `/-/auth` 302 carry `Cache-Control: no-store`. The M3/M4 Worker will ship the same set.
