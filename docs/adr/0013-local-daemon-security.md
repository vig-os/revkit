# ADR-0013: Local daemon security

- Status: Accepted
- Date: 2026-09-29
- Stories: A1–A5, A8
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)

## Context

`revkit serve` exposes an HTTP/WebSocket API on the user's machine, which any website open in the same browser could
try to reach (CSRF / DNS rebinding).

## Decision

- Bind **127.0.0.1 only**, on a random free port written to `.revkit/serve.json` (mode 600).
- The launch link carries a **single-use launch code** (256-bit, valid 2 min). The page exchanges it once for an
  **HttpOnly, SameSite=Strict session cookie** scoped to `127.0.0.1:<port>` and strips it with `history.replaceState`.
  A code that leaks into a transcript or scrollback is already spent; new tabs share the cookie.
- The MCP server and CLI authenticate with a separate per-start token read from `.revkit/serve.json` (mode 600).
- Reject requests whose `Host` isn't `127.0.0.1:<port>`/`localhost:<port>` (DNS rebinding) and whose `Origin` isn't
  the daemon's own; `Sec-Fetch-Site: cross-site` is refused.
- Nothing listens on a public interface; daemon pages get the same CSP as ADR-0012.

## Consequences

Blocks M2.

## Amendment (2026-09-30)

Details of the M2 CSP wiring on `revkit serve` (issue #22, PR follow-up to this ADR):

- **Script path.** The daemon keeps `/-/rail.js` (and `/-/rail.css`) for the rail bundle rather than moving it to
  ADR-0012's `/_revkit/<version>/` convention. Reason: `/_revkit/<version>/` addresses a hosted origin that co-tenants
  many preview paths — the version prefix keeps the CSP `script-src` naming the *current* revkit bundle and refuses an
  older one. The local daemon serves one project at a time from an isolated loopback origin, and the rail bundle is
  built on demand from the CLI's own source tree; there is no older version to load. `script-src` still names the
  exact daemon paths — `http://127.0.0.1:<port>/-/rail.js` and `http://127.0.0.1:<port>/_astro/` — so any other script
  path is refused by the browser as a CSP violation.
- **`connect-src`.** The header lists both `'self'` and `ws://127.0.0.1:<port>` explicitly. CSP L3 defines `'self'` to
  cover the same-origin WebSocket scheme (Chromium ≥ 96, Firefox ≥ 99); the explicit `ws://` origin is defence in
  depth for older WebKit builds that treat `'self'` and `ws://` as distinct schemes.
- **`script-src` without `'unsafe-eval'`.** The rail is authored as `.tsx` and compiled at build time by
  `babel-preset-solid` (Solid's JSX transform, no runtime template compilation): the emitted DOM code contains
  neither `eval(` nor `new Function(...)`. `script-src` therefore ships without `'unsafe-eval'`, and the test suite
  (`test/rail/injector.test.ts` — bundle scan; `test/serve/headers.test.ts` — header mutation guard) fails red if
  either regresses. The previous version of this amendment (also 2026-09-30) allowed `'unsafe-eval'` for the
  `solid-js/html` runtime; that widening is gone.
- **Response hygiene.** Every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, and a `Permissions-Policy`
  denying the powerful features (`camera`, `microphone`, `geolocation`, `payment`, `usb`, `publickey-credentials-*`,
  …). API JSON, `/-/launch-code`, and the `/-/auth` 302 also carry `Cache-Control: no-store`; the SSE stream keeps
  its own `no-cache, no-transform` (stronger than `no-store` for a long-lived response, blocks buffering middleboxes).
- **Inline-script hashes.** The site build emits `dist/.revkit/csp-hashes.json` from the same parse5 walk that
  `revkit check-dist` uses (one source of truth: whatever `check-dist` allowlists, the daemon allows). The daemon
  loads it at startup and **fails closed** if it is missing — HTML still serves, but `script-src` carries no hashes
  and Starlight's inline bootstrap refuses. A startup log line names the artefact path and reason.
