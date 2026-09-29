# ADR-0005: Authoring guards: `revkit check` with an escalation path

- Status: Accepted
- Date: 2026-09-29
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)
- Stories: C1, C2, C3, C4

## Context

Consistency must be enforced, not requested: no hand-rolled UI, one vocabulary, valid links and sets, structured plots
(C1–C4).

## Decision

One CLI, `revkit check`, runs as flake-exported prek hooks and again at build: component-registry, vocabulary, links +
doc sets, plot-structure, no-hand-rolled-UI. The escape is `{/* revkit-allow: #N */}`, which must reference an open
`component-request` issue; `revkit escalate` files it, or asks the user in the local loop.

## Consequences

Generic halves (registry-import guard, TS stub patterns) are devkit elevation candidates (#1).

## Acceptance (2026-09-29)

- `gitleaks` joins the hook set in M1 (the guardrails catalogue lists it; nothing ran it), see ADR-0014.
