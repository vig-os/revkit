# ADR-0017: Accessibility: WCAG 2.2 AA

- Status: Accepted
- Date: 2026-09-29
- Stories: A1–A3, C6
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)

## Context

Reviewers must be able to read, navigate and comment with keyboard and assistive technology.

## Decision

- Target **WCAG 2.2 AA** for the site and all islands; Kobalte primitives provide the keyboard/ARIA base.
- **axe-core gate** in the Playwright suite scans every built page and fails CI on any violation (see acceptance
  note below for the strictness change).
- Colour tokens are checked for AA contrast in both themes.

## Acceptance

- 2026-09-30 (M1 item 6, PR #31 review round 1): the axe gate now fails on **any** violation, regardless of
  `impact`. The earlier "serious/critical only" wording matched an intermediate implementation and let advisory
  findings accumulate; the strict gate covers the full AA surface, with narrow, per-selector, per-rule and
  issue-linked documented exceptions as the only escape hatch (see `site/tests/a11y.spec.ts`).

## Consequences

See Decision.
