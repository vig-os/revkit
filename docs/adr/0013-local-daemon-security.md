# ADR-0013: Local daemon security

- Status: Accepted
- Date: 2026-09-29
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)

## Context

`revkit serve` exposes an HTTP/WebSocket API on the user's machine, which any website open in the same browser could
try to reach (CSRF / DNS rebinding).

## Decision

- Bind **127.0.0.1 only**, on a random free port written to `.revkit/serve.json` (mode 600).
- A per-start **bearer token** (256-bit) is required on every API and WebSocket call; the browser gets it once through
  the URL fragment of the launch link and keeps it in `sessionStorage`.
- Reject requests whose `Host` isn't `127.0.0.1:<port>`/`localhost:<port>` (DNS rebinding) and whose `Origin` isn't the
  daemon's own; `Sec-Fetch-Site: cross-site` is refused.
- The MCP server talks to the daemon over the same token; nothing listens on a public interface.

## Consequences

Stories: A1–A5, A8. Blocks M2.
