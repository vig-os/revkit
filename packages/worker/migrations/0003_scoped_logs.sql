-- M4 slice 5 (issue #9): the SCOPE AXIS — the repo/PR one review's log is
-- partitioned by, which is what ADR-0012's "a guest invite is checked for
-- scope … on each call" finally selects on.
--
-- Applied OUT OF BAND by whoever provisions the database, exactly like
-- `0001_init.sql` and `0002_invites.sql`; the Worker never runs DDL on boot.
-- The wrangler verb is `wrangler d1 migrations apply <database>`, which walks
-- the directory in filename order and records what it applied.
--
-- Every statement here is idempotent, so this file is safe to apply twice and a
-- partially-applied database converges — the property `0001_init.sql` and
-- `0002_invites.sql` both claim and `test/schema.test.ts` measures over the
-- whole directory. Three of the five statements are `IF NOT EXISTS`, the copy is
-- `OR IGNORE`, and the emptying is a `DELETE` rather than a `DROP`. **The
-- ordering is load-bearing** and the reasons are stated per statement.
--
-- ── Why a NEW TABLE and not an ALTER ────────────────────────────────────
--
-- `0001_init.sql`'s log is `events(seq INTEGER PRIMARY KEY, ts, payload)` — one
-- flat log for the whole org, because ADR-0008 puts one Worker, one D1 and one
-- deployment per org while a deployment holds many `(repo, PR)` reviews. The
-- axis has to be part of the KEY for `seq` to mean what `ThreadStore` means by
-- it ("this store's head"), and SQLite cannot change a primary key in place.
--
-- The rebuild also cannot end in `ALTER TABLE … RENAME TO`, which is the usual
-- three-step (`CREATE` new → `INSERT … SELECT` → `DROP` old → `RENAME`), because
-- **D1 does not authorise `sqlite_rename_table`** (workerd issue #729, "not
-- authorized to use function: `sqlite_rename_table`"). This repo cannot verify
-- that against a live database — no wrangler verb may run here, and nothing in
-- this migration directory is allowed to be a guess — so the rebuilt table
-- carries its OWN name and the old one is left retired and empty. A guess that
-- turned out wrong would fail at deploy time with a wrangler error; a
-- `RENAME` that D1 has since started authorising would have been an
-- unreadable migration for nothing.
--
-- Every verb used below (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT
-- EXISTS`, `INSERT … SELECT`, `DELETE FROM`) is plain DDL/DML of the same
-- families `0001_init.sql` and `0002_invites.sql` already use, and none of them
-- is in the `ALTER TABLE` family D1 has restricted.
--
-- ── What happens to rows that are ALREADY there ──────────────────────────
--
-- **Quarantined: kept, and made unreachable. Not discarded, and not given a
-- scope.** Both of those would be decisions rather than details, so they are
-- stated:
--
--   - *Not discarded.* `events_unscoped_legacy` holds every pre-existing row,
--     byte for byte, with its own `seq`. Nothing is lost and nothing has to be
--     regenerated; an operator who learns which review those rows belonged to can
--     re-inject them into `review_logs` under the right `log_key` with one
--     `INSERT … SELECT`. That reversibility is the whole reason for a copy
--     rather than a delete.
--   - *Not given a scope.* Inventing one — a sentinel key, a "legacy" bucket a
--     route could name, or folding them into some real `(repo, PR)` — would
--     make an unattributable event log readable by somebody, and a log nobody
--     can attribute is exactly the log that must not be readable by anybody.
--     So the quarantine table is named in no route, derived from no `Route`, and
--     read by no statement in `src/`; `test/schema.test.ts` asserts all three,
--     and asserts that `events` itself is empty, so a later edit that points
--     code at either table fails instead of quietly serving an unscoped log.
--
-- **In practice the table is empty**, and that is recorded rather than relied
-- upon: nothing can write an event over HTTP (`POST <repo>/pr-<n>/api/threads`
-- is a 501, slice 4's bridge), nothing mints an invite (`mintInvite` has no
-- HTTP route and no CLI command yet), and no `revkit deploy init` exists
-- (slice 8), so no deployed database has ever had an event row to quarantine.
-- "Empty in practice" is not "empty by construction", which is why this file
-- decides the question instead of assuming it.

-- ---------------------------------------------------------------------------
-- 1. The quarantine. Created FIRST, so that by the time anything destructive
--    runs the destination exists. `seq INTEGER PRIMARY KEY` because that is
--    what the rows being copied had, and `OR IGNORE` below is only meaningful
--    against a key.
CREATE TABLE IF NOT EXISTS events_unscoped_legacy (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  payload TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 2. The copy. Runs BEFORE the emptying, obviously, and is `OR IGNORE` so that a
--    second application of this file is a no-op rather than a constraint
--    failure — which it would otherwise be, since the quarantine already holds
--    the seqs.
INSERT OR IGNORE INTO events_unscoped_legacy (seq, ts, payload)
  SELECT seq, ts, payload FROM events;

-- ---------------------------------------------------------------------------
-- 3. `events` is RETIRED: emptied here and never read or written again.
--
-- **Emptied, not dropped**, and that is the one place this file trades
-- cleanliness for a property. `DROP TABLE IF EXISTS events` would be tidier and
-- would leave no ambiguous table behind, but it cannot be re-applied: on a
-- second run statement 2 above would read a table that no longer exists and
-- error, so the directory would lose the convergence property its other two
-- migrations state and `test/schema.test.ts` measures. `DELETE FROM` is
-- idempotent, so the file converges, and an emptied table is the SAFE shape for
-- a table nobody may read: a mistake that pointed code at it returns nothing
-- rather than returning another review's comments.
--
-- `events` cannot be renamed to something self-evidently retired, because of
-- the `sqlite_rename_table` authorisation above.
DELETE FROM events;

-- ---------------------------------------------------------------------------
-- 4. The scoped log. `log_key` is the review's preview scope path —
-- ADR-0008's own `<repo>/pr-<n>` spelling, produced by `previewScopePath` in
-- `src/router.ts` and nowhere else, so the partition key and the URL a caller
-- must present cannot drift apart.
--
-- `PRIMARY KEY (log_key, seq)` is what makes `seq` per-log: two reviews both
-- start at 1, which is what `ThreadStore` has always meant by a fresh store's
-- head (the shared conformance suite's A5 asserts it), and it is why
-- `D1ThreadStore`'s compare-and-swap on `MAX(seq)` became a per-log CAS.
--
-- **ONE column and not `repo` + `pr`.** With two columns a `WHERE repo = ?`
-- statement is expressible, and that statement is this whole defect wearing a
-- different hat: a query that names a repository and forgets the PR returns
-- every PR of it. With one column there is no such query to write — the only
-- predicate available is equality on the whole scope — so the failure mode is
-- not guarded against, it is unrepresentable. The derivation is injective
-- (`isRepoName` admits no `/`, and `pr` is a decimal integer, so no two
-- `(repo, pr)` pairs share a key), and `test/d1-store.test.ts` asserts it.
--
-- `NOT NULL` on `log_key` is load-bearing rather than documentation: it makes
-- an unscoped row unstorable even by a hand-written statement.
CREATE TABLE IF NOT EXISTS review_logs (
  log_key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (log_key, seq)
);

-- ---------------------------------------------------------------------------
-- 5. Retention parity with `0001_init.sql`'s `events_ts` and with the daemon's
--    own `events_ts` (`packages/cli/src/serve/sqlite-store.ts`): an ADR-0015
--    sweep reads a time range, not the whole log. Leading with `log_key` because
--    a sweep is always per-review — it must never be able to express "every log
--    in this org" by dropping a predicate.
CREATE INDEX IF NOT EXISTS review_logs_log_ts ON review_logs (log_key, ts);
