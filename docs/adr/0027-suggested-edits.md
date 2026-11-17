# ADR-0027: Suggested edits as reviewable change sets

- Status: Proposed
- Date: 2026-11-17
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)
- Stories: A6, B2, B6
- Complements: [ADR-0006](0006-comments-anchoring-event-log.md) (append-only log, dual anchors, re-anchoring),
  [ADR-0007](0007-agent-bridge-mcp-channel.md) (delivery modes), [ADR-0011](0011-mentions-typed-sigils.md) (typed actors),
  [ADR-0013](0013-local-daemon-security.md) (loopback-only; CSP; path confinement), [ADR-0025](0025-hybrid-review-one-core.md) (one core, local and hosted PR surfaces)
- Relates to (does not replace): [ADR-0023](0023-co-editing-crdt.md) (deferred co-editing) — A6 ships without the
  CRDT, keystroke-level co-editing stays with ADR-0023

## Context

Story A6 (DESIGN-0001 §5.5) asks for suggested edits on rendered text that land in the source. The surfaces where
this matters, in order:

- A **PI reviewing a Typst manuscript** rendered to static HTML and served through `revkit serve --dir`. Blocks
  carry `data-src="<path>:<start>-<end>"` (ADR-0006); every rendered block maps to a source span. The reviewer's
  words for the need: *"rich text edit on top … changing small parts that are change tracked, like edit/strike/delete
  … but more like per 'commit' rather than per line & word mess of changes like in classical editors"*. A paragraph
  of three small fixes is **one** change the author accepts or rejects, not three.
- An **agent editing the source** at the same time, whose edits the reviewer wants to review as change sets of the
  same shape — not as line-by-line diff noise.
- **PR review** (ADR-0025 surfaces b and c), where the GitHub ``````suggestion ``` block already exists but is
  single-hunk-single-file and runs against the rendered view of a PR, not the source model.

Prior art on the editing side:

- **GitHub** has `` ```suggestion `` on review comments and, since 2021, **"Add suggestion to batch → Commit suggestions"**
  that commits a reviewer's accepted suggestions as **one** commit. One commit per batch is the smallest unit the
  author accepts in one click.
- **Ink & Switch / Automerge "Patchwork" and the earlier "Upwelling"** group a reviewer's edits into a named draft
  (an "edit group") that the author reviews and merges as a unit. The grouping is the primitive, not the keystroke.
- **Google Docs "Suggesting"**, **Word "Track Changes"** with the **Simple Markup** view, and **CKEditor 5
  Suggestions** (adjacent same-author edits merge into one suggestion) all track changes on the **rendered model**,
  which is where "per-word mess" comes from: there is no coarser grain to project onto, because the rendered model
  is what the editor owns.
- **Overleaf** tracks the editor, not the `.tex`, so suggestions survive only while the authoring tool is the
  editor; neither revkit's PI reviewer nor an agent is that editor.

**The observation this ADR rests on.** revkit renders from a **structured source** (Typst, MDX, Markdown; images;
math) and keeps a source span on every rendered block (ADR-0006). The projects above track changes on a rendered
view **because they have to**. revkit does not: a reviewer's edits can be tracked on the **source** that the block
maps to, so the primitive can be "one change over one or more source hunks" instead of "one word-level diff over a
rendered paragraph".

Nothing in this ADR implements this; it fixes the shape so A6 (M6) can start.

## Decision

### 1. The unit of change is a *suggestion*

A **suggestion** is a reviewable, append-only change set. One suggestion = one commit's worth of edits,
accepted or rejected as a unit. Shape:

```ts
interface Suggestion {
  readonly id: string;                  // stable
  readonly title: string;               // human-written, becomes the commit title on apply
  readonly author: Actor;               // ADR-0011 typed actor: local / gh-user / guest / agent
  readonly base: { readonly [path: string]: string };  // per-file base SHA-256 (ADR-0006's LF-normalised revision)
  readonly hunks: ReadonlyArray<Hunk>;
  readonly threadId?: string;           // optional comment thread it belongs to
  readonly state: "draft" | "open" | "accepted" | "rejected" | "applied" | "conflicted" | "superseded";
}

interface Hunk {
  readonly path: string;                // workspace-relative, confined to the workspace root (ADR-0013)
  readonly baseRange: { start: number; end: number };  // byte offsets on the base revision
  readonly baseText: string;            // the exact pre-image, verified before apply
  readonly newText: string;             // the post-image
  readonly quote: string;               // rendered text selection, for display / search (ADR-0006 selector)
}
```

