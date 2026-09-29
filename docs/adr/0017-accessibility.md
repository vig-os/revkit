# ADR-0017: Accessibility: WCAG 2.2 AA

- Status: Accepted
- Date: 2026-09-29
- Stories: A1–A3, C6
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)

## Context

Reviewers must be able to read, navigate and comment with keyboard and assistive technology.

## Decision

- Target **WCAG 2.2 AA** for the site and all islands; Kobalte primitives provide the keyboard/ARIA base.
- **axe-core gate** in the Playwright suite fails CI on any violation at serious/critical level.
- Colour tokens are checked for AA contrast in both themes.

## Consequences

See Decision.
