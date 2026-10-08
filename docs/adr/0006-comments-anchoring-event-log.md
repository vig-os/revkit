# ADR-0006: Comments: dual anchors, revision re-anchoring, append-only log

- Status: Accepted
- Date: 2026-09-29
- Design: [DESIGN-0001](../designs/DESIGN-0001-revkit-architecture.md)
- Stories: A2, A6, A7, A8, B2, B4
- Amended by: the 2026-10-04 (issue #9) amendment below — the hosted physical
  schema carries a hosted-only `log_key`, and there is no `revkit threads
  export|import` CLI command; and the 2026-10-05 (issue #73) amendment — an
  `import` lands only in an empty store, judged against the log the store holds;
  and the 2026-10-05 (issue #70) amendment below — `draft.promoted`, the one
  reviewer act that lets an agent-authored draft reach the pending review.
  Also amended by the 2026-10-05 (issue #67) amendment below: the lazy trigger
  fires for a read that can RETURN AN ANCHOR, so the rail's ids-only prune
  fetch no longer pays for a sweep it cannot observe; and one sweep reads the
  log once rather than once per path, re-reading per path whenever the log
  moved while the sweep ran.

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

## Amendment (2026-10-05, issue #67): the lazy trigger is a read that can return an anchor

*(This section is self-contained on purpose: it amends trigger 1 of the "Triggers,
layered" list above and changes nothing else. PR #106 also amends this ADR; the
sections are independent blocks and each is kept verbatim, in issue order — the
issue #70 `draft.promoted` amendment follows this one and is likewise
self-contained.)*

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

## Amendment (2026-10-05, issue #70): `draft.promoted` — a reviewer attaches an agent's draft

**The gap.** An agent reply, resolve or reopen against a thread in an in-flight
local PR review reached the reviewer and nothing else: the local log got the
agent's `comment.replied` / `thread.resolved`, and PR #59's mirror paths refuse
any non-`local` actor, so the reviewer's `gh` identity never carried it. B6's
"the agent replies" was true only in the weakest possible reading.

**The decision (option B, owner-decided 2026-10-05).** An agent-authored reply or
resolve/reopen stays a **local draft**, badged as agent-authored. One explicit
reviewer action — **promote** — attaches it to the reviewer's own pending review,
and that action is recorded in this log as a new event kind:

```
{ kind: "draft.promoted", actor: <local>, threadId, target: "comment"|"resolve"|"reopen", commentId? }
```

`commentId` is required iff `target === "comment"` (a resolve/reopen promotion
names the thread). The existing machine intents are unchanged: a promoted comment
becomes an ordinary `comment.sync_requested` under the reviewer — the same event
the reviewer's own comment produces — and a promoted resolve/reopen is the
already-logged `thread.resolved`/`thread.reopened`, which the reconciler now
treats as an intent once a later `draft.promoted` authorizes it. Promotion adds
the *authorization*, not a second kind of intent, so every property the existing
reconciler already has (read-first, fingerprint matching, `comment.linked`
completion, submit gating, crash healing) applies to a promoted draft unchanged.

**Why an event and not a field on the intent.** For a comment, a `promotedBy`
field on `comment.sync_requested` would have carried the same information. For a
**resolve** it cannot: the agent's `thread.resolved` is already in the log and
the validator refuses a second resolve on a resolved thread, so there is no new
event to hang a field on — and without the separate event, half of B6 would have
no record that a human authorized the write at all. One kind, one meaning: *a
reviewer attached this agent-authored draft to their own pending review.*

**The trust argument, enforced in the log.** Every rule below is in
`validateNext`, so each holds for every store backing and every writer rather
than only for the route that checks it first.

1. **Only the reviewer may record a promotion.** `draft.promoted` with any
   non-`local` actor is rejected (`invalid-actor`). The precise property is
   *the agent bearer cannot author a promotion over HTTP*: the bearer is
   refused `403` on the route and its requests are identified as `agent`, so
   every append it could cause is built server-side from an `agent` actor.
   This is **not** a claim that the agent, as a process, has no route to a
   write: a same-user agent that obtains a REVIEWER SESSION via the
   launch-code exchange (`POST /-/launch-code` mints a code, `GET /-/auth`
   exchanges it for the reviewer's cookie) is identified as `local` like any
   cookie and can promote. That escalation is pre-existing on the local
   surface (since PR #38), is a property of the launch-code flow rather than of
   this event, and is owned as a decision on **#55**. It is stated here
   because this amendment is what makes a reviewer's session
   load-bearing.
2. **Only an agent draft may be promoted.** Promoting a comment, or a
   resolve/reopen, an agent did not author is rejected
   (`not-an-agent-draft`) — a reviewer's own comment mirrors without a promotion
   and their own resolve is authorized already, so the log can never claim one
   was promoted.
3. **A lifecycle promotion must name the thread's CURRENT change.** A
   `draft.promoted` with `target: "resolve"` against a thread whose latest
   lifecycle change is a reopen is rejected with the same kind: a superseded
   change has nothing left to write to GitHub, and the reconciler would
   otherwise fire an intent the reviewer has already moved past.
4. **The named ids must be real.** `unknown-thread` / `unknown-comment`, and the
   comment must belong to the thread named (mirroring `comment.replied`'s
   parent check).

The route adds one rule the log cannot see, because it is about the world
outside the log: **promotion requires an OPEN pending review.** After
`review.submitted` or `review.abandoned` there is nothing to promote into, and
the route refuses (`no-open-pending-review`) rather than opening a fresh review
behind the reviewer's back — a discarded review stays discarded until the
reviewer opens a new one deliberately.

**What the pin is, precisely — `bodyHash` holds, `commentSeq` is provenance.**
`bodyHash` is the enforcement: `findDraftToPromote` refuses to promote a comment
whose current body no longer hashes to the recorded value
(`promoted-body-changed`), and refuses to promote *again* on top of a promotion
carrying no pin; the boot heal composes through the same check, so nothing is
repaired into unpinned text. `commentSeq` records WHICH version was approved and is
checked at **append** time only — that it names an authoring event the log actually
issued. It is **not** a currentness guard: `comment.edited` does not advance the
authoring seq, so it is fixed for the life of the log; it is what makes the pin
checkable at append time at all, and it is the provenance of the hash rather than a
second independent lock on the text. The reconciler separately refuses a
`body-drift` retry by comparing the live body against the **intent's** `bodyHash`
(the intent is composed from the pinned text, so both must agree).

**A refusal writes nothing.** Every check above, plus the ones the route makes
about the world (`no-github-thread`, `stale-lifecycle-draft`,
`promote-mapping-orphan`), is decided **before the first append**. This is
load-bearing rather than tidiness: `draft.promoted` is what retires a draft
from `agentDrafts`, so a refusal raised *after* it left the log claiming an
authorization that never happened, retired the draft the rail's affordance is
built from, and made the comment permanently unreachable — the reviewer was
shown a badge, a button, and then nothing, with no route left that could
produce the intent. A refused promotion is a no-op on the log.

**Idempotency is a property of the log, not of the route.** A promotion already
in the log is not appended twice; the route recognises it and re-runs the
read-first reconcile to finish the interrupted one, answering `200` with
`promoted: false` instead of `201`. So a double promote, a promote retried after
a crash between the event and its reconcile, and a restart all converge on one
GitHub write.

The crash window is **between** the promotion and the machine intent, and it is
recoverable in both directions: the promotion alone authorizes nothing (the
reconciler needs the intent too), and a retry recognises the recorded promotion,
skips appending a second one, and still appends the missing intent. Boot stays
read-only: an unpromoted draft produces no intent, so nothing about it can be
written on restart.

**The promotion PINS the content it approves.** A `draft.promoted` for a comment
carries `commentSeq` (the `seq` of the `comment.created` / `comment.replied` that
authored the draft) and `bodyHash` (`revisionOf(body)` at promotion time). Without
them the event names a comment id and leaves *which text* open, so a later edit of
that comment could swap the body between the reviewer's approval and the
reconciler's write: the intent would fingerprint the NEW text while the promotion
recorded the human act on the OLD. With the pin, a comment whose current body no
longer hashes to the recorded `bodyHash` is **refused**
(`promoted-body-changed`) rather than promoted, and the reviewer is told the text
changed and to re-read it.

`validateNext` also checks that `commentSeq` is the seq of the authoring event the
log actually issued (`unknown-comment` otherwise), so the pin cannot name a version
that does not exist. Both fields are **optional at the wire** — a log written before
they existed must still validate, since `validateNext` is a state machine over
appends and a stricter rule than the log's own history is a boot failure. A
promotion carrying neither pin is the old, weaker shape, and `findDraftToPromote`
refuses to promote *again* on top of one (`promoted-body-changed`: the current text
cannot be shown to be the approved text). The route always writes the pin.

**The heal never composes what the route would refuse.** In particular it applies
the same open-pending-review rule. Without it, a promotion left incomplete by a
submit (or a discard, or a head-move reanchor's abandon — none of which go through
the promote route) would be repaired into an intent that the next
cookie-authenticated reconcile posts into a **fresh** pending review: reopening,
automatically and after the fact, a review the reviewer had already closed. The
route refuses that with `no-open-pending-review`, so a repair that composed it
anyway would be the one path that publishes into a closed review.

**A dropped reviewer intent is visible, not silent.** The supersession rule below
applies to the reviewer's own change, so their click can be superseded by a later
lifecycle event before the reconciler fires it. Refusing to fire it is correct;
leaving the reviewer to believe it posted is not. `reduceReviewState` therefore also
derives `droppedReviewerIntents`: a `local` resolve/reopen that carries **no**
completing `thread.external_synced` and is **not** the thread's current change. A
change that is current and merely unsatisfied is not reported — it is in flight, and
reporting it would be a false alarm on every pending sync. The rail shows the list
as a notice (not an alert: nothing is broken, and no decision is needed) naming the
thread and which of the two it was.

**A crash between the promotion and its intent is healed on the next start.**
Promotion is two adjacent appends, and nothing fallible sits between them — but a
process death or a sqlite error on the second leaves the log claiming a human
attached a draft that has no intent. That draft is invisible: `agentDrafts` (which
the promotion retired) is empty, and `unsyncedCommentIds` is empty too, so the
reviewer's rail shows nothing and a submit ships without it. Boot therefore composes
the missing intent from the log — the promotion names the comment and the thread
carries its anchor and body, which is all the route had. It is a **local** append:
the reconcile that follows still runs read-only, so the repaired intent is picked up
by the next cookie-authenticated action like any other durable intent, and boot
still never writes to the remote. The composition goes through the same
`findDraftToPromote`, so an unmappable anchor or a body that no longer matches the
pin is left alone rather than healed into something unpromotable.

**Derived, not held — and derived ONCE.** `reduceReviewState(...).agentDrafts`
lists the unpromoted drafts from the log, so there is no second source of truth
and nothing to reconcile across a restart. A second agent draft on a thread
after a promotion is a new entry (keyed by the draft's own identity), and a
lifecycle draft is gone the moment the thread's state changes — there is no
longer anything to resolve on GitHub.

**The supersession applies to the reviewer's OWN unresolved intent too.** This is a
behaviour change from before `reduceThreadLifecycleStates` existed, and it is
deliberate. Previously a `thread.resolved` by a `local` actor stayed an outstanding
intent no matter what came after it, so an agent's later reopen left the reviewer's
resolve queued: the reconciler would resolve the remote thread while the local log
said `open`, and append a `thread.external_synced` claiming a baseline that never
happened. That is the same divergence finding 2 was about, reached from the other
side, so the rule is stated once and applies whoever authored the change: **the
thread's current lifecycle change is the only one that acts.** A reviewer's own later
change therefore supersedes an agent draft (and acts without promotion, as before),
and an agent change supersedes the reviewer's earlier one. Both orders are pinned by
tests.

That last rule is **`reduceThreadLifecycleStates`, one exported derivation with
three consumers**: the reducer's draft list, the daemon's `findDraftToPromote`
(which refuses a stale target), and `reconcileThreadStateIntents` — the one that
**writes**. Three separate implementations of "which lifecycle change is
current, and is it promoted" is how a promoted resolve came to be fired for a
thread that had since been reopened, while the rail's badge and the route both
correctly showed nothing to promote: the writer was the outlier, and it corrupted
the external baseline besides making the wrong write. The rule is therefore
stated once, here, and enforced by rule 3 above so that even a writer that
bypasses the derivation cannot produce a stale authorization. Refs: #70, #59, #8

## Amendment (2026-10-05, issue #69): a directory that vanishes inside the watcher callback is polled, never unwatched

The #49 amendment above enumerates the fallback set — re-armed onto `fs.watch` for a never-watched
path, `stat`-poll for the swap-damaged ones — and this adds the one shape that belonged to neither: a
directory whose own `fs.watch` callback observes it disappear now installs the same `stat`-poll every
other teardown path installs, so **every tracked directory is always in exactly one of watch or poll,
never neither**. Refs: #69

## Amendment (2026-10-08, issue #136): promotions bind to a pending review

`draft.promoted` now carries an optional `reviewNodeId`, the GitHub GraphQL
node id of the pending review the reviewer attached the draft to. New promotions
always write it for all three targets (`comment`, `resolve`, `reopen`). The node
id identifies the remote review itself: it survives daemon restart, is already
persisted by `review.opened`, and is the identity used by GitHub reconcile. A local
sequence identifies an event in one log rather than the remote review.

The field remains optional so historical events still parse and replay. The
transition validator accepts an unbound historical promotion; a bound promotion
must name a review that is pending at the point it is appended. No event-log
version bump or migration is required.

The promote route and `healMissingPromotionIntents` share one guard. An absent
open review yields `no-open-pending-review`. An existing promotion whose node id
differs from the open review yields `promotion-review-mismatch`. A historical
promotion without a node id yields `promotion-review-unbound`: its intended
review cannot be proved, so neither retry nor boot recovery may construct a new
intent from it. The route returns these typed errors with HTTP 409; boot skips
the promotion and logs the refusal reason. Already-recorded machine intents keep
their existing reconciliation semantics.

This closes the incomplete-promotion window: promotion into A, A submitted,
B opened, daemon restarted. Recovery must not construct an intent that a later
cookie-authenticated reconcile could publish into B without a promotion click in
B. The same rule covers discard and head-move abandonment. Legacy promotions are
left as historical records; recovery never guesses their target review from the
currently open review.

Refs: #136, #123, #70


### Round 1 (issue #136): enforce the binding at the destination

Promoted comments and replies are posted only into the bound review, enforced
at the destination in `reconcile`. Each agent-authored comment's latest machine
intent resolves to the most recent comment promotion preceding that intent in
the ordered event log. A later promotion cannot retroactively authorize an old
intent. This derivation covers existing and boot-healed intents without adding
a new event field or migrating historical logs.

Before either comment/reply mutation or fingerprint completion, reconciliation
requires that the resolved binding equal its actual destination review node id.
A terminal binding fails with `promotion-review-not-pending`; a different
review fails with `promotion-review-mismatch`; missing/legacy authorization
fails with `promotion-review-unbound`. The failure is recorded as
`comment.sync_failed`, preserving the intent for explicit reviewer recovery.
The transition validator also uses the distinct `promotion-review-not-pending`
rejection when a bound promotion names an unknown or terminal review.
Reviewer-authored machine intents retain their normal reconciliation behavior.

The route and boot heal keep their fast guards. Boot healing still precedes the
remote read: correctness relies on the destination check, which also records a
failure when the read observes a remote submit or deletion. A remote submission
between the route's guard and reconciliation cannot authorize a post into a
replacement review. The destination node id remains fixed for the mutation;
GitHub refuses a mutation if that review has become terminal meanwhile.

A fresh promotion explicitly names the review currently shown to the reviewer
in `POST /api/review/promote`'s optional `reviewNodeId`. When replacing a binding,
the route appends both a new `draft.promoted` and a new `comment.sync_requested`.
It never rewrites the old binding. Requests without the field keep their retry
semantics and refuse a different review. A stale explicit review id is refused.
The content-pin check continues to apply. Crash healing and retry count an intent
as present only if it follows the promotion being recovered, so an old A intent
cannot hide the missing intent for a fresh promotion into B.

The rail displays the typed sync failure as a request to promote the draft into
the current review and offers an explicit "Promote to this review" action.
Ordinary "Retry sync" never changes the binding. A missing promotion record is
an internal log inconsistency (`promotion-record-missing`, HTTP 500), distinct
from a historical event without a binding.

Refs: #136, #148

## Amendment (2026-10-08, issue #113): quotes come from renderer provenance

Stories A2 and A8 require a stored quote to identify the source addressed by a
reviewer's rendered selection. Typography, entities, escapes and inline-code
padding make DOM character arithmetic insufficient. The shared site/CLI
pipeline therefore stamps each positioned text leaf with a stable, versioned
identifier and its source interval. Offsets are UTF-16 and half-open; source
and browser-visible leaf values use LF line endings. Identity runs are implicit.
Only changed runs carry interval entries.

The owner chose design **(b′)**: a linear walk over each leaf's own positioned
source slice, decoding a finite substitution table and composing those decoded
atoms with smart quotes, dash and ellipsis runs. The aligner consumes literal
star/bracket/dot runs once and never parses emphasis, links or Markdown blocks.
An unexplained mismatch makes the whole leaf unmapped. Generated text without
positions remains untouched, including KaTeX's MathML and highlighted code.
MDX leaves are currently unmapped: legacy recovery never evaluates components.
Wrapped list/blockquote prefixes and other unexplained source gaps also fail
closed. The real renderer/browser differential suite guards renderer drift.

The rail sends leaf identifiers and DOM Range offsets, map version, and the
rendered source revision. It does not send a rendered quote or text-search hint.
Repeated phrases use the selected occurrence's endpoints. A selection touching
unmapped content offers an explicit **comment on whole block** action. A refused
submission keeps the composer draft. Source quotes inside larger blocks use a
containing-block lookup for navigation.

The daemon reads a confined source, checks the rendered revision, renders that
snapshot through the shared pipeline and captures maps directly from the
renderer callback. It does not trust maps embedded in authored HTML. Both
endpoints, their order, containment and intervening content must validate.
Lossy-token endpoints include the complete source token; ranges crossing inline
markup retain the intervening source syntax. Quote, context, both line bounds
and revision are derived server-side. No review-event schema changes.

Legacy quote requests and existing comments are recovered against rendered
snapshots. Unique source-shaped and rendered/context candidates must agree;
ambiguous or missing provenance orphans the comment. Recovered quotes enter the
source-only reanchor engine. Reanchoring appends events without rewriting the
original comment. Modified-span alignment uses snapshot source text and source
trailing context, including when a legacy whole-block quote recorded empty
context, preventing the paragraph overruns in #126 and #146. Refs: #113, #126,
#127, #146. This establishes source quote provenance for A6; suggested edits
remain planned.

## Amendment (2026-10-08, issue #113, PR #157 fix round): preserve atoms and scope leaf identities

An unchanged punctuation run retains each decoded atom's interval. Only an
actual typography collapse may combine the atoms; selecting one dot, dash or
apostrophe cannot include an unchanged neighbor. Leaf identifiers now include
a digest of the remapped file path and LF-normalized snapshot, preventing
identical offsets in another file or revision from identifying a current leaf.

Legacy recovery bounds source and rendered searches to the recorded lines
before validating candidates. A terminating newline remains part of its source
line. Line and text-node indexes, inverse interval bounds and counts of unmapped
text avoid rescanning an entire block for each occurrence. The independent
browser interval oracle is permanent; its full-size manual run reports agreement,
refusals and wrong intervals separately. Renderer exceptions emit a debug event
with the allowlisted error kind, without source or exception-message content.
