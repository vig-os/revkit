# ADR-0002: Solid islands and a single component registry

- Status: Proposed
- Date: 2026-09-29
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)
- Stories: C1, A1–A3, E1

## Context

Interactive parts (comment rail, question widgets) must stay light, and agents must not hand-roll UI (C1).

## Decision

Islands use **Solid** (4 KB gz measured) on **Kobalte** primitives. A styled layer ported from **shadcn-solid** is
vendored once into `@revkit/components`; content and consumers import it, never copy it. Styling is Tailwind via
`@astrojs/starlight-tailwind`.

## Consequences

React-only libraries are out of scope. New components go through the escalation path (ADR-0005).
