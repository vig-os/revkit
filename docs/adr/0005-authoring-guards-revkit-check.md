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

## Amendment (2026-09-30)

- **Scope of `revkit check-dist` is HTML shape, not user-facing intent.** The output-gate sanitiser
  (`packages/cli/src/check-dist.ts`) refuses inline handlers, `javascript:`/`vbscript:` URLs, off-origin subresource
  fetches, refused elements (`iframe`, `object`, `base`, `noscript`, `form`, `style`, SMIL), off-list inline scripts,
  SVG `url(https://…)` in presentation attributes (issue #27) and SVG `<use href>` that is not a same-document
  `#fragment` (issue #27). It does NOT stop **UI spoofing**: the allowed element set plus a `style="…"` attribute is
  enough to build a fixed-position overlay with a link, and no HTML-level scan can decide whether a rendered element
  is trying to look like part of the review UI.
- **Spoofing is controlled at the source, not at the output.** The controls that prevent an agent from emitting
  spoofing markup are the C1 registered-components rule (no hand-rolled HTML/CSS/JS; `<div>`, `<span>` and inline
  `style` do not survive an MDX parse into the registered component set), the frontmatter string refusal on
  authoring-guarded fields (raw HTML in a title / description / label is refused, not escaped), and the props
  contract of each registered component (`Callout`, `Plot`, …) — a prop that takes a string never accepts a JSX or
  HTML value. `revkit check-dist` remains the last-line defence for HTML that DID reach `site/dist/`, and any
  spoofing shape that made it that far is a bug in the source guards, filed against ADR-0002 or ADR-0003, not a
  regression in this ADR.
