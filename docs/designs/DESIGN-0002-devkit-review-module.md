# DESIGN-0002 — devkit `review` capability module proposal

| | |
|---|---|
| Status | Proposed 2026-09-30 (not owned by this repo — outward-facing) |
| Issue | [vig-os/revkit#10](https://github.com/vig-os/revkit/issues/10) (M5), ledger [vig-os/revkit#1](https://github.com/vig-os/revkit/issues/1) |
| Date | 2026-09-30 |
| Depends on | [ADR-0010](../adr/0010-distribution-flake-opt-in.md) (distribution), [ADR-0005](../adr/0005-authoring-guards-revkit-check.md) (revkit check), [ADR-0021](../adr/0021-versioning-release.md) (release train) |

revkit ships as a flake today ([ADR-0010](../adr/0010-distribution-flake-opt-in.md), M5 part 1): `packages.revkit`,
`lib.hooks`, `templates.default`. The next step in the [DESIGN-0001 §7](DESIGN-0001-revkit-architecture.md) plan is a
vig-os/devkit **`review` capability module**, so a devkit consumer opts in with `DEVKIT_MODULES="node review"` (or
`review` alone) instead of hand-wiring the flake input in every repo. This document is the proposal to
[vig-os/revkit#1](https://github.com/vig-os/revkit/issues/1) — the elevation ledger — for that module. It is NOT a
plan to write code in this repo (D1 the acceptance criterion works today; this closes the loop for large-N
adoption).

**Scope note.** This design lives in the revkit repo because it documents revkit's side of the contract. The
devkit-side implementation is owned by the vig-os/devkit maintainers; a corresponding issue on that repo is
filed by revkit's owner from this design as the reference material, not by an agent from within revkit.

## 1. What a devkit capability module is (context)

vig-os/devkit ships a scaffold and a set of Nix "capability modules" (`node`, `python`, `guardrails`, ...) that a
consumer selects via the `.vig-os` manifest key `DEVKIT_MODULES` and the flake's `mkProjectShell { modules = [ … ]; }`
call. A module contributes:

- packages to the dev shell (`buildInputs`);
- optional `shellHook` fragments;
- optional pre-commit hook entries the flake-generated `.pre-commit-config.yaml` merges with the base set;
- optional CI wiring (a language marker for `DEVKIT_LANGUAGES`, a resolve-toolchain output).

`review` is a natural fit — the surface is small (one binary, a fixed set of hooks, a doc-shape convention) and
sits at the same layer as `guardrails` in revkit's own `flake.nix` today.

## 2. Proposed shape of `review`

### 2.1 Dev-shell contribution

The module puts `revkit` on PATH and adds no other packages. The CLI is the only surface a consumer touches
day-to-day (`revkit check`, `revkit serve`, `revkit escalate`).

```nix
# devkit/modules/review.nix (sketch)
{ pkgs, revkit, lib, ... }:
{
  buildInputs = [ revkit.packages.${pkgs.system}.revkit ];
  # Consumer opt-in signals:
  #   - .vig-os DEVKIT_MODULES="node review"
  #   - flake.nix modules = [ "node" "review" ];
  hooks = revkit.lib.hooks.mkHooks {
    revkit = revkit.packages.${pkgs.system}.revkit;
  };
}
```

`revkit` here is a devkit flake INPUT that the devkit scaffold seeds:

```nix
# devkit's own flake.nix (managed by devkit)
inputs.revkit.url = "github:vig-os/revkit?ref=<pinned tag>";
```

The pin is bumped by devkit's release train ([ADR-0021](../adr/0021-versioning-release.md) lockstep rule: revkit's
tag, devkit's pin, and consumer's `DEVKIT_VERSION` move together).

### 2.2 Pre-commit hook contribution

`revkit.lib.hooks.mkHooks` is already shipped by this repo (see [`nix/hooks.nix`](../../nix/hooks.nix)); the module
simply forwards it. That keeps ownership on the correct side: revkit knows what its hooks are, devkit knows how to
merge them into the scaffolded `.pre-commit-config.yaml` (via the `hooks =` block on `mkProjectShell`).

### 2.3 Manifest and workflow surface

- `.vig-os` gains no new keys: `DEVKIT_MODULES` already accepts a module list.
- `resolve-toolchain` gains `review` as a valid module name.
- `DEVKIT_LANGUAGES` — no new value. A `review` consumer is almost always ALSO a `node` consumer (Bun-driven docs),
  so the language gate stays orthogonal.

### 2.4 CI workflow contribution

Two options; both work, second is preferred:

1. **Extra job in the shared `ci.yml`.** devkit adds a `revkit-check` job to the managed workflow when the
   module is selected. Simple but couples the workflow file to the module list.

2. **A separate `revkit-guards.yml` managed template.** devkit ships the same file the revkit repo already
   owns (`.github/workflows/revkit-guards.yml`) as a managed template when the module is selected. This is
   the pattern devkit already uses for `codeql.yml` and `scorecard.yml`. **Preferred.**

Under either option, the workflow runs `nix develop -c revkit check --online` on PRs, with a token scoped to
`contents: read`, `issues: read` — matching the ADR-0014 secret discipline.

## 3. Contract with revkit

For the module to compose cleanly, revkit commits to:

- **A stable `packages.<system>.revkit`.** The wrapper binary, ADR-0010's D1 surface. Its `--version` string
  is the source of truth; the module never inspects internals.
- **A stable `lib.hooks.mkHooks`.** Input shape is `{ revkit, extraFiles? }`; output shape is a devkit-compatible
  `hooks =` attrset. See [`nix/hooks.nix`](../../nix/hooks.nix). Breaking either shape is a MAJOR release under
  [ADR-0021](../adr/0021-versioning-release.md).
- **A stable `templates.default`.** `nix flake init -t github:vig-os/revkit` continues to scaffold a docs repo
  that the `review` module can consume. Additions are compatible; removals or renames are a MAJOR release.

Anything below `packages.revkit.passthru` is INTERNAL and may change without a version bump.

## 4. Migration path (existing revkit consumers)

Before the module lands, a consumer wires revkit by hand:

```nix
# consumer's flake.nix (today)
inputs.revkit.url = "github:vig-os/revkit?ref=<tag>";
outputs = { self, revkit, ... }: {
  devShells.<system>.default = pkgs.mkShell {
    packages = [ revkit.packages.<system>.revkit ];
  };
};
```

After the module lands, the wire-up collapses to:

```
# consumer's .vig-os
DEVKIT_MODULES="node review"
```

There is no compatibility break: the hand-wired form continues to work. The module is sugar.

## 5. Gap between M5 part 1 and full D1 acceptance

M5 part 1 ships the flake plumbing but NOT a way for a consumer to render their own docs. The template's third
command (`revkit serve`) currently binds and serves whatever tree is passed to `--dir`, but there is no
`revkit build` that renders arbitrary consumer docs through the packaged Astro/Starlight site. That gap is
called out explicitly on the [FEATURE-MATRIX](../FEATURE-MATRIX.md) D1 row and blocks the row from flipping to
`shipped`.

What is missing (M5 part 2):

- **`revkit build [--dir <root>]`** — renders the consumer's `docs/` (plus `vocab/`, `plots/`) with revkit's
  PACKAGED site. Uses the packaged `node_modules/.bin/astro` by ABSOLUTE PATH (no `bunx`, no PATH lookup),
  reuses the safety machinery from `packages/cli/src/review/build.ts` shipped by PR #48 (env allowlist, token
  denylist, per-build `HOME`, vite `cacheDir` outside the sandbox). Output at
  `<consumer>/.revkit/dist/`.
