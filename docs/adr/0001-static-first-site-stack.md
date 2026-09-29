# ADR-0001: Static-first site stack: Astro, Starlight, Bun

- Status: Proposed
- Date: 2026-09-29
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)
- Stories: C3, C5, C6, A4, E1

## Context

revkit renders agent-authored docs for humans, locally in a sub-second loop and hosted per PR. It needs responsive
layouts, navigation, search and islands of interactivity without shipping an SPA (DESIGN-0001 §2).

## Decision

Use **Astro 7** (static output, islands, content collections, Vite dev server) with **Starlight** as the docs shell,
and **Bun** as runtime, package manager and daemon host. No custom partial-rebuild layer: dev-server HMR for the local
loop, JSON-rendered question pages that need no rebuild, full builds in CI. Math renders at build with `remark-math` +
`rehype-katex` (CSS and fonts only, no client JS).

## Consequences

Starlight's built-ins (Aside, Tabs, Steps, Cards, FileTree, Badge, Expressive Code) seed the component set; the
train-line nav is a sidebar override. Rust tooling is deferred until revkit owns compiled code.
