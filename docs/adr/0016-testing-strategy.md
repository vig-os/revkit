# ADR-0016: Testing strategy

- Status: Accepted
- Date: 2026-09-29
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)

## Context

revkit spans guards, a daemon, an MCP surface, a static site and a Worker; the owner requires every layer in CI from M1.

## Decision

- **Unit:** `bun test` for guards, anchoring/re-anchoring, the ADR index, mention resolution, invite logic.
- **End-to-end:** Playwright (Chromium + WebKit) for the comment rail, question kinds, handover, and re-anchoring across
  a rebuild.
- **Visual regression:** Playwright screenshots of key pages at phone (390 px), tablet (820 px) and desktop (1440 px);
  baselines committed, updated only in PRs that intend the change.
- **MCP contract tests:** scripted agent calls (`ask`/`await_answer`/`threads`/`reply`/`resolve`) against a running
  daemon.
- **Accessibility:** the axe check runs inside the Playwright suite (ADR-0017).
- All run in CI on every PR from M1; `just test` runs unit + contract locally, `just e2e` the browser suites.

## Consequences

Stories: all; E1. Browsers per ADR-0018.
