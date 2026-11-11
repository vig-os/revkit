# ADR-0020: Observability and logging

- Status: Accepted
- Date: 2026-09-29
- Stories: D2
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)

## Context

The hosted Worker and local daemon need diagnosable failures without leaking review content.

## Decision

- **Structured JSON logs** (Workers Logs locally via `wrangler tail`), with a request id per call.
- **No personal data or content:** no comment bodies, emails, tokens or cookies in logs; identities as opaque ids.
- Errors carry the request id to the UI so a reviewer can report it.

## Consequences

Relates to ADR-0015.