**New event family** on the append-only log (ADR-0006, same reducer, same ordering, same actor rules):

- `suggestion.proposed` — the first hunk lands; state goes `draft → open` when the author submits.
- `suggestion.updated` — the author adds or edits a hunk in the open suggestion (before accept/reject).
- `suggestion.accepted` / `suggestion.rejected` — one terminal decision, **no partial accept in v1**.
- `suggestion.applied` — apply succeeded; carries the new file revisions and, when a commit was made, the SHA.
- `suggestion.conflicted` — apply refused because a file moved off its recorded base; carries the diff and a
  three-way merge (OURS = base, THEIRS = current, MINE = suggested).
- `suggestion.superseded` — the suggestion's base files moved and the suggestion's author withdrew it rather than
  rebase. The reducer rule from ADR-0025's #155 amendment applies: the current state is a derivation over the log,
  and a decision authorizes a change only while the derivation still names that change.

These are **local** events. The GitHub mirror lives in the PR mode below.

**Drafting.** An open thread accumulates hunks into the reviewer's current open suggestion the way a pending review
accumulates comments (ADR-0025 surface b). The "Submit review" button in the rail becomes "Submit review and open
suggestions"; a reviewer who has drafted hunks but no comment submits the suggestion alone.

### 2. The editing surface is picked per block, not per surface

A block's source span maps to one of two kinds:

- **Prose blocks.** A source span whose rendered text is in **word-for-word correspondence** with the source text of
  the span — no macros, no math, no citations, no nested components that materially change layout or glyphs between
  source and render. The rule is **renderer-agnostic**: compute the word-level diff between the rendered text of the
  span and the source text of the span; the span is prose iff that diff is empty after whitespace normalisation (one
  space, trim). Typst paragraphs, MDX plain prose, markdown paragraphs, list items without inline macros — prose.
  A paragraph that contains `` `code` ``, `@citation`, `#link`, `$math$` or a `<Component …/>` — **not** prose: the
  rendered text and the source text disagree.
- **Everything else.** Headings with anchors, math, tables, code blocks, components with children, Typst macro calls,
  MDX JSX — the mapped source span is **markup**.

**Editing surface:**

- **Prose → inline contenteditable overlay.** The rendered paragraph becomes editable in place. On submit, the
  word-level diff of the rendered text (ADR-0006 diff pipeline, same character-level `diff_main` over the LF source,
  plus a word-level derivation using `jsdiff` `diffWordsWithSpace` and the semantic-cleanup from
  `@sanity/diff-match-patch`) is **mapped back onto the source span** — the span is in word-for-word correspondence,
  so the mapping is exact. One hunk per contiguous word run; no macro argument is ever patched.
- **Markup → mini source editor.** A `@codemirror/merge` two-pane editor on the mapped source span opens in the rail
  with the span's current text on the left and the reviewer's draft on the right. Submit produces one hunk per
  contiguous changed region of the span. The source stays the primitive; the renderer is not asked to lie about
  macros, citations or math.

**Never silently.** No path writes to a macro argument, a citation, a math expression or a component attribute
through the prose surface. A reviewer who wants to change `@cite{foo}` to `@cite{bar}` opens the markup editor. The
`revkit check` (ADR-0005) pass over a suggestion on apply refuses any hunk that landed inside a non-prose region of
the source span.

### 3. Display

Per block:

