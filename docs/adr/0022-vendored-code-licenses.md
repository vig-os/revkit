# ADR-0022: Vendored code and licenses

- Status: Accepted
- Date: 2026-09-29
- Stories: C1
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)

## Context

The styled component layer is ported from shadcn-solid (copy-in source) into `@revkit/components` (ADR-0002).

## Decision

- Vendored code lives under `packages/components/vendor/<pkg>/` with its upstream `LICENSE` and the upstream commit it
  was taken from; each is listed in `NOTICE` at the repo root.
- Only permissive licenses compatible with Apache-2.0 (MIT, BSD, Apache-2.0) may be vendored.

## Consequences

See Decision.
