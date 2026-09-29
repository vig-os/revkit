# ADR-0006: Comments: dual anchors, revision re-anchoring, append-only log

- Status: Proposed
- Date: 2026-09-29
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)
- Stories: A2, A6, A7, A8, B2, B4

## Context

Comments must survive edits and rebuilds (A8), map to PR lines (B2) and never be lost.

## Decision

Each rendered block carries `data-src` (file + line range). A comment stores the source range, a text-quote selector
and the revision (content hash) it was made on. Re-anchoring on change goes: diff-map the range, verify the quote,
fuzzy-search the quote, else **orphaned** (kept, never dropped). Threads are an append-only, server-ordered log
(`bun:sqlite` locally, D1 hosted); the comment UI is an island outside the rebuilt content. No CRDT in v1; IndexedDB
only for unsent drafts.

## Consequences

Suggested edits (A6) extend comments with patches. Co-editing (A7) will need a superseding CRDT ADR (Yjs + CodeMirror
6).
