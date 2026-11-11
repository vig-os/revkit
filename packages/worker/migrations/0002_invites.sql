-- M4 slice 3 (issue #9): the invite redemption ledger and the rate-limit
-- counters — the two things `0001_init.sql` had columns for but no code.
--
-- Applied OUT OF BAND by whoever provisions the database, exactly like
-- `0001_init.sql`; the Worker never runs DDL on boot. The wrangler verb is
-- `wrangler d1 migrations apply <database>`, which walks the directory in
-- filename order and records what it applied.
--
-- Every statement is `IF NOT EXISTS`, so this file is idempotent on its own
-- and a database that already has the tables converges rather than erroring.
-- (It deliberately adds **no column to an existing table**, so it needs no
-- `ALTER TABLE` — which SQLite has no `IF NOT EXISTS` form of, and which is
-- the one thing in a migration directory that cannot be applied twice.)
--
-- ── Why a ledger and not `invites.redeemed_at` ────────────────────────────
--
-- The obvious shape is a `redeemed_at` column on `invites`, one redemption
-- per token. It cannot express ADR-0009's `team` and `view` share types, and
-- the brief's own negative-test list is what settled it: "already-redeemed
-- (replay)", "a second browser on a `personal` invite" and "`max_browsers`
-- exceeded" are three DIFFERENT refusals, so a token cannot have a single
-- redemption moment. What it has is a number of **browser bindings**, which is
-- what `max_browsers` counts, and a row per binding is the only representation
-- that makes all three refusals distinct.
--
-- So `binding_hash` — the SHA-256 of the `__Host-revkit_browser` cookie value,
-- never the value — is the second half of the primary key, and re-presenting
-- the same binding collides with the composite key rather than creating a
-- second row. That is the "single use" property as a schema fact: an invite
-- can be redeemed once per browser, and `max_browsers` is how many browsers
-- that is.
--
-- `guest_id` is the third column and it is the join that makes ADR-0012's
-- "checked for scope, type and expiry on each call" possible without a second
-- issuance path: `sessions.identity_id` holds the guest id, and this table is
-- what turns a session back into its invite. A session whose guest has no row
-- here is refused, which is the fail-closed direction (ADR-0015's purge
-- anonymises a guest rather than deleting the row, precisely so this join
-- survives).
--
-- One `guests` row per redemption, not per person: there is no way to recognise
-- a returning guest (that is Authentik, #4), so two browsers redeeming the
-- same `team` invite are two guest records with two display names and two
-- retention clocks. Both are deleted on the same trigger, because both hang
-- off the same invite.
--
-- No `FOREIGN KEY` to `invites`, matching `0001_init.sql`, which declares
-- none: D1 does not enforce them by default, and a constraint that reads as
-- a guarantee but is not enforced is worse than an explicit join.
CREATE TABLE IF NOT EXISTS invite_redemptions (
  invite_id TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  guest_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (invite_id, binding_hash)
);

-- The per-call check goes session -> guest -> invite, and `guest_id` is not a
-- prefix of the primary key, so this index is what keeps that check an indexed
-- lookup instead of a scan of every redemption this deployment has ever made.
CREATE INDEX IF NOT EXISTS invite_redemptions_guest ON invite_redemptions (guest_id);

-- ---------------------------------------------------------------------------
-- Rate-limit counters (ADR-0012: "rate limits on invite redemption and comment
-- posting per identity and IP").
--
-- The mechanism ADR-0012 names is a Durable Object counter. Slice 3 uses D1
-- instead, and the ADR-0012 amendment dated 2026-10-04 records why, with the
-- measurements: D1's `INSERT … ON CONFLICT(bucket) DO UPDATE … RETURNING count`
-- is atomic under concurrency (20 concurrent increments of one bucket produced
-- 20 distinct counts, 1..20, on workerd 2026-05-18), so this table is a real
-- counter and not an approximation of one. A Durable Object is still the end
-- state and lands with the rest of the Durable Object work (M4 slice 6).
--
-- `bucket` is the key and it is opaque on purpose: `invite:<sha256-hex>` for
-- the "identity" half (before a session exists, the invite IS the identity)
-- and `ip:<address>` for the "and IP" half. A bucket name is never logged and
-- never returned — `src/rate-limit.ts` exposes only a `bucketKind`, because
-- ADR-0015/ADR-0020 treat an address as personal data and the invite digest
-- as close enough to a credential to keep out of a log line too.
--
-- A fixed window, not a sliding one: one statement can roll the window over
-- atomically with the increment (measured working — see the amendment), which
-- is what keeps the whole check to a single round trip.
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start TEXT NOT NULL
);
