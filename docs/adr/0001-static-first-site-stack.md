# ADR-0001: Static-first site stack: Astro, Starlight, Bun

- Status: Accepted
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

Starlight's built-ins (Aside, Tabs, Steps, Cards, FileTree, Badge, Expressive Code) seed the component set;
navigation stays on Starlight's stock sidebar + prev/next (see the 2026-09-30 amendment below). Rust tooling is
deferred until revkit owns compiled code.

## Acceptance (2026-09-29)

- Versions are **exact** in `package.json`/`bun.lock`; Renovate opens bump PRs that CI and the guards must pass. A
  bump needs no ADR change unless it changes behaviour this ADR relies on.
- Starting set: Astro 7.3, Starlight 0.42, Bun from the flake (1.3).

## Amendment (2026-09-30)

Navigation uses Starlight's **stock sidebar and prev/next**, plus its built-in responsive layout — no custom
"train-line" component, no sidebar override. Doc sets (ADRs, design docs, feature matrix today; future sets
under `docs/sets/*` will map the same way once a loader exists) map to sidebar groups in
`site/astro.config.mjs`; Starlight's default pagination gives the prev/next chain a train line would otherwise
carry. Owner decision (2026-09-30): stay minimal on modification and maximal on the impact of having a review
tool at all. Status remains **Accepted**.

## Amendment (2026-09-30) — fast-path publish (M2 item 9, story A4)

The story bar is **under one second from `publish` to visible page refresh, without a full site build**. This ADR
originally said "no custom partial-rebuild layer: dev-server HMR for the local loop, JSON-rendered question pages,
full builds in CI." The `revkit publish` MCP tool needs a live path that is faster than `astro build` (3–5 s on this
repo) but that produces the SAME anchors and CSP shape a full build produces. The resolution:

- **Daemon fast path.** The `publish` MCP tool posts a batch (`docs`, `data`) to `POST /api/publish`. The daemon
  confines each path to an allowlist (`docs/adr/`, `docs/designs/`, `docs/FEATURE-MATRIX.md`, `plots/`,
  `vocab/terms.yaml`), size-caps every file (5 MiB per file, 10 MiB per batch), atomically writes each one, and
  runs `revkit check` (offline, trusted mode) over the batch. On any refusal the write is rolled back byte-for-byte.
- **Rendering.** For `.md` files under `docs/`, the daemon runs the SAME unified pipeline `site/astro.config.mjs`
  configures — `remark-parse → remark-math → remark-rehype → rehype-katex-strict → rehype-drop-repo-doc-title
  → rehype-data-src → rehype-stringify` — so `data-src` stamps (ADR-0006, C6) are identical to what a full build
  emits. The result is spliced into the `<div class="sl-markdown-content">…</div>` region of the last full build's
  HTML shell (which Starlight already produced), so the sidebar, header, footer and every allowlisted `<script>`
  are byte-preserved. The daemon holds the spliced HTML as an in-memory OVERRIDE keyed on the site route; the next
  `astro build` clears it. The override responses still flow through the daemon's response-hygiene wrapper, so the
  full CSP (`default-src 'none'`, `'wasm-unsafe-eval'` only, allowlisted rail path, no `'unsafe-eval'`, see
  ADR-0013 amendment) applies unchanged.
- **Event fanout.** Publish appends a new `doc.published` event with the new revision and the site route, plus
  `presence editing`/`presence idle` around the write (ADR-0007 §5.3). The rail listens for `doc.published` and
  reloads only when the event's `route` matches its own — so a batch of ADRs updates each open page independently.
- **Scope of the fast path.** M2 covers `.md` files under `docs/adr/`, `docs/designs/`, `docs/FEATURE-MATRIX.md`,
  plus data side files under `plots/<name>/` and `vocab/terms.yaml`. MDX under `site/src/content/docs/` is
  DEFERRED: MDX compiles component JSX through `@astrojs/mdx` and runs Starlight's expressive-code integration on
  code blocks; reproducing those in a single-page pipeline is a bigger surface than the M2 loop needs. The
  publish confinement refuses MDX writes today, so a follow-up amendment (with an equivalence proof against
  `astro build` output for a real site MDX page) unlocks that scope without silently widening this one.
- **Not moved off the plan.** Dev-server HMR remains the tool of choice for the local *authoring* loop (an author
  editing MDX in `site/` with `astro dev`). This amendment only covers the AGENT publish loop, which does not
  have a dev server on the wire.

Non-goals unchanged: the daemon does NOT run a Vite/Astro process; the fast path is a plain unified pipeline
composed in Bun. A route the daemon does not have a shell for (a brand-new page whose slug never made it into a
full build) emits `doc.published` without an override — the next `bun run build` in the same repo catches it up.
Status remains **Accepted**.
