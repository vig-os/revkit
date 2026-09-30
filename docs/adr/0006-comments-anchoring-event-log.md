# ADR-0006: Comments: dual anchors, revision re-anchoring, append-only log

- Status: Accepted
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

## Acceptance (2026-09-29)

- Fuzzy re-anchoring uses **diff-match-patch** `match_main` with a context-weighted score; below the threshold the
  comment is orphaned, never guessed.
- The revision id is the **SHA-256 of the source normalised to LF line endings**.
- Local threads (`bun:sqlite`) export/import to D1 with the same schema (`revkit threads export|import`), so a local
  review can be published to a hosted PR.

## Amendment (2026-09-30)

The original "diff-map → quote verify → fuzzy → orphan" description let implementers reach for a whole-file fuzzy
search, which produces false positives on templated content (a deleted bullet lands on its neighbour). The
re-anchoring engine (`packages/review-core/src/reanchor.ts`, M2 item 5a) implements the same intent under a stricter
frame:

- **The diff decides where; similarity only decides whether.** A character-level `diff_main(oldLF, newLF)` (with
  `diff_cleanupSemantic` and `Diff_Timeout` bounded) is the ONLY search. The anchor's old span is classified as
  **unchanged**, **modified** or **deleted** against the diff.
- **Unchanged spans** map through `diff_xIndex` and are accepted as `quote-exact` when the mapped text equals the
  quote AND the character-class of the new boundaries matches the old (line boundary vs mid-line) — the boundary
  check catches the substring-accident where the exact quote appears embedded in a longer inserted sentence.
- **Modified spans** are located by `diff_xIndex` inside the enclosing changed-hunk window (± a small slack) and
  aligned with a walker that folds the replacement INSERT into the DELETE. The similarity of the OLD quote to the
  aligned new text must clear a moderate gate; a span whose EQUAL preservation is under half is demoted to the
  deleted path (a templated-row shift, not an in-place edit).
- **Deleted spans** try move detection: **exact** `prefix + exact + suffix` in the new source AND in the old source
  with substantial context on each side (non-whitespace count OR a line boundary). Exactly one occurrence in BOTH
  the old and the new source anchors as `quote-exact` (moved); zero, several, or an old snapshot that already had
  the pattern twice (copy-pasted blocks) **orphan**. There is no fuzzy or bare-quote-copy fallback — a lone match of
  the bare quote in a different context is refused, and a paragraph moved WITHOUT its surrounding context orphans
  (the safe choice: we cannot prove which copy the anchor was on if two identical blocks lived side by side).
  Orphaning beats a wrong place.

The event kinds `thread.reanchored` and `thread.orphaned` carry these outcomes; the wire methods are `quote-exact`
(unchanged / moved) and `fuzzy` (modified). Fuzzy carries the similarity score.

## Amendment (PR-43 round-5): the `unanchored` anchor kind

An imported thread whose source content cannot be fetched (blob deleted / binary / truncated / diffHunk verification
failed) is a real case the model must represent honestly. The round-4 approach — a placeholder line anchor with a
`revisionOf("<sentinel>\n...")` value — was a proper-state violation: the placeholder revision matched no file, so
the re-anchor engine's identity short-circuit could freeze the thread at wrong lines forever.

Round-5 replaces the placeholder with a **new anchor kind: `unanchored`**. Schema (`packages/review-core/src/anchor.ts`):

```ts
{ kind: "unanchored", path, originalStartLine?, originalEndLine? }
```

- **No `revision`, no `quote`.** The two fields the re-anchor engine reads are absent — the engine skips unanchored
  threads entirely. The rail renders the thread under the path, without a quote.
- **`originalStartLine` / `originalEndLine` are diagnostic only** — the coordinates GitHub recorded at comment time.
  They do not semantically map to any revision.
- **The reducer parks the thread in `orphaned` from birth** when `comment.created.anchor.kind === "unanchored"`.
  The validator refuses subsequent `thread.orphaned` (already orphaned) and `thread.resolved` (not open). This
  turns the "we don't know where this belongs" state into first-class state, not a sentinel string.
- **Origin metadata rides on a structured field**: `comment.created.external` and `thread.orphaned.external` carry
  `{ provider: "github", threadId, resolved: boolean, resolvedByLogin? }`. Downstream (B4 two-way sync — ADR-0025
  amendment) reads these to reconcile local orphan status with remote resolved status without regex-parsing
  reason strings.

The existing line-anchor schema is unchanged — line anchors have no `kind` field on the wire. `anyAnchorSchema` is
the discriminated union used by `comment.created.anchor` and `Thread.anchor`.
