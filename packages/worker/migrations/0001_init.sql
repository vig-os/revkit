-- M4 slice 1 initial schema for the hosted Worker (issue #9).
--
-- Applied OUT OF BAND by whoever provisions the database — the Worker
-- itself NEVER runs DDL on boot, so a request can never be the thing that
-- creates a table. ADR-0008 puts that step in `revkit deploy init`
-- (owner-gated, #34); the wrangler verb that applies this directory is
-- `wrangler d1 migrations apply <database>`, which reads `migrations_dir`
-- (it does NOT take a `--file` flag — there is no such option on that
-- subcommand). Until then the test harness applies it, one statement at a
-- time, from THIS file.
--
-- Every statement is `IF NOT EXISTS`, so applying this file twice is a
-- no-op (acceptance A15) and a partially-applied database converges rather
-- than erroring.
--
-- There is deliberately ONE DDL file for the hosted store, not a second
-- copy under `src/`: two copies of one migration drift, and the
-- `duplication` guardrails gate exists precisely to catch that. The
-- daemon's `bun:sqlite` schema (`packages/cli/src/serve/sqlite-store.ts`)
-- is a different database on a different runtime and keeps its own DDL
-- constant — that is a port, not a copy.
--
-- What is NOT portable from SQLite and is therefore absent:
-- `journal_mode = WAL`, `synchronous = NORMAL`, and any
-- `BEGIN IMMEDIATE` / `COMMIT`. D1 refuses interactive transactions
-- outright ("To execute a transaction, please use the [\"batch()\"] API",
-- measured on miniflare 4.20260518.0), and its durability is the
-- platform's problem, not the schema's. `D1ThreadStore` re-derives the
-- concurrency discipline those pragmas used to provide — see the
-- `db.batch([...])` note in `src/d1-store.ts`.
--
-- One note on the `--` comments in this file, since they are deliberate.
-- Two facts, both read rather than assumed:
--   - wrangler splits a migration file with its own `splitSqlIntoStatements`
--     (wrangler 4.93.0, `pkgs.wrangler`, read in the nix store), which
--     consumes `--` line comments and block comments and then drops empty
--     chunks. So comments never reach D1 as statements.
--   - wrangler's `trimSqlQuery` rejects a file containing a TRANSACTION
--     wrapper, and its only test is for the literal `BEGIN TRANSACTION`.
--     This file contains no such statement. It says `BEGIN IMMEDIATE` in
--     the comment above, which is a different string and is not a
--     transaction this file opens.

-- ---------------------------------------------------------------------------
-- The event log (ADR-0006). One row per appended event; `seq` is the
-- server-ordered monotonic the reducer and `since(after)` trust.
--
-- `payload` is the full `ReviewEvent` as JSON — INCLUDING its `seq` and
-- `ts` — so a query returns a row `reviewEventSchema.parse` accepts
-- unchanged. `seq` and `ts` are stored twice on purpose: they are the
-- two query keys (`since(after)` filters on `seq`; a future ADR-0015
-- retention job filters on `ts`), and keeping them as columns lets the
-- append path build `payload` from a seq it computed itself.
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  payload TEXT NOT NULL
);

-- Parity with `sqlite-store.ts`'s `events_ts`: a retention sweep reads a
-- time range, not the whole log.
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);

-- ---------------------------------------------------------------------------
-- Revision snapshots (ADR-0006, M2 item 5b). Content-addressed by the
-- anchor's `revision` hash: the LF-normalised source text a comment was
-- made against. The hosted re-anchoring pipeline reads `source` for the
-- old revision, so a thread's snapshot must outlive the request that
-- created it — which is why it is D1 state and not Worker memory.
CREATE TABLE IF NOT EXISTS snapshots (
  revision TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Guests (ADR-0015). First-class from slice 1, not retrofitted: guest
-- attribution has to survive in the event log AND stay redactable, and a
-- migration that adds an identity column after threads have accumulated
-- cannot recover which threads a guest authored.
--
-- Columns only — slice 1 mints no invite and serves no guest session.
-- The invariants ADR-0015 states are already teeth here so they cannot
-- be forgotten: a display name is REQUIRED (the CHECK refuses NULL and
-- blank), the email is optional and exists only for notifications, and
-- `deleted_at` is the clock a retention pass reads (30 days after the
-- invite is revoked or expires).
CREATE TABLE IF NOT EXISTS guests (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  email TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

-- ---------------------------------------------------------------------------
-- Invite links (ADR-0009, ADR-0012). Shape only — slice 1 mints,
-- verifies, revokes and redeems nothing. `token_hash` is UNIQUE because
-- "stored hashed, never in the clear" (ADR-0009) is only true if two
-- identical tokens cannot both exist; A17 pins that constraint before
-- any invite code does.
--
-- `kind` is ADR-0009's three share types. The CHECK keeps it a value in
-- a table rather than a magic string a caller can typo:
--   personal — 14 days, one browser
--   team     — 30 days
--   view     — 30 days, read-only
-- `can_comment` and `revocable` are INTEGER 0/1 flags for the same
-- reason; `max_browsers` is ADR-0009's one-browser binding for
-- `personal`, expressed as a number so `view`/`team` do not need a
-- sentinel.
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  repo TEXT NOT NULL,
  pr INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'team', 'view')),
  can_comment INTEGER NOT NULL CHECK (can_comment IN (0, 1)),
  revocable INTEGER NOT NULL CHECK (revocable IN (0, 1)),
  max_browsers INTEGER NOT NULL CHECK (max_browsers >= 1),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

-- ---------------------------------------------------------------------------
-- Sessions (ADR-0012). Shape only — slice 1 issues no cookie and checks
-- no CSRF token, which is why `POST /api/threads` ships disabled rather
-- than shipping a state-changing endpoint with no CSRF check.
--
-- `identity_kind` is deliberately NOT constrained by a CHECK: it is the
-- discriminator for "which provider authenticated this", and the set is
-- open (ADR-0009's GitHub App and invites today, Authentik in #4). A
-- closed CHECK here would mean a table rewrite to add a provider, and
-- `identity_id` is an opaque id in every case (ADR-0020).
--
-- `csrf_hash` is the hash of the per-session CSRF token ADR-0012
-- requires in a header on every state-changing call. Stored hashed for
-- the same reason `invites.token_hash` is: the token is a bearer
-- credential, so the database must not be enough to forge one.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  identity_kind TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  csrf_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
