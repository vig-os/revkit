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
  `release/X.Y.Z`, so the commit every `X.Y.Z-rcN` candidate and the final tag point at carries `X.Y.Z`. The script
  stamps three kinds of target, and only these: the top-level `version` of `packages/cli/package.json` (parsed, so a
  nested `version` key is never touched); the Worker's `REVKIT_VERSION` var in `packages/worker/wrangler.jsonc` (the
  `/_revkit/<version>/` asset path segment — stamped rather than derived at deploy time because the committed value is
  what the Worker tests and `wrangler deploy` read, and `worker-config.test.ts` fails if it drifts from the manifest);
  and the `github:vig-os/revkit?ref=X.Y.Z` pins in the template flake, the template README, the README and the
  SKILL.md install snippet. A test fails on any other semver string literal in package sources.
- **Candidates vs finals:** the devkit train computes `-rcN` at publish time and tags the unchanged release-branch tip
  with a read-only extension seam, so no commit can carry `-rcN`. A candidate therefore reports the base `X.Y.Z`; a
  final reports exactly `X.Y.Z`. Every build also embeds its source revision (the flake's `self.shortRev`, or
  `git rev-parse --short HEAD` in a checkout) and prints `X.Y.Z (<rev>)`, so a candidate is identifiable by tag or rev.
  Stamping `-rcN` itself needs a devkit change (a pre-tag write seam); tracked upstream.
- **Template pin:** the release tree pins its own final version, so every candidate and the final tag carry
  `?ref=X.Y.Z`, a tag that exists once the final is promoted. `promote-release.yml` deletes `-rcN` tags that have no
  GitHub Release, so a pin to a candidate tag would dangle in the final tree; pinning the final avoids that. On `dev`
  the pin is the upcoming `0.1.0`. Before that final exists, `nix flake init -t` and the pin cannot resolve: pin a
  candidate tag or a full commit SHA explicitly (`github:vig-os/revkit/<sha>`). After each final, a follow-up `chore`
  PR on `dev` bumps the pin to the next upcoming version. Candidates must be cut as GitHub pre-releases so
  `promote-release.yml` does not delete their tags. A test fails if the template floats on a branch or pins anything but
  a final `X.Y.Z`. `docs/DOWNSTREAM_RELEASE.md` is devkit-managed, so this note lives here rather than there.
