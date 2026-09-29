# ADR-0010: Distribution: revkit as an opt-in flake

- Status: Proposed
- Date: 2026-09-29
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)
- Stories: D1

## Context

Any repo, and devkit consumers in particular, should adopt revkit in one line (D1) without every TS repo carrying Astro.

## Decision

revkit ships a flake: `packages.revkit` (CLI), `lib.hooks` (ADR-0005 guards), `templates.default`. The site stack is
**opt-in**, targeting a devkit `review` module. The generic TS/JS baseline (Bun, lint/format/typecheck, TS guard
patterns) is proposed as a devkit **default** once proven (#1).

## Consequences

Version pinning follows devkit's lockstep policy.
