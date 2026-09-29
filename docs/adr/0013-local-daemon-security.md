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
