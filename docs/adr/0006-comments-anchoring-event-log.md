# ADR-0006: Comments: dual anchors, revision re-anchoring, append-only log

- Status: Accepted
- Date: 2026-09-29
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)
- Stories: A2, A6, A7, A8, B2, B4
- Amended by: the 2026-10-04 (issue #9) amendment below — the hosted physical
  schema carries a hosted-only `log_key`, and there is no `revkit threads
  export|import` CLI command; the 2026-10-05 (issue #73) amendment — an
  `import` lands only in an empty store, judged against the log the store holds;
  the 2026-10-05 (issue #113) amendment — quote provenance (the SOURCE is the
  authority) and the typography fold the engine compares through; and the
  2026-10-05 (issue #67) amendment at the end of this file — the lazy trigger
  fires for a read that can RETURN AN ANCHOR, so the rail's ids-only prune fetch
  no longer pays for a sweep it cannot observe, and one sweep reads the log once
  rather than once per path, re-reading per path whenever the log moved while
  the sweep ran.

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

## Amendment (2026-09-30, M2 item 5b — daemon integration)

Wiring the re-anchoring engine (M2 item 5a) into the live daemon (`revkit serve`):

- **Revision snapshots.** The daemon's sqlite store carries a `snapshots(revision, source, bytes, created_at)` table
  keyed on the revision hash. When a thread is created, the daemon stores the LF-normalised source under the same
  revision the anchor carries. Content-addressed dedup: a second thread on the same file at the same revision is an
  idempotent `INSERT OR IGNORE`. Additive migration: an existing pre-5b db opens cleanly (no `snapshots` table → the
  schema-up creates it empty). The 5 MiB anchor-source cap (`resolveAnchorSource`) already gates what lands here.
- **Actor for pipeline events.** `thread.reanchored` and `thread.orphaned` events emitted by the daemon carry actor
  `{ kind: "agent", id: "revkit-reanchor" }` — a namespaced id under the existing `agent` kind so no schema bump is
  needed. A channel client can filter these system events from human posts and from the user's own Claude Code
  session (`id: "agent"` or a per-session id).
- **Triggers, layered.** The daemon runs THREE complementary triggers, each of which is correct on its own. Together
  they close every gap:
  1. **Lazy — before `/api/threads` GET and before `/events` catch-up.** Guaranteed correct: even if watchers miss
     an event or the site was edited while the daemon was down, the next read re-anchors before serving. This is
     the ONE trigger that alone makes the pipeline correct; the others exist for interactive latency.
  2. **File watcher on anchored source files** (`fs.watch` with a `stat`-poll fallback on WSL / FUSE / bind mounts).
     Debounced at 300 ms so a save-burst coalesces. Per-path watcher installed lazily when the first thread on that
     path lands; torn down when no threads remain.
  3. **Build watcher on `site/dist`** (`fs.watch` recursive). Debounced at 500 ms so an Astro build settles before
     the daemon reads back. Triggers a `refreshAll()` — every threaded path.
- **Per-path mutex.** `refresh(path)` serialises through a `Map<string, Promise<void>>`. A second concurrent call
  joins the in-flight promise; different paths run concurrently. `prepareReanchor` runs ONCE per (oldRev, newRev)
  pair even when N threads on the same file re-anchor together.
- **Bounded.** A file over the 5 MiB cap, a symlink escape, or a missing file orphans every thread on that path
  with a uniform reason ("source file unavailable at re-anchor time…"). A missing snapshot for a thread's
  revision orphans the thread ("no snapshot for the anchor's revision…"). The pipeline never hangs and never
  guesses.
- **Rail integration.** The rail shows re-anchored threads live at their new position (SSE fires on
  `thread.reanchored`, the rail refetches, the `data-src` lookup on the block finds the new line range).
  Orphaned threads move into a dedicated **Orphan panel** with the original quote, a "was at L…" note, and the
  pipeline's reason; orphans stay repliable and resolvable. A subsequent `thread.reanchored` on the same thread
  unorphans it back to `open` (reducer rule).
- **Channel notice.** The MCP channel server surfaces re-anchor and orphan events as short, escaped notifications
  to the agent — enough for the agent to update its own state or explain the transition to the human. The
  existing tag-forgery escape (`escapeContentFragment`) applies to every field before it lands in `content`.

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

## Amendment (2026-10-03, issue #49): watcher re-arm, and the orphan-check memo

Trigger 2 above ("**File watcher on anchored source files** … `fs.watch` with a `stat`-poll fallback") is the
mechanism this amendment pins down. Two corrections, both from #49.

**1. A rebound directory is re-armed onto `fs.watch` once it is observably stable — where the runtime allows it.**
The previous rule was blunt: after any rebind the daemon installed the `stat`-poll and the directory stayed on 2 s
polling for the rest of its life. That was correct, but a rebound directory could never go back to `fs.watch`, so it
paid the poll's 2 s worst-case detection latency indefinitely.

**The re-arm is gated on runtime behaviour, and the gate is narrow.** `DirectoryWatcher.everWatched` records whether
a `fs.watch` registration ever succeeded on that canonical path; the rebind probe re-arms **only** when it is false.
So the re-arm fires for exactly two shapes:

- the directory did not exist when the watcher was installed (so nothing was ever registered on that path), and
- `watch()` threw before registering.

**The common rename-swap and `rm -rf` shapes are NOT in that set.** A directory whose inode has been replaced has
necessarily carried a registration, so `everWatched` is true and it keeps the `stat`-poll. The 2 s worst-case
detection latency therefore remains in place for those directories; #49 narrowed the gap, it did not close it.

**Why the gate exists, and what it is not.** The re-arm was withheld from swap-damaged paths because on
`bun 1.3.13` a re-armed `fs.watch` on such a path receives **zero events**. That is a bug in **Bun's `fs.watch`
implementation**, not a property of the kernel, of inotify, or of Node — established by re-running one identical
probe script under three layers on the same kernel (`6.8.0-31-generic`), the same filesystem and the same directory
shape:

| layer | re-arm after `renameSync(dir, …)` + `mkdirSync(dir)` |
|---|---|
| raw `inotify_add_watch` via `ctypes`, bypassing every runtime wrapper | **signals** — allocates a NEW `wd` |
| `node v24.21.0` `fs.watch` | **signals** |
| `bun 1.3.13` `fs.watch` | **silent** |

Under `bun 1.3.13` the re-arm is also silent via the `dir + "/."` spelling, after `rm -rf` + `mkdir`, and after a
re-arm that is immediately followed by an atomic rename-save; a recursive watch on an ancestor never sees the
recreated directory's writes. The same five shapes all **signal** under `node v24.21.0`. A control fresh watch
signals under both. The claim is therefore **version-specific to Bun 1.3.13** and must be re-measured, not
re-inherited, on any Bun bump.

**What to do about it.** Report and track the Bun defect upstream, and cross-check this behaviour under Node before
concluding anything about a watcher's viability on a given machine. It is explicitly **not** a reason to introduce a
native inotify binding: inotify is demonstrably healthy, so a binding would add a dependency to route around a bug
in one runtime. `node`'s `fs.watch` also does not show Bun's one-re-arm-per-path-spelling limit (a never-watched
symlink path re-armed across three consecutive swaps signals under Node, but only on the first under Bun), which is
further evidence that the ceiling is Bun's rather than the platform's.

**"Stable" is derived from observable state, not slept.** A rebound directory is stable when `dirStableIntervals`
consecutive probe ticks (`DEFAULT_DIR_STABLE_INTERVALS` = 3, on the existing `dirRebindIntervalMs` cadence) each find:
no rebind performed, no watch error, and an unchanged `(dev, ino)`. Any of those resets the count to zero, as does
every re-arm attempt. The count advances on the periodic probe only — `reconcileWatchers` runs the same routine, and
letting a `POST /api/threads` advance it would make "N intervals" mean "N events". No new timer and no new sleep
constant is introduced. `poll: true` (the `--poll` escape hatch for WSL / FUSE / bind mounts) is never re-armed: the
caller asked for the poll.

**Polling remains the fallback, and the switchover is quiet.** The poll carries the directory until the re-arm lands,
and is torn down only once a watcher is *actually* live — a failed re-arm degrades to the previous behaviour, never
to a blind directory, so the debounce-vs-poll race is not reintroduced. Because the poll was live right up to the
swap, the poll→watch handover uses the poll's own `(mtime, size)` snapshot as its baseline and fires only the paths
that actually moved, instead of the blind all-paths fan-out a fresh install needs (round-4 blocker G(b)). A watcher
merely holding still therefore reads no files at all — the re-arm is not a rebuild trigger.

**The gate is deliberately conservative, and that is its safe failure mode.** If a future Bun recovers, the daemon
keeps the `stat`-poll on those directories: correct but 2 s slower, never blind. Relaxing the gate is then a
deliberate act, gated on the runtime probe in
`packages/cli/test/serve/watcher-rearm.test.ts` ("platform fact") re-reporting that a re-armed Bun watch signals —
that probe is the signal to re-measure, not the daemon.

**2. The orphan-check memo is pruned on `thread.reanchored`.** `orphanCheckRevision` memoises "this thread was
already checked against revision R while orphaned" so a repeat refresh at the same revision can skip the pipeline.
When a thread was un-orphaned the entry was left behind: inert, because the state-derived skip reads
`anchor.revision` for an `open` thread, but stale until the next `reconcileWatchers`. It is now deleted the moment
that thread's own `thread.reanchored` append lands. The prune is keyed on **that thread's** explicit re-anchor and is
never a sweep, so a thread that is still orphaned always keeps the entry its skip test reads — including a sibling
thread on the *same* file that the same `refresh` pass leaves orphaned. It fires only on a *successful* append,
since a rejected event leaves the thread orphaned and still in need of its memo.

## Amendment (2026-10-04, issue #9, M4 slice 5) — the hosted log is keyed by review, and there is no `revkit threads export|import`

**This supersedes one clause of the Decision above, and corrects an over-claim in
its own wording.** The clause is left standing as written because an accepted
decision is a record, not a variable; what changed is the scope of the contract,
and the correction is stated here rather than by editing the line.

### 1. "with the same schema" → **the INTERFACE is the contract; the hosted schema adds one hosted-only column**

The Decision says local threads "export/import to D1 with the same schema". Since
slice 5 that is **false of the physical schema**, and the true statement is
narrower and more useful:

- **`ThreadStore` is unchanged.** `append` / `import` / `since` / `threads` /
  `thread` / `asks` / `ask`, exactly as before. It remains the contract the
  bridge crosses, and it remains ADR-0025's "one core, three surfaces" —
  **this amendment does not weaken that**, it names what "one core" means: one
  *interface*, three *backings*.
- **All three backings still pass the shared 19-case conformance suite** in
  `packages/review-core/test/store-conformance.ts` — `InMemoryThreadStore` (the
  reference), `SqliteThreadStore` (the daemon's `bun:sqlite`) and
  `D1ThreadStore` (the hosted D1). A5 (`seq` starts at 1), A6 (`since`), A7
  (`threads()` ordering), A8, A9, A12 and A14 are unchanged requirements.
- **The hosted table gained a key the other two do not have.** ADR-0008 puts one
  Worker and one D1 per org and an org has many `(repo, PR)` reviews, so the
  hosted log holds one log **per review**, keyed
  `review_logs(log_key, seq, ts, payload)` with `PRIMARY KEY (log_key, seq)`.
  `log_key` is `previewScopePath(repo, pr)` — ADR-0008's own `/<repo>/pr-<n>`
  spelling — and `D1ThreadStore` takes it as a **required** option, with no
  default. `seq` is therefore per review, which is what `ThreadStore` has always
  meant by a fresh store's head.
- **Why that is not a divergence of the log format.** An archive carries `seq`,
  `ts` and the event; it does not and cannot carry "which review", because
  `ThreadArchive` is the log, and on the hosted surface a deployment holds many.
  `D1ThreadStore.import` writes the archive into **its own** log, so importing a
  local review publishes it to the target review and to no other.
- **Migration:** `migrations/0003_scoped_logs.sql`. Pre-existing rows, which
  name no review, are **quarantined** into `events_unscoped_legacy` — kept,
  unreachable, and given no scope — and the flat `events` table is emptied
  rather than dropped.

### 2. `revkit threads export|import` is not a command

The clause names `revkit threads export|import` in backticks, which reads as a
CLI command. **There is no such command.** What exists is the library API —
`exportArchive(store)` in review-core and `ThreadStore.import` — which is what
`D1ThreadStore` implements and what the conformance suite exercises.

So the clause over-claims in two directions at once: the schema half (above) and
the interface half. The corrected claim is: *a local review's log can be
exported with `exportArchive` and imported by a hosted `ThreadStore` — the
library API, not a CLI verb — so a local review can be published to a hosted PR.
No user-facing command is claimed, and none should be inferred from this ADR
until one ships and this line is amended again.*

## Amendment (2026-10-05, issue #73): an import lands only in an empty store

**`ThreadStore.import` accepts an archive only in a store whose log is empty.**
`parseArchive` plays every archive through `validateNext` from an *empty* state,
and the store's dry run refuses an archive whose ids collide with its own, so
after those two checks an archive can only be a self-contained log — nothing in
it can be shown to continue the store's existing log, and a foreign log's tail
arriving at `head + 1` used to be accepted silently and then handed to
`since(lastSeen)` callers as this log's next event. Until the local↔hosted
bridge designs the deep comparison that would settle it (#35), a store holding a
log refuses every archive (`divergent-archive`, or `seq-gap` when the archive
starts above `head + 1`); an empty store still accepts any archive, which is the
one shape `exportArchive` — the only producer — emits.

**Both of those sentences are about the log the STORE holds, and that is a
commitment each backing has to earn** — "its own" is not the instance's
in-memory state. `bun:sqlite` rehydrates head and validator state in `open`;
`D1ThreadStore` holds neither at construction and `src/index.ts` builds a fresh
store per request, so until #107's fix it compared every archive against an
empty state — the guard could not fire and a colliding archive committed. A
backing that judges an archive against anything other than the stored log
breaks this amendment, so the property is asserted per backing: on the two
whose log outlives the instance — `bun:sqlite` and D1 — through a second store
instance over the same storage (`StoreFactory.reopen`), and on the in-memory
reference, whose log IS its instance, by the single-instance cases (a second
handle there would be a new empty store, which is the honest answer and not a
refusal to test). `import` is also a read-then-write, so its commit is guarded
against a writer that moves the head in between: one guard row inside the same
`batch()`, gating every archive row, so a stale head writes nothing rather than
something. Refs: #73, #107, #108

## Amendment (2026-10-05, issue #113): quote provenance, and the typography fold

The Decision above says a comment stores "the source range, a text-quote selector
and the revision". It did not say **whose** text the selector holds, and the
implementation let the browser answer: the rail built `anchor.quote` from
`block.textContent` and the daemon stored it verbatim. That is not the source.

Astro's markdown pipeline runs `remark-smartypants` by default
(`@astrojs/internal-helpers/dist/markdown.js`: `smartypants: true`) and
`site/src/lib/markdown-processor.ts` never disables it, so a rendered block's
text is not its source text: `"` renders `“ ”`, `'` renders `‘ ’`, `--` renders
`—`, `...` renders `…`, and an inline-code span's rendered value carries no
backticks. Measured over this repo's own `docs/**`, 3263 of 7533 rendered blocks
outside code fences (43.3 %) differ from the source at their own offset. Every
comment created that way held a quote the engine could never match, so it
orphaned on the first edit of the file — which, for a live doc under a watcher,
is routine rather than exceptional.

### 1. The SOURCE is the authority for the quote

**`anchor.quote` is a slice of the source file. A client's own quote text is
never stored.** The daemon already reads the anchored source to compute the
revision (the PR #38 override); it now reads it to compute the quote too, and
overrides any client value, for the same reason: a client value that disagrees
with the file silently breaks the pipeline. `POST /api/threads` takes an
optional `selectionHint` — the rendered text the reviewer selected — and uses it
to decide **which source span** to quote, never **what** to quote: the hint is
matched (folded, below) against the source slice, and the bytes stored are the
source's. A hint that matches nothing, or matches more than once, widens the
quote to the whole anchored line range; a wrong span is worse than a wide one.

The wire stays compatible in both directions. `anchor.quote` is **accepted and
ignored** on create (an already-deployed rail bundle still posts one) and
**optional** (`anchorRequestSchema`; a stored `Anchor` still requires a quote,
because the engine reads it). One fallback remains, and it is deliberate: if the
anchor's line range resolves to no source text at all — the ordinary shape of a
stale build, since `data-src` stamps come from the BUILT output — the client's
quote is kept rather than refusing the reviewer's comment with a 400. That
anchor is an honest dead end that orphans on the first rebuild. Whenever the
source has text for the range, the derived quote wins.

**This also fixes the inline-code variant for free.** A `<code>` node's
`position.start.offset` points at the *opening* backtick, so slicing source at
that offset yields `` `w `` against a rendered `w`, and the short values scored
below the similarity gate. No offset nudge is introduced anywhere: the producer
never uses a node offset, and the fold maps a rendered `gh` onto the source span
that carries it, so the stored span and the comparison are both source text.

### 2. The engine compares through ONE typographic fold

The log is append-only, so the quotes the defect already wrote are still in it.
They re-anchor instead of orphaning, and they converge: a legacy rendered quote
that re-anchors is rebuilt with the **new source text**, so the next comparison
is like-for-like and the comment does not orphan on the rebuild after that.

Every comparison of a recorded quote against source text goes through one shared
helper (`packages/review-core/src/typography.ts`), applied **symmetrically** —
both sides folded — and every search folds the haystack and the needle and maps
the hit back to a source offset through `FoldedSource.starts` / `.ends`. The four
sites are `locateOldSpan` (the old span, which is where the defect surfaced
first, as "old anchor span not found in snapshot"), path 4a's
`mapped === quote.exact`, `tryMove`'s exact-context search, and path 4b's
similarity gate.

**The table is the substitutions the renderer performs**, measured against
`createMarkdownProcessor` rather than assumed: `“ ” „ → "`, `‘ ’ → '`,
`— → --`, `– → -`, `… → ...`, `` ` `` → *deleted*. `---` is deliberately absent —
the pipeline leaves a three-dash run alone, so folding it would invent an
equivalence the renderer does not have. The backtick entry deletes rather than
substitutes because an inline-code span's rendered text node carries no
delimiter; deleting on both sides is what makes the source `` `gh` `` and the
rendered `gh` fold to the same string.

The table is a *superset* of the renderer's own substitutions in one place and a
*subset* in another, both measured rather than assumed, and both tracked in
#127: a dot run of **four or more** also collapses to a single `…`, which
`… → ...` does not reverse, so a legacy quote on such a line still orphans at
`locateOldSpan`; and three entries (the backtick, `–`, `„`) are not
renders-identical, which the paragraph below quantifies. The table is unchanged
by that review — the remedy there is a narrower table, and narrowing it is #127's
decision, not this amendment's.

**What the equivalence class is, and is not.** It is "text that renders
identically", which is the right granularity for this purpose: the quote
identifies *which text a comment is about*, and text that renders the same
identifies the same thing. It is also one equivalence class narrower than
byte-equality and no wider than the renderer: a per-character substitution with
no cross-character context cannot normalise a rewrite away, so a span that
differs in a WORD is still a different span, still fails path 4a, and still takes
the modified path's similarity gate (`packages/cli/test/serve/
quote-provenance.test.ts` proves this through the real pipeline, and
`packages/review-core/test/typography.test.ts` pins it at the unit level).

**Measured consequence, stated precisely.** Take a source edit that swaps `--`
for a literal `—`: the two render identically, so it is *inside* the class. It
is still **reported as a change**, and the report is the honest one — measured
result `method=fuzzy`, carrying the new source text. The mechanism is worth
naming because it is not the fold's equality test: the diff runs on RAW source,
so the edit classifies as `modified`, path 4a is never reached, and what the
fold buys is only that 4b's similarity gate does not charge for the
punctuation. What the class would suppress is 4a's byte comparison on an
`unchanged`-classified span — and a raw-source diff cannot classify a
`--`→`—` edit as unchanged, because the bytes did change. So the practical
exposure is the class's effect on 4b's SCORE, never on 4a's verdict.

Three entries in the table are *not* renders-identical, and the review of this
change measured their consequences rather than assuming them: the backtick entry
(adding or removing inline code leaves the words alone and changes the styling —
reported `fuzzy` carrying the new text, but in one direction a legacy quote can
be accepted as `quote-exact`), `–` → `-` (a spaced hyphen is left alone, so a
spaced en dash and a spaced hyphen render *differently* and the fold is wider
than the renderer there), and `„` → `"`. Those are tracked in #127 together
with the residual under-fold: any dot run of four or more also collapses to a
single `…`, so `… → ...` reverses only the three-dot case.

**Smartypants stays on.** Turning it off would also have made the strings equal,
but it changes rendered output for every document in the repo —
`packages/cli/test/serve/publish-equivalence.test.ts` pins the smartypants
behaviour deliberately — so it is a visible product change, out of scope here.

### 3. A comment is created from the anchored block, or not at all

*(Added by the round-2 review of the change above, issue #113, PR #124. The
decision in §1 — the source is the authority — was not sufficient on its own: a
builder that has to produce a quote from whatever it is handed will invent one
when the source does not contain what was asked for, and an invented quote is
worse than no quote.)*

`buildQuoteForComment` used to be **total**. It clamped a line range past EOF to
the file's end, and a `selectionHint` that matched nothing in the range widened
the quote to the whole range. Both produce a quote, and both produce the wrong
one:

- Line numbers reach the daemon from the `data-src` stamps in the **BUILT** page,
  so the ordinary cause of a range past EOF is a **stale build** — the file
  shrank after the page was built. Clamping then stored the file's LAST paragraph
  as the quote for lines that do not exist. Measured: a 19-line source with no
  trailing newline, an anchor of L40-41, and the stored quote is line 19's
  paragraph. After an unrelated edit the engine does not report the mismatch — it
  reports `moved`, re-anchoring confidently onto that paragraph. `moved` is a
  success, so the rail shows a live anchor button pointing at text the reviewer
  never read. The pre-#113 code reported `orphaned`, which is honest, visible and
  recoverable. The clamp traded one for the other.
- A `selectionHint` is the reviewer's **rendered** selection. If it matches
  nothing in the anchored range, the page is not describing the file the daemon
  just read — the same stale-build signal. Widening stored a paragraph the
  reviewer did not select.

**Decision.** The comment-create path refuses, and says which of three things
was true: `range-past-eof`, `empty-range` (the range exists and is empty — the
empty last line a trailing newline creates, a different fact with a different
message), or `hint-not-found`. The refusal is a `400`, and the client's own
`anchor.quote` is **never** substituted for it — that fallback is removed, not
narrowed. It was unreachable for the current rail, which sends no quote, so a
stale anchor produced a 400 complaining about a missing quote the client was
never asked to send; for a legacy client it stored RENDERED text, which is the
provenance violation §1 forbids and which `anchorRequestSchema`'s own note already
ruled out ("The daemon ignores its contents"); and it fired only on an empty
slice, so on a source without a trailing newline the same stale build stored
different wrong text depending on the file's last byte.

**Why a 400 and not "store it, orphan it".** The rail's `submitNewThread`
catches the failure, shows the message and leaves the composer OPEN with the
reviewer's text in it, so a refusal costs one reload — and a reload is exactly the
fix, because the stale thing is the page's `data-src` stamps. Storing the comment
instead is unrecoverable: an anchor built from a range that does not exist can
never resolve, and the reviewer is never told why. A refusal is recoverable and
names its cause; a stored comment with an invented anchor is neither.

**One rule survives the narrowing.** A hint that matches MORE THAN ONCE still
widens to the whole block. That is not the same failure: we know which block the
reviewer commented on and cannot tell which of two identical spans they picked,
so the anchor is coarser than their selection but every byte of it is source text
they addressed. The line between the two cases is exactly whether the stored text
comes from inside the block the reviewer commented on.

**The matcher had to learn the soft break to make this safe.** Turning "matched
nothing" into a refusal is only correct if a hint that *legitimately* matches
still does. A markdown soft break is a newline in the source and a collapsed
space in the rendered page, so selecting across one sends a hint the source does
not contain — routinely, and it would have become a 400. The quote builder
therefore searches a `foldSourceLoose` form (the typographic fold plus every
whitespace run collapsed to one space), the needle-side counterpart being
`foldTypographyLoose`. The re-anchoring engine is untouched by this: its
comparisons stay byte-exact, which is why `foldSource` and `foldSourceLoose` are
separate functions over one scanner rather than one function with a flag on the
engine's hot path.

**`buildQuoteFromLines` keeps clamping, deliberately.** Its other caller reads its
line range from a diff hunk it matched itself (`github-adapter.ts`), where a small
overrun should degrade to the nearest text rather than fail. Two callers with
different standing, two contracts, one shared line geometry — a single clamped
implementation is the bug this section is about.

### 4. The orphan reason no longer lies

Path 4a's refusal used one sentence for two different failures: *"diff reports
unchanged, but the block's surroundings differ (substring accident) and no move
detected."* Issue #113 recorded that sentence on a case where the text had not
changed and nothing was a substring accident — the browser had merely reported
typographic punctuation — which sent the reader hunting for a collision that did
not exist. The reason now distinguishes them: a boundary-class mismatch is a real
substring accident and says so; a mapped position whose text differs from the
quote *beyond* the fold is a diff that aligned a span whose content had changed,
and says that, carrying `tryMove`'s reason when there was one.

## Amendment (2026-10-05, issue #67): the lazy trigger is a read that can return an anchor

*(This section is self-contained on purpose: it amends trigger 1 of the "Triggers,
layered" list above and changes nothing else. PR #106 also amends this ADR; the
two sections are independent blocks and both are kept verbatim.)*

Trigger 1 above — "**Lazy — before `/api/threads` GET and before `/events`
catch-up** … even if watchers miss an event or the site was edited while the daemon
was down, the next read re-anchors before serving" — is written as though every
`GET /api/threads` were the same read. It is not, and the difference was measurable
at the review surface's own scale.

**The measurement.** A rail mount issues, per page: the path-scoped reads
`fetchThreads` renders from, ONE unscoped read for the seen-mark prune pass
(`fetchAllThreadIds` — seen-marks must survive for threads on *other* pages, issue
#60), and an `/events` subscription whose server-side prime re-anchors before the
first frame. The rail fetches threads TWICE per mount: once on mount and once from
the refetch `onAttached()` fires when the stream opens. So an unscoped read did not
run once per mount — on a page whose thread read is itself unscoped it ran four
times. Measured end to end against a real `startDaemon` (sqlite `:memory:`, one
thread seeded per file, the whole mount's requests issued in the rail's own order
and concurrency), stamped page, 7 warm samples, medians:

| measurement (median of 7 warm samples) | 40 threaded paths | 400 threaded paths |
|---|---|---|
| whole mount, client wall clock | 27 ms → **7 ms** | 1482 ms → **31 ms** |
| whole mount, daemon-side `durationMs` summed over its own requests | 17 ms → **5 ms** | 1486 ms → **28 ms** |
| file reads the mount caused | 82 → **42** | 802 → **402** |

**Two changes, one guarantee.**

1. **The trigger follows the response projection.** `GET /api/threads?fields=id`
   returns `{ threads: [{ id }], head }` and **does not re-anchor**, because a body
   with no anchor in it cannot hand a reader a stale one. Nothing else about the
   read changed: same store, same `status` filter, same envelope. An unrecognised
   `fields` value is a 400 rather than a silent full read, and so is a REPEATED
   one — `searchParams.get` is first-wins, so `?fields=id&fields=anchor` would
   otherwise answer ids-only and skip the trigger while silently discarding the
   second spelling. A refusal is answered before the trigger, so it costs nothing.
2. **One sweep reads the log once — and re-reads per path whenever the log moved.**
   `refreshAll` already read the whole log (`store.threads()`, no filter) to collect
   the path set; each `doRefresh` then asked for its own path again, and
   `store.threads(filter)` is `since(0)` plus a full reduce — so a sweep over P paths
   cost **O(P × events)**, which measured as 17.7 ms of a 21.6 ms sweep at P = 40
   against 1.8 ms of file reads. `refreshAll` now groups the one read it already
   pays for by `anchor.path` and hands each path its bucket, **stamped with the
   `store.head()` it was taken at**.

**The head stamp is what keeps this an optimisation and not a weakening.** A bucket
is the tracked set as of the sweep's own read, so a thread that BECOMES tracked
while the sweep runs — a `thread.reopened`, a new comment, a sibling resolving — is
invisible to it, and `POST /api/threads/:id/reopen` fires no refresh, so nothing
else would cover it. Before the grouping, each `doRefresh` asked the store at its
OWN time and saw the write. `doRefresh` therefore accepts a bucket only while
`known.head === store.head()`, and re-queries otherwise: one integer compare on the
hot path (a quiescent log), the original per-path query on the slow path (the log
moved). `head` is read BEFORE the read it stamps, so a write landing mid-read makes
the stamp too low and fails the comparison — the safe direction. The coalesced RERUN
(when a second caller arrives mid-run) carries the same bucket for the same reason;
dropping it made every overlapping pair of sweeps fall back to the per-path query
for every path, a measured 741 ms fan-out against 13 ms at P = 400.

**What is NOT weakened.** Trigger 1's guarantee is unchanged for every read that can
return an anchor. A path-scoped `GET /api/threads`, an unscoped one, the `/events`
prime and the WebSocket prime all still re-anchor **every threaded path** before
serving — the `/events` prime in particular is *not* gated by the projection, because
it is the trigger that catches a file edited while the daemon was down, and nothing
about its response shape says whether the subscriber will read an anchor. The sweep
is still a full sweep over every threaded path, and its thread MEMBERSHIP is as
fresh as the per-path query it replaces: identical when the log is quiescent, and
re-read from the store the moment it is not.

**What IS new, stated plainly.** A caller can now ask for ids and receive ids whose
anchors are behind disk, and will not be told. That is the trade the parameter names
out loud: `fields=id` is a promise that you are not reading anchors. A caller that
wants fresh anchors asks without it. And a page carrying no `[data-src]` block falls
back to an unscoped `fetchThreads`, which is anchor-consuming and therefore still
sweeps — twice, with the prime — so such a mount keeps three of its four sweeps. The
projection removes the prune fetch's sweep, not that one.

Refs: #67