- **Site becomes root-configurable.** `site/astro.config.mjs`, `site/src/content.config.ts` and the
  `repoDocsLoader` / `plotsLoader` / vocab-file loader currently read from a hardcoded `REPO_ROOT` two
  parents up from `site/`. They need to accept a `REVKIT_CONSUMER_ROOT` env var so the packaged site can
  render an external tree. Sidebar generation switches from the ADR/design-specific
  `slugsFromRepoDir("adr")` / `slugsFromRepoDir("designs")` to Starlight's autogenerate when no ADR tree
  exists — behaviour still to design.
- **`revkit serve` auto-build.** When `--dir` is missing and `<root>/.revkit/dist/` does not exist, `serve`
  runs `revkit build` first (or prints the exact command). Today it refuses on a missing dir.
- **Template smoke asserts real content.** `scripts/template-smoke.sh` currently accepts a `404` from
  `GET /` as proof-of-life; once `revkit build` exists, the smoke asserts the built page's title AND the
  rail's `<script src="/-/rail.js">` tag (injected by the daemon).
- **Coordinate with PR #48.** `runSafeBuild` in `packages/cli/src/review/build.ts` already handles trusted-
  toolchain-by-absolute-path, an env allowlist and a per-build `HOME`. M5 part 2 either extracts a shared
  primitive both `revkit review` and `revkit build` call, or `revkit build` reuses PR #48's module directly.
  A single build implementation is the target — not two.

## 6. Open questions for the devkit maintainers

Filed here for the outward-facing issue to reference; not blocking on M5 part 1 (M5 part 2, the gap in §5,
is blocking on the D1 row flipping to `shipped`):

1. **Where does the pin live?** Right now this doc assumes devkit ships a pinned `inputs.revkit` in its own
   flake. An alternative is per-consumer pins in `.vig-os` (`REVKIT_VERSION=`). devkit's other modules pin
   inputs centrally; matching that is the low-friction option, but it couples revkit and devkit release
   cadences even for consumers that would rather float.

2. **Site-stack default versus opt-in.** [ADR-0010](../adr/0010-distribution-flake-opt-in.md) leaves the site
   stack (Astro/Starlight/Tailwind) opt-in; the `review` module by default ships the CLI ONLY. A separate
   `review-site` module (or a `review = { site = true; }` submodule) covers the site case if we discover a
   large enough population that wants an all-in-one dev shell. Deferred until the demand appears.

3. **What about the generic TS/JS baseline?** [Ledger #1](https://github.com/vig-os/revkit/issues/1) tracks a
   TS/JS baseline (Bun, lint/format/typecheck, TS stub patterns for guardrails, registry-import guard) as a
   devkit DEFAULT for TS/JS consumers. That is a separate proposal — the `review` module composes with it,
   not against it.

## Acceptance criteria for the devkit-side change (for the outward issue)

- `DEVKIT_MODULES="review"` puts `revkit` on the dev-shell PATH.
- `nix develop -c revkit check` runs the ADR-0005 guards on the consumer repo.
- The scaffolded `.pre-commit-config.yaml` includes the `revkit-check` hook from `revkit.lib.hooks.mkHooks`.
- The scaffolded CI runs `revkit check --online` on PRs with no repo secrets.
- A consumer whose `DEVKIT_VERSION` and `revkit` pin move together (per [ADR-0021](../adr/0021-versioning-release.md)
  lockstep) never sees a state where the CLI and the guards disagree.

## Ledger candidate (for the PR body / issue #1 comment)

**Elevation candidate: devkit `review` capability module.** Ship a devkit module that puts revkit's CLI on the
dev-shell PATH, merges `revkit.lib.hooks.mkHooks` into the flake-generated `.pre-commit-config.yaml`, and ships
a managed `revkit-guards.yml` workflow when `DEVKIT_MODULES` contains `review`. Reference: revkit DESIGN-0002.
