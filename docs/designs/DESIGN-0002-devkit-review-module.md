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

## 5. M5 part 2 (shipped): consumer-docs rendering through the packaged site

M5 part 1 shipped the flake plumbing without a way for a consumer to render their own docs. M5 part 2
(closed by [vig-os/revkit#57](https://github.com/vig-os/revkit/issues/57)) fills that gap so the D1
row on the [FEATURE-MATRIX](../FEATURE-MATRIX.md) can flip to `shipped`.

### 5.1 What ships

- **`revkit build [--dir <root>] [--out <path>]`** — renders the consumer's `docs/` (plus `vocab/`, `plots/`)
  through revkit's PACKAGED Astro/Starlight site. Invokes the packaged `node_modules/.bin/astro` by
  ABSOLUTE PATH (no `bunx`, no `npx`, no PATH lookup). Runs `revkit check` first (authoring guards)
  and `revkit check-dist` after (ADR-0012 output-gate). Output at `<consumer>/.revkit/dist/`.
- **A shared safe-build primitive.** `packages/cli/src/review/build.ts` now exports `spawnAstroBuild`,
  a low-level spawn wrapper with the env allowlist, the token denylist, the per-build `HOME` / `TMPDIR`
  scratch, the `--outDir` pass-through and the deny of every CI-shape variable. Both `runSafeBuild`
  (the `revkit review` sandbox path from PR #48) and `runPackagedBuild` (the new `revkit build` path)
  call it. One implementation of the primitive; two callers, each carrying their own layout / wrapper-
  config / symlink concerns.
- **Site becomes root-configurable via `REVKIT_CONSUMER_ROOT`.** `site/astro.config.mjs` and
  `site/src/content.config.ts` read the env var through `site/src/lib/consumer-root.ts` and switch:
  - `REPO_ROOT` (used by `rehype-data-src` for source anchors) points at the consumer root.
  - The Starlight sidebar autogenerates from the consumer's `docs/` directory shape via
    `buildConsumerSidebar` — each top-level `.md`/`.mdx` becomes a link item at the collection
    root, each subdirectory becomes a labeled group. The revkit-specific `slugsFromRepoDir("adr")` /
    `slugsFromRepoDir("designs")` groups only run when `REVKIT_CONSUMER_ROOT` is UNSET.
  - `repoDocsLoader` is skipped in consumer mode; the docs collection uses Starlight's default
    `docsLoader()` reading from `<staging>/src/content/docs/` (a real dir populated by copying the
    consumer's docs tree at build time).
  - `vocab` and `plots` collections fall back to empty inline loaders when the consumer omits those
    trees; when present, they resolve through symlinks staged next to the astro root.
  - **When `REVKIT_CONSUMER_ROOT` is UNSET, every branch is byte-for-byte the pre-#57 value.** The
    revkit own-repo build is unchanged, verified by the smoke test's `bun run build` producing 32
    pages just as it did before.
- **Sidebar decision (documented here per issue #57).** Consumers name their `docs/` tree freely,
  so a hard-coded sidebar shape does not fit. `buildConsumerSidebar` walks the tree at
  astro-config-eval time and emits Starlight sidebar entries. Starlight's own "autogenerate from
  `src/content/docs/` filesystem" mode would work too, but it walks BEFORE the docs collection
  loads, and we're loading through a custom-shaped staging (a real dir with copied docs, not the
  default). Enumerating in the config keeps the sidebar coherent with what the collection loads.
- **`revkit serve` auto-build.** When `--dir` is absent and `<root>/.revkit/dist/` does not exist,
  `serve` runs `revkit build` first. `--no-auto-build` refuses with a clear message instead.
  The daemon's CSP, auth, rail injection are unchanged.
- **Staging + cache layout.** `<consumer>/.revkit/` holds four subtrees:
  - `build/` — writable astro root: per-entry symlinks to packaged site source, per-package symlinks
    into packaged `node_modules/`, and a copy of the consumer's `docs/` under `src/content/docs/`.
  - `dist/` — astro build output.
  - `cache/astro/` and `cache/vite/` — cache dirs redirected via `REVKIT_ASTRO_CACHE_DIR` /
    `REVKIT_VITE_CACHE_DIR` env vars the config reads. Nothing lands in the nix store or the
    packaged site directory.
  - `serve.json`, `daemon.lock`, `local-user`, `asks/` — daemon state (unchanged from M5 part 1).
- **Template smoke asserts real content.** `scripts/template-smoke.sh` runs `revkit check`, then
  `nix build`, then `revkit build`, then `revkit serve --port 0 --no-auto-build`; extracts the
  launch URL, mints a session cookie, GETs `/` and asserts (a) HTTP 200, (b) the rendered doc
  text is in the body ("welcome"), (c) the rail's `<script src="/-/rail.js">` tag is injected.
  The daemon is killed on exit via a trap. CI runs it through the existing
  `.github/workflows/revkit-flake.yml` template-smoke job.
- **Nix package changes.** `nix/revkit-package.nix` now ships the whole `site/` (astro.config.mjs,
  tsconfig.json, scripts/, src/) — not only `site/src/` — so the packaged CLI has a working astro
  project root to stage from. The `node_modules/.bin/` directory is symlinked in (shell glob would
  otherwise skip the hidden entry), which is where `astro` lives after `bun install --linker=hoisted`.
- **Symlink layout quirks and their fixes.**
  1. `NODE_PRESERVE_SYMLINKS=1` is set on the astro child so Node's `require.resolve` keeps
     paths on the staging tree rather than resolving into `/nix/store/…`. Paired with
     `vite.resolve.preserveSymlinks: true` in consumer mode so vite reports the SAME paths.
     Without both, astro's `normalizeFilename` corrupts an out-of-root `/nix/store/…` module id
     by prepending `<staging>/` — a subtle bug that surfaces as ENOENT deep inside vite's
     virtual-module cache.
  2. Solid's `include` glob gains `**/node_modules/@revkit/components/**` so Callout / Aside /
     … are transformed under `preserveSymlinks: true`, where the trusted `packages/components`
     copy is only reachable through the staging path.
  3. `@astrojs/mdx` is added explicitly to the integrations list in consumer mode. Starlight
     auto-adds it in its own `astro:config:setup`, but in the packaged flow the pushed
     integration sometimes registers `.mdx` too late for the FIRST content-sync pass, leaving
     the docs collection empty. An explicit entry participates from the first pass.

### 5.2 Nothing changed for the review path (PR #48)

`packages/cli/src/review/build.ts` still owns `runSafeBuild` for the `revkit review` sandbox: the same
wrapper-config approach, the same trusted checkout path, the same seven rules from PR #48's file header.
It now delegates the actual spawn to `spawnAstroBuild` so the env allowlist and denylist live in one
place; the wrapper's own concerns (vite cache dir inside the sandbox, the `astro.config.revkit-review.mjs`
wrapper file, the sandbox HOME/vite-cache tempdirs) are unchanged. Every review-path test still passes.

### 5.3 Open items for M5 part 3 (or later)

- Move revkit's own site dogfood from `bun run build` in `site/` to `revkit build --dir .` at the
  repo root. Would exercise the packaged path against a maximally-complex consumer (revkit itself)
  every CI run, sharpening the "own build unchanged" assertion into a "own build is the packaged
  build" one. Deferred because it would touch every dev workflow at once.
- Move the sidebar autogenerate rule to a config option (`revkit.sidebar = "autogenerate" | "flat"
  | { ... }`) so a consumer can override the default without dropping into astro config. Nothing
  demands it yet.
- Pin down the `@astrojs/mdx` late-registration issue upstream — either a bug in
  `runHookConfigSetup`'s loop or a Starlight `splice` timing quirk. Working around it is cheap;
  fixing it upstream removes a config-file line.

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
