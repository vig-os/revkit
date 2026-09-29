# ADR-0021: Versioning and release

- Status: Accepted
- Date: 2026-09-29
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)

## Context

revkit ships a flake, a CLI, guards and a content schema that other repos depend on.

## Decision

- **SemVer**, released through the scaffolded **devkit release train** (`dev` → `release/X.Y.Z` → `main`, tag, GitHub
  Release).
- **MAJOR** = a guard-rule change that can fail previously valid content, or a content/data-schema break; MINOR =
  features; PATCH = fixes.
- Consumers pin the flake to a tag (ADR-0010).

## Consequences

Stories: D1.
