# ADR-0023: Co-editing with a CRDT (deferred)

- Status: Proposed
- Date: 2026-09-29
- Stories: A7
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)

## Context

Story A7 (co-editing the source beside the rendered view) needs concurrent editing by a human and the agent.

## Decision

- Deferred to **M7**. Working direction: CodeMirror 6 + Yjs (`y-codemirror.next`), a daemon-owned Y.Doc per file,
  agent disk writes ingested as Y.Text operations. To be decided when M7 starts.

## Consequences

Will amend ADR-0006 when accepted.
