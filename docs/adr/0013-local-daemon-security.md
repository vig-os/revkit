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
  exact daemon paths — `http://127.0.0.1:<port>/-/rail.js`, `http://127.0.0.1:<port>/_astro/` and
  `http://127.0.0.1:<port>/pagefind/` — so any other script path is refused by the browser as a CSP violation. Every
  path source appears twice: once for `127.0.0.1:<port>` and once for `localhost:<port>`, matching what
  `isLoopbackHost` accepts (a page opened on either alias loads the same set).
- **`connect-src` + WebSocket.** The header lists `'self'` and both explicit `ws://` origins
  (`ws://127.0.0.1:<port>`, `ws://localhost:<port>`). CSP L3 defines `'self'` to cover the same-origin WebSocket
  scheme (Chromium ≥ 96, Firefox ≥ 99); the explicit `ws://` origins are defence in depth for older WebKit builds.
- **`script-src` without `'unsafe-eval'`; `'wasm-unsafe-eval'` only.** The rail is authored as `.tsx` and compiled at
  build time by `babel-preset-solid` (Solid's JSX transform, no runtime template compilation): the emitted DOM code
  contains neither `eval(` nor `new Function(...)`. Starlight search (pagefind) instantiates a small `.wasm` module
  from its Worker, which requires `'wasm-unsafe-eval'` — the CSP L3 keyword that allows `WebAssembly.instantiate` on
  a byte sequence, but does **not** widen JavaScript eval / `new Function()`. Documented in Chrome's CSP spec and
  supported by Firefox 108+, Safari 16+. The bundle scan in `test/rail/injector.test.ts` still refuses any `eval(` or
  `Function(` in the built rail JS, and `test/serve/headers.test.ts` asserts `'unsafe-eval'` is not in `script-src`.
- **Pagefind (Starlight search).** `script-src` also allows the `/pagefind/` path (Pagefind's runtime); `worker-src
  'self'` lets it spawn a Worker; `connect-src 'self'` covers its `.pf_meta` / `.pf_index` / `.pf_fragment` fetches;
  the daemon MIME allowlist gains `application/octet-stream` for `.pagefind`, `.pf_meta`, `.pf_index`, `.pf_fragment`
  and `.pf_filter` so search actually returns results (this piece was broken on `dev` even before the CSP; #22 fixes
  both).
- **Inline-script hashes come from the committed set.** The daemon reads its `sha256-…` allowlist from
  `packages/cli/src/dist-check-allowlist.json` — the same set `revkit check-dist` enforces on disk — and NEVER from
  anything the served dir carries. A previous draft of this amendment loaded them from
  `dist/.revkit/csp-hashes.json`; that let whoever controlled the build (the PR author, under M3 previews) inject
  their own hashes. Reverted; the daemon now IGNORES `.revkit/csp-hashes.json` in the served tree. Integration test:
  a served dir carrying a forged `csp-hashes.json` next to an extra inline `<script>` — the daemon's header does not
  carry the forged hash and the browser refuses the extra script.
- **Non-HTML CSP applies to document-shaped responses only.** SVG carries `default-src 'none'; frame-ancestors
  'none'; sandbox` (matching ADR-0012's SVG-upload handling: a `.svg` typed into the URL bar is opened as its own
  document and `sandbox` denies any `<script>` inside it from running). XML carries the same minimal policy without
  `sandbox` (an XSLT-styled XML is also a document). Other asset kinds — JS chunks, CSS, images, fonts, JSON bodies,
  `.wasm`, `.pf_meta` / `.pf_index` / `.pf_fragment` search chunks — DO NOT carry a CSP header of their own.
  Rationale: a JS response used as a Worker's script inherits its own CSP inside the Worker, so a subresource-style
  `default-src 'none'` on `pagefind-worker.js` would deny Pagefind's own `fetch()` for the search index. Attaching a
  CSP on non-document assets adds bytes for no browser behaviour (a text/plain 404 body or a JS chunk opened directly
  in the URL bar renders as source, no script execution). Every response still carries the hygiene triplet.
- **Response hygiene.** Every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, and a `Permissions-Policy`
  denying the powerful features (`camera`, `microphone`, `geolocation`, `payment`, `usb`, `publickey-credentials-*`,
  …). API JSON, `/-/launch-code`, and the `/-/auth` 302 also carry `Cache-Control: no-store`; the SSE stream keeps
  its own `no-cache, no-transform` (stronger than `no-store` for a long-lived response, blocks buffering middleboxes).

## Amendment (2026-09-30, issue #44 — localhost canonicalisation)

Both loopback aliases (`127.0.0.1` and `localhost`) point at the daemon and both pass the Host check for
DNS-rebinding defence. But browsers scope cookies to a HOST, not a port pair: a user who exchanges the launch
code on `http://127.0.0.1:<port>/-/auth?code=…` gets a session cookie for `127.0.0.1`, and any later navigation
to `http://localhost:<port>/` has no cookie and every `/api/*` fetch returns 401.

**Decision.** `127.0.0.1` is the CANONICAL origin. Any request whose Host is `localhost:<port>` is 307'd to the
same path on `127.0.0.1:<port>`. The 307 preserves method + body and carries the query string, so a `localhost`
launch URL round-trips through the exchange on the canonical origin and the cookie lands where every subsequent
request expects it. The CSP still names both aliases so an already-loaded page's asset fetches never fail on the
way in; the browser follows the 307 to 127.0.0.1 and loads there.

WebSocket upgrades do not follow 307s, so a `localhost` upgrade is refused with 421 Misdirected Request rather
than silently failing. In practice the rail opens `/events` from the page's own origin, which is already
canonical after the initial navigation redirect.

Alternative rejected: accepting the exact `http://localhost:<port>` origin (and keeping two parallel session
cookies) would double the auth surface and leave the "user pastes localhost URL after exchanging on 127.0.0.1"
case still broken. Canonicalisation is one origin, one cookie jar, one mental model.

## Amendment (2026-10-03, issue #63 — the persistent repo id)

`.revkit/repo-id` is a third file under the mode-0700 `.revkit/` alongside `serve.json` and `daemon.lock`, and until
issue #63 it was documented nowhere. It exists because an ORIGIN is `127.0.0.1:<port>`: a browser profile that serves
two repos in turn on one fixed `--port` keeps ONE `localStorage`, so the rail's per-viewer "seen" marks need a key that
changes per repo. Per-start `instanceId` was the wrong key (every restart re-fires every unread pill); a repo-scoped id
is the right one.

**Decision.**

- **What it is.** A 24-char base64url random tag (144 bits), mode 0600, written once per repo and never rotated. It is
  NOT derived from the repo path, so the unauthenticated `GET /-/health` that echoes it as `repoId` cannot let a caller
  fingerprint the caller's filesystem layout. It is NOT a credential: it authorises nothing, is not accepted by any
  endpoint, and carries no data — contrast the per-start `agentToken` in the Decision above. Removing the file only
  costs the reviewer their acknowledge history for that repo.
- **Minted once, under the daemon lock.** The mint is a check-then-write, so it happens inside `acquireAndPublish`
  AFTER the `flock(2)` on `.revkit/daemon.lock` is won, never before it. Two starts that overlapped an unlocked mint
  would each mint and each write a different id; the lock then elects one winner while the file is left holding the
  loser's — the winner advertises an id that is not on disk and the next restart reads a third, which resets the very
  ack state the id exists to protect. A start that does not win the lock does not read or write the file at all.
- **Published by rename.** The write goes through a 0600 temp file plus `rename(2)` — the same path `serve.json`
  already uses — so a concurrent reader sees the old file or the new one, never a truncated payload. A truncated file
  is not a cosmetic failure here: it fails the shape check, the daemon mints a replacement, and that alone resets the
  reviewer's marks.
