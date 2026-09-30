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
  SVG `url(…)` in presentation attributes and `style=` values whose argument is not a same-document `#ident` fragment
  (issue #27; CSS Syntax Level 3 tokenised via `css-tree` in `site/src/lib/css-url-scan.ts`, so unterminated `url(`,
  `url(x/*)`-style fake-comment payloads, `u\rl(` / `\75 rl(` escape shapes, `image('https://…')` /
  `cross-fade('https://…' …)` / any made-up future URL-shaped function taking a String argument, and `<use xlink:href>`
  precedence tricks all refuse structurally), and SVG `href` / `xlink:href` on **any element** (`<use>`,
  `<linearGradient>`, `<radialGradient>`, `<pattern>`, `<mask>`, `<clipPath>`, `<marker>`, `<symbol>`, `<textPath>`,
  `<a>`, and also `<tspan>`, `<rect>`, the root `<svg>` itself — every element that carries these attributes) that
  is not a raw `#ident` fragment — checked BEFORE percent-decoding, because a browser resolves `%23a` as a relative
  path, not as a fragment. The href predicate (`svgHrefRefusalReason`) is shared with the source sanitiser
  (`render-plot.ts`) — one function, one behaviour. It does NOT stop **UI spoofing**: the allowed element set plus a
  `style="…"` attribute value that carries no URL-shaped token can still build a fixed-position overlay with a link,
  and no HTML-level scan can decide whether a rendered element is trying to look like part of the review UI.
- **Spoofing is controlled at the source, not at the output.** The controls that prevent an agent from emitting
  spoofing markup are the C1 registered-components rule (an MDX doc that carries a raw `<div>`, `<span>` or any other
  lowercase HTML element is refused by the `component-registry` rule; a `style` attribute is refused separately on
  any component call), the frontmatter string refusal on authoring-guarded fields (raw HTML in a title / description
  / label is refused, not escaped), and the props contract of each registered component (`Callout`, `Plot`, …) — a
  prop that takes a string never accepts a JSX or HTML value. `revkit check-dist` remains the last-line defence for
  HTML that DID reach `site/dist/`: for a raw `<div style="…">` to survive to the output it needs a
  `{/* revkit-allow: #NN */}` escape annotation attached to an open `component-request` issue (`revkit escalate`).
  A spoofing shape that landed via a legitimate escape is a component-registry conversation, filed against ADR-0002,
  not a regression in this ADR.
