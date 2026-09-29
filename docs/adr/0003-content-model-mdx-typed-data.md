# ADR-0003: Content model: MDX prose plus typed data files

- Status: Accepted
- Date: 2026-09-29
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)
- Stories: B2, B6, C2, C3

## Context

A pure JSON/nested-JSON doc model was considered. PR review (B2, B6) needs comments to land on reviewable source lines.

## Decision

Prose is **MDX**, with frontmatter validated by Zod content-collection schemas. Everything that *is* data (vocabulary,
plot specs and data, question specs, threads) is JSON/YAML.

## Consequences

MDX lines are the anchor unit for comments and PR mapping (ADR-0006). GitHub's own diff view stays useful.

## Acceptance (2026-09-29)

- Every JSON/YAML data file revkit reads or writes (threads, asks, vocabulary, question specs) carries a
  `schemaVersion`; a breaking schema change is a MAJOR release (ADR-0021).