- **Prose** — inline word-level ins/del, both sides, with the hunk's author shown.
- **Markup** — a collapsed source-diff chip; expand for the full two-pane view.
- **Simple-markup toggle** (Word's name; "Suggesting view" in Docs) — a margin stripe on the block, hover reveals.
- **Rail card per suggestion** — title, author, hunk count, per-hunk Accept / Reject (routed through the single
  terminal accept/reject below), **jump between hunks** on the rendered page, and the three CTA options: Accept,
  Reject, Reply. Keyboard parity (ADR-0017): a suggestion card has the same keyboard model as a thread card; the
  tab order within a card is `Accept → Reject → Reply → Jump to hunk N`.

### 4. Applying a suggestion

Accept is one atomic operation:

1. **Base check.** For every file the suggestion touches, re-read the current file and compute its LF-normalised
   SHA-256 (ADR-0006 revision rule). If every file still matches its recorded base, go to step 3.
2. **Three-way apply.** Otherwise, run a three-way diff for each file (base → current, base → suggested) and attempt
   a merge. Clean merges produce a new post-image; a conflict in any file marks the whole suggestion
   `conflicted` — no partial apply across files.
3. **Atomic write.** Each new file is written **temp-file-then-rename** inside the daemon's workspace root, with
   path confinement (ADR-0013: no `..`, no symlink escape; the same `resolveAnchorSource` guard; every path is
   resolved against the realpath of the workspace root). The write is **the daemon's** — see §5 below for why
   this ADR changes nothing about ADR-0013's trust boundary.
4. **Optional commit.** When the workspace is a git repository, the apply optionally creates **one commit** with
   the suggestion title, author = the **reviewer who accepted** (not the suggestion's own author, because a
   commit's author is the one applying), body = the suggestion's threaded conversation if any. Whether a commit
   is made is a per-start flag on `revkit serve`; the default is **no commit** (the reviewer's working tree gets
   the change and they commit through their usual tool).
5. **Re-anchor.** The apply bumps the touched paths' revisions; the ADR-0006 pipeline re-anchors every other
   thread on those paths exactly as it does on any other source change (lazy at the next read, watcher-driven in
   between, bounded, per-path mutex). The suggestion's own thread stays anchored because the hunk's new coordinates
   are known from the apply.

**Conflicted state.** `suggestion.conflicted` is a terminal state the reviewer unblocks by **rebasing**: a
"Rebase on current source" action opens the suggestion's hunks on the new base in the markup editor; submit
produces a `suggestion.updated` on the newly-rebased hunks and the suggestion goes back to `open`. No fuzzy or
partial auto-rebase. A suggestion whose base is five edits behind is one the reviewer can rewrite — orphaning here
is a wrong-place result, like ADR-0006's.

### 5. Who writes — and what this means for ADR-0013

**ADR-0013 does not currently write workspace files from the daemon.** The daemon writes `.revkit/` state (sqlite,
asks, snapshots, serve.json), and nothing else; `revkit serve` is a read-and-serve for everything under the
workspace root. Accepting a suggestion writes a non-`.revkit` file.

Three candidates:

- **(a)** The daemon writes the file directly, under the cookie session that accepted the suggestion.
- **(b)** The daemon emits `suggestion.accepted` and a separate CLI command (`revkit suggestion apply <id>`) does
  the write.
- **(c)** The agent reads the `suggestion.accepted` event through the ADR-0007 channel and writes the file.

**Decision: (a), with a narrow amendment to ADR-0013.** The daemon applies. Reasoning:

- The reviewer accepted *from the page*. The write that follows is the act the reviewer asked for: shifting it to a
  CLI (b) breaks the flow and makes it easy to forget, and routing it through the agent (c) makes a reviewer's
  accept wait on an agent round-trip that may not be live. ADR-0025's local surface B6 established the same
  principle for lifecycle changes: the reviewer's session is load-bearing and routes write.
- The agent is not a safer writer than the daemon. Any safety the daemon loses by writing, the agent would already
  have — and (c) adds a second write path where this ADR exists to specify one.
- ADR-0013's amendment: the daemon may write workspace files **only** inside a `suggestion.apply` operation whose
  caller is a **cookie session** (local or VPN-mode; `trusted-proxy` or `site-token` under the hosted target apply
  differently — see the PR mode below), where every target path resolves inside the workspace root through the
  same guard as `resolveAnchorSource`, and where a `revkit check` pass over the pending post-image refuses the apply
  before the rename. The agent bearer gets `403 agent-forbidden` on `POST /api/suggestions/:id/accept`, exactly as
  it does on every other state-changing route (ADR-0025 #70 amendment). This is a **narrowing**: the daemon writes
  nothing else outside `.revkit/`, and what it does write is a reviewer act, not an agent one.

**Size caps.** A hunk's `baseText` and `newText` are each capped at 1 MiB (the existing 5 MiB anchor cap applies to
the whole file, not the hunk; the smaller cap here is what fits in one review decision). A suggestion is capped at
64 hunks and 16 touched paths. Over the cap, `revkit suggest` (CLI / MCP) refuses with a typed error; the UI
surfaces the limit, it is not a silent truncation.

### 6. Agent parity — the inverse workflow

Agents propose suggestions instead of writing directly. Two routes:

- **MCP tool `suggest`** (ADR-0007). The agent calls `suggest({ title, hunks, threadId? })` with hunks in the same
  shape above; the daemon returns `{ suggestion, url }`. Delivery modes (ADR-0007) apply: in `handover` a batch
  containing an agent-authored suggestion delivers as one envelope; in `quiet`, a pull-only arrival as today.
- **Import a git commit (or a range) as a suggestion.** `POST /api/suggestions/import-commit` (cookie-only;
  bearer forbidden) takes `{ ref, title? }` and turns each file in the commit's tree-diff into one hunk, base =
  the commit's **first-parent** revision, author = the local actor who called it. For a range `a..b`, each commit
  becomes **one suggestion**: one commit from the agent = one reviewable change set, exactly as a human reviewer
  reads it. Imported suggestions carry a `provenance: { kind: "git-commit", sha }` member so the UI shows `imported
  from <SHA>`, and the apply skips re-writing the file when the working tree already matches the suggestion's
  post-image (an idempotent import under a merge).

**Reciprocal:** the agent sees the reviewer's suggestions through the channel (ADR-0007 content framing applies,
`escapeContentFragment` on every field) and can `accept` or `reject` **locally as a draft**, but the reaching-GitHub
or workspace-write act stays a **reviewer promotion** under ADR-0025's #70 rule — an agent's accept on a human's
suggestion is a draft the reviewer promotes, never a silent apply. This preserves ADR-0025's property that a
reviewer's session is load-bearing for writes.

### 7. PR mode (ADR-0025 surface c)

Mapping a suggestion to GitHub:

- **Single-hunk, single-file, prose** → one review comment carrying one ``````suggestion ``` block. The reviewer
  can commit it with one click on GitHub.
- **Multi-hunk single-file, prose only** → GitHub "Add suggestion to batch", one commit per batch. revkit groups the
  suggestion's hunks into a single batch on the PR.
- **Multi-file, or any markup hunk, OR a mapping back onto the source whose rendered text and source text disagree**
  → the reviewer picks, at accept time, one of two fallbacks:
  1. **One commit on the PR head**, authored by the reviewer (the ADR-0025 `gh` `TokenSource` on the local surface,
     or the GitHub App on the hosted surface), when the reviewer has push rights to the head branch.
  2. **A series of ``````suggestion ``` blocks**, one per hunk, posted as individual review comments on the
     changed lines. This is the fallback when push rights are absent (a fork PR); revkit emits the series and
     records `suggestion.accepted → suggestion.applied` under the "series" subtype.
- **The block rule above is a reviewer-visible choice.** The rail card shows which path a given suggestion will
  take **before accept** (pretty-printed badges: "GitHub suggestion × N" / "Commit on PR head" / "Series of N
  suggestion blocks"), so the reviewer sees the mapping without accepting first. The default is whichever is the
  cheaper native path; the reviewer can override (e.g. force a series over a commit, for a fork PR they do not
  trust yet).

**Head moves** behave as ADR-0025 states for pending reviews: a suggestion pinned to `base` is re-anchored on
`commit_id` moves through the ADR-0006 pipeline; a hunk whose base no longer resolves flips to `conflicted` and
the rail says so.

### 8. Security, accessibility, i18n, licenses

- **CSP (ADR-0012, ADR-0013).** The contenteditable overlay and the markup editor island are loaded from the same
  `/-/rail.js` bundle that already carries every other rail component (one revkit-owned path, one hash
  allowlist — ADR-0013's `dist-check-allowlist.json`). No inline script, no `eval`, no `new Function`.
  `@codemirror/merge` is a Solid-island lazy-loaded chunk (ADR-0002) and is subject to the same test that already
  refuses `eval(` and `Function(` in the built rail JS.
- **Patch text is untrusted input.** `baseText`, `newText`, `quote`, `title` are HTML-escaped (`<` → `&lt;` …) and
  whitespace-collapsed for channel delivery (ADR-0007 content framing). The rail renders them through the same
  escaper, not through `innerHTML`.
- **Size caps.** See §5. The caps are enforced at the write — a channel notification that references a hunk over
  the cap carries a `truncated` marker, not a silent cut.
- **Accessibility (ADR-0017).** Every action has a keyboard path: open a suggestion from the rail, move between
  hunks, accept, reject, reply, enter and leave the contenteditable overlay, submit the markup editor. Focus stays
  trapped inside the two-pane editor while it is open and returns to the rail card on close. The axe gate (ADR-0017)
  applies.
- **i18n (ADR-0019).** English v1; strings follow the same ICU catalog shape as the rest of the rail.
- **Licenses (ADR-0022).** `diff` (`jsdiff`, BSD-3-Clause), `@sanity/diff-match-patch` (Apache-2.0),
  `@codemirror/merge` (MIT). All compatible with ADR-0022; `NOTICE` extended on the implementation PR.

### 9. Out of scope

- **Keystroke-level co-editing** — ADR-0023 / M7. A6 is per-suggestion, not per-keystroke, by design.
- **Block moves** (dragging a paragraph across sections). A suggestion is always a hunk pair on one path at a time;
  a move is two hunks (delete + insert) the reviewer composes by hand.
- **Rendered previews of pending suggestions** (what GitHub shows as "show the diff rendered"). Optional later —
  can land as a build hook that re-renders the touched file against the suggestion's post-image; out of M6.
- **Comments on images** — ADR-0006 amendment #254; orthogonal to this ADR. An image "suggestion" is not in scope.

## Alternatives considered

- **Track changes on a rendered ProseMirror / Tiptap model** (the CKEditor / Docs / Word shape). Rejected: it tracks
  on the view, so it reinherits the "per-word mess" the reviewer explicitly rejected, and the apply back to source
  reduces to the same prose-span mapping this ADR already does — plus a second editor model to maintain.
- **Per-keystroke tracking via a CRDT snapshot (Yjs snapshots)**. Rejected for v1: it is ADR-0023 (M7) and a strictly
  larger problem. A CRDT also makes "one commit per edit group" harder, not easier (Patchwork's lesson), because the
  CRDT is designed to merge, not to keep an edit group as a reviewable unit.
- **Overleaf-style per-keystroke tracking on the file**. Rejected: it binds track-changes to the authoring tool.
  revkit's reviewer is not the author; the agent is, and the reviewer is a late reader.
- **GitHub-only ``````suggestion ``` blocks** (no local model). Rejected: the local surface (A6) exists outside
  GitHub, and the reviewer's "per-commit" need is a grouping GitHub's primitive does not express until the batch
  step. The batch step is also GitHub-only; revkit needs the primitive in the core.
- **The agent writes, the reviewer approves after the fact** (agent-first). Rejected as the default: when the
  reviewer *drafts* the change, routing the write through the agent is a round-trip that needs the agent to be live;
  the daemon-write path makes a reviewer-authored suggestion land without any agent involvement, and the agent-side
  `suggest` MCP tool gives the other direction. Both exist.

## Consequences

- `@revkit/review-core` gains the `suggestion.*` event family, a `Suggestion` reducer alongside the thread reducer,
  a `SuggestionStore` contract (same three implementations as ADR-0025 slice 1: in-memory, SQLite via
  `bun:sqlite`, D1), and the 3-way apply engine. The engine runs unchanged in Bun (daemon) and in a Worker
  (hosted PR mode) — no `node:*` imports, plain `fetch` for the GitHub side.
- **Feature matrix** A6 cites ADR-0027 (status `planned` / "ADR-0027 proposed"); DESIGN-0001 §5.5 points at the ADR.
- **ADR-0006** is not amended by this ADR, but its `thread` log and its re-anchor pipeline are reused. If the
  reducer shape forces a formal amendment at implementation time (for example, if the thread-link on a suggestion
  must live on `thread.*` events to make the derivation idempotent), the implementation issue opens that amendment
  with specifics.
- **ADR-0013 is amended narrowly** (§5 above): the daemon writes workspace files only inside a `suggestion.apply`
  under a cookie session, with path confinement, revision check and `revkit check` pre-flight. The agent bearer
  gets `403 agent-forbidden`. Loopback-only remains the default; the `trusted-proxy` and `site-token` targets
  under ADR-0026 get the write when their session is a cookie session — the same gate.
- **ADR-0023 is not replaced.** Co-editing stays A7 / M7. Suggestion-apply uses atomic file writes, not shared
  CRDT ops; a later ADR-0023 acceptance adds a merge path where a `suggestion.applied` can write into a live
  Y.Doc, but that is a Y.Doc change, not a change to this ADR.
- **The milestone (M6) is deliverable by itself**: no block is new infrastructure. The hard parts are the
  prose-detection rule (§2) and the apply-under-concurrent-edit path (§4); both have tests the implementation
  issues name.

## Acceptance

Owner-approved 2026-11-17 (channel: PI review of `emim2027-si-update` manuscript on `revkit serve --dir`; need
quoted verbatim in §Context). Implementation lands under M6 (DESIGN-0001 §8), split into the issues listed on the
tracking issue #11.
