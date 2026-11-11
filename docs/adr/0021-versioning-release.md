# ADR-0021: Versioning and release

- Status: Accepted
- Date: 2026-09-29
- Stories: D1
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)

## Context

revkit ships a flake, a CLI, guards and a content schema that other repos depend on.

## Decision

- **SemVer**, released through the scaffolded **devkit release train** (`dev` → `release/X.Y.Z` → `main`, tag, GitHub
  Release).
- **MAJOR** = a guard-rule change that can fail previously valid content, or a content/data-schema break; MINOR =
  features; PATCH = fixes.
- Consumers pin the flake to a tag (ADR-0010), or to an exact commit SHA. The scaffolded template pins the latest tag
  and bumps it with each release; it never floats on `dev`.

## Consequences

See Decision.

## Amendment (2026-11-11, #201) — one version source, stamped by the train

- **Single source:** `packages/cli/package.json` `version`. `revkit --version` (`packages/cli/src/version.ts`) and the
  flake package `version` (`nix/revkit-package.nix`) both read it; no second literal exists (a test fails if one
  appears).
- **Writer:** the consumer-owned `prepare-release-extension.yml` seam runs `scripts/set-release-version.mjs X.Y.Z` on
  `release/X.Y.Z`, so the commit every `X.Y.Z-rcN` candidate and the final tag point at carries `X.Y.Z`.
- **Candidates vs finals:** the devkit train computes `-rcN` at publish time and tags the unchanged release-branch tip
  with a read-only extension seam, so no commit can carry `-rcN`. A candidate therefore reports the base `X.Y.Z`; a
  final reports exactly `X.Y.Z`. Every build also embeds its source revision (the flake's `self.shortRev`, or
  `git rev-parse --short HEAD` in a checkout) and prints `X.Y.Z (<rev>)`, so a candidate is identifiable by tag or rev.
  Stamping `-rcN` itself needs a devkit change (a pre-tag write seam); tracked upstream.
- **Template bump procedure:** after a release is published, a follow-up `chore` PR sets `?ref=` in
  `templates/default/flake.nix` (and the README/SKILL.md examples) to the new tag. A test fails if the template floats on
  a branch. `docs/DOWNSTREAM_RELEASE.md` is devkit-managed, so this note lives here rather than there.
