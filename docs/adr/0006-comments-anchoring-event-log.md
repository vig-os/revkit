# ADR-0006: Comments: dual anchors, revision re-anchoring, append-only log

- Status: Accepted
- Date: 2026-09-29
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)
- Stories: A2, A6, A7, A8, B2, B4
- Amended by: the 2026-10-04 (issue #9) amendment below — the hosted physical
  schema carries a hosted-only `log_key`, and there is no `revkit threads
  export|import` CLI command; and the 2026-10-05 (issue #87) amendment — on
  Bun, trigger 3's `dist` build signal is a `stat`-poll rather than a
  recursive `fs.watch`, because that watch leaks one descriptor per file in
  the build output.

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

## Amendment (2026-10-05, issue #87): the `dist` build watcher is a `stat`-poll on Bun

Trigger 3 above ("**Build watcher on `site/dist`** (`fs.watch` recursive)") is the mechanism this amendment pins
down. The layering it belongs to is unchanged and is restated here because that is the part that matters: trigger 1
(the lazy `refresh` before every `/api/threads` read) remains the only trigger that is correct on its own, and
nothing below makes it conditional. What changes is which mechanism carries trigger 3, on which runtime.

**1. On a runtime whose `fs.watch` does not release its descriptors, trigger 3 is a `stat`-poll of the `dist` tree
instead of a recursive watch.** Measured on `bun 1.3.13` (Linux 6.8, ext4), `close()` on a
`watch(dir, {recursive: true})` handle leaks one real `open(2)` descriptor for every path the watch's recursive walk
opened before the close landed — and it is **not** `anon_inode:inotify`, whose descriptor *is* released; a live
watcher holds exactly two descriptors (inotify + the directory). Because the count scales with the watched tree, a
single build watch over a build output costs one descriptor per output file: measured 3 / 13 / 103 / 403 / 1003
descriptors per close for a `dist/{index.html, _astro/}` fixture carrying 0 / 10 / 100 / 400 / 1000 files under
`_astro/`, paid again on every re-install after `rm -rf dist && just build`. Those are measured **through
`startDaemon`/`stop`**, the context this claim is about; a bare `watch()`+`close()` loop never gets its walk past
the watched directory's immediate entries and measures a flat 3.00 per close at every one of those N, so the
harness is named here rather than left to the reader. `node v24.21.0` leaks 0 over the
identical loop, so this is Bun's `fs.watch`, not inotify and not the kernel.

The poll preserves the property the layering above depends on — **one settled burst is ONE `refreshAll`, whatever
its length** — but it gets there differently from the watcher, and the difference is load-bearing rather than
incidental. A watcher emits an event per write, so its settle timer is pushed out continuously through a build and
fires once. The poll *samples*: a build that outlasts one `buildPollIntervalMs` is several observations, and a
settle window shorter than the sample interval cannot coalesce two of them. So the settle is armed only once a
sample matches the previous one — i.e. once the tree has been **stable for a full poll interval** — and any new
difference clears a pending settle so a build still running cannot fire a stale pass. `rm -rf dist && just build`,
which the watcher served by erroring out and re-arming its probe, is served instead by the tree snapshot emptying
and refilling: the empty and the refilled snapshot are ONE unsettled period, so the re-arm probe is not needed on
this path at all.

*(An earlier revision of this amendment claimed the debounce contract was "unchanged" and that "nothing downstream
can tell the difference". That was false, and measurement refuted it: restarting the settle on every observed
change turned one 4 s build into 5 `refreshAll` passes, 3/3 runs, where `fs.watch` gives 1. The wording above is
the corrected contract; `test/serve/reanchor-daemon.test.ts` pins both the multi-tick build and the `rm -rf` shape
at exactly one pass, and the poll's confirming interval is what buys it.)*

**The cost, stated rather than absorbed.** From the last write, `refreshAll` runs after up to
`DEFAULT_BUILD_POLL_INTERVAL_MS` to observe the change, plus one more interval to confirm stability, plus
`buildDebounceMs` — **2.5 s at the defaults**, against the 500 ms the `fs.watch` debounce gave. That extra interval
is the price of the single pass. The walk itself is one `readdir`+`stat` of `dist/` per tick and it is
**synchronous**, so it is an event-loop stall rather than background CPU: measured on this host at 0.07 ms / 52
entries, 1.11 ms / 805 and 11.4 ms / 6 409 (median of 25), and over a 10 001-entry `dist` median 19.1 ms, p90
22.1 ms, max 30.0 ms. It also allocates O(entries) per tick — ~2 MiB, i.e. ~120 MiB/min of short-lived garbage at
1 Hz on a 10 001-entry tree. Finally, the snapshot key is `mtimeMs:size`, so a rewrite that preserves **both** is
invisible to the next sample where a kernel watch would fire: measured 11 of 200 back-to-back same-size rewrites
on ext4. Sub-second build-signal latency and that blind spot are what is given up; neither is load-bearing, because
trigger 1 remains the correctness backstop. On `node` the recursive `fs.watch` is kept, because there it is correct
and free.

**2. Trigger 2 is deliberately NOT changed, and the cost of that is recorded.** The per-directory file watchers keep
`fs.watch` on every runtime, so they still leak `1 + <immediate entries in that directory>` per directory per daemon
and again on every re-arm (230 descriptors across a full suite run, against 738 from the build watches). Switching
them to the poll on Bun would move the mechanism the #49 amendment's re-arm contract is asserted through
(`dirWatchMode()`, which distinguishes only `"watch"` from `"poll"`), i.e. it would move pinned tests rather than add
coverage. That is a behaviour change and belongs in its own change; it is tracked in #103. #87 therefore leaves a
known, bounded, documented leak rather than an unmeasured one.
