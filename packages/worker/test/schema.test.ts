// The shipped D1 schema: A15-A17, plus the platform facts the harness
// depends on.
//
// A15 (idempotence) is asserted on the REAL migration file, applied twice,
// through the same code path production uses. A16 and A17 are asserted as
// database behaviour rather than as a schema string: "the DDL says NOT
// NULL" is a claim about a file, while "the database refuses the row" is a
// claim about the constraint the deploy will actually enforce.
//
// ADR-0015's reason for putting guest attribution in the schema NOW rather
// than when invites exist is migration cost, and A16/A17 are the teeth of
// that: an invariant with a test behind it cannot be quietly dropped when
// the invite code lands.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MIGRATIONS, MIGRATION_SQL, applyMigration, sqlStatements, startWorker, type Harness } from "./harness.ts";

describe("D1 schema", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startWorker();
  });

  afterAll(async () => {
    await harness.dispose();
  });

  // ── A15 ───────────────────────────────────────────────────────────────
  test("A15: applying 0001_init.sql twice succeeds and changes nothing", async () => {
    const before = await tableNames();
    const statements = await applyMigration(harness.db);
    expect(statements).toBeGreaterThan(0);
    expect(await tableNames()).toEqual(before);
  });

  test("A15: the split loses nothing — every statement in the file is executed", async () => {
    const statements = sqlStatements(MIGRATION_SQL);
    // The file's own CREATE count is the number of statements that must run.
    const creates = [...MIGRATION_SQL.matchAll(/^\s*CREATE\s+(TABLE|INDEX)/gim)].length;
    expect(statements).toHaveLength(creates);
    for (const statement of statements) {
      expect(statement).toMatch(/^\s*CREATE\s+(TABLE|INDEX)/i);
      expect(statement.endsWith(";")).toBe(false);
    }
    // And every table the code binds to is among them.
    const created = statements.join("\n");
    for (const table of ["events", "snapshots", "guests", "invites", "sessions"]) {
      expect(created).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  test("PLATFORM FACT: prepare() accepts comments and multi-line statements; exec() does not", async () => {
    // The claim `harness.ts` makes about WHY it splits the migration and
    // runs it one statement at a time. Measured on workerd 2026-05-18:
    //
    //   `exec(sql)`      -> rejects a `--` comment ("SQL code did not
    //                       contain a statement") and TRUNCATES a
    //                       multi-line statement at the first newline
    //                       ("incomplete input").
    //   `prepare(s).run()` -> accepts a leading comment block, a trailing
    //                       comment and a block comment, and a multi-line
    //                       CREATE TABLE, unchanged.
    //
    // Both halves are asserted because the harness depends on the second
    // one: it applies the SHIPPED file with no text transformation, and
    // `test/harness.ts` would be relying on an unverified claim otherwise.
    const commented = [
      "-- a leading comment",
      "/* a block comment */",
      "CREATE TABLE IF NOT EXISTS comments_ok (",
      "  id TEXT PRIMARY KEY,",
      "  nm TEXT NOT NULL -- a trailing comment",
      ")",
    ].join("\n");
    await expect(harness.db.prepare(commented).run()).resolves.toBeDefined();

    // And `exec()` really does refuse the same text, so the difference is
    // the entry point rather than the SQL.
    await expect(harness.db.exec(commented)).rejects.toThrow(/SQL code did not contain a statement|error/i);

    // The multi-line statement landed, comments and all.
    const columns = await harness.db
      .prepare("PRAGMA table_info(comments_ok)")
      .all<{ name: string }>();
    expect((columns.results ?? []).map((c) => c.name)).toEqual(["id", "nm"]);
  });

  test("the splitter is not fooled by a `;` inside a string or a comment", () => {
    // A DEFAULT carrying a semicolon, or a `--` line mentioning one, must
    // not split the statement. A splitter that did would silently ship a
    // truncated migration.
    const sql = [
      "-- a comment with a ; in it",
      "CREATE TABLE IF NOT EXISTS t (a TEXT DEFAULT 'x;y');",
      "/* block ; comment */",
      "CREATE TABLE IF NOT EXISTS u (b TEXT);",
    ].join("\n");
    const statements = sqlStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("DEFAULT 'x;y'");
    expect(statements[1]).toContain("CREATE TABLE IF NOT EXISTS u");
  });

  // ── A16 ───────────────────────────────────────────────────────────────
  test("A16: guests rejects a NULL display_name", async () => {
    await expect(
      harness.db
        .prepare("INSERT INTO guests (id, display_name, email, created_at) VALUES (?, ?, ?, ?)")
        .bind("g-null", null, "a@example.com", "2026-10-03T12:00:00Z")
        .run(),
    ).rejects.toThrow(/NOT NULL/i);
  });

  test("A16: guests rejects a BLANK display_name, not just a missing one", async () => {
    for (const blank of ["", "   "]) {
      await expect(
        harness.db
          .prepare("INSERT INTO guests (id, display_name, email, created_at) VALUES (?, ?, ?, ?)")
          .bind(`g-blank-${blank.length}`, blank, null, "2026-10-03T12:00:00Z")
          .run(),
      ).rejects.toThrow(/CHECK constraint failed/i);
    }
  });

  test("A16: guests accepts a NULL email — it is optional (ADR-0015)", async () => {
    await harness.db
      .prepare("INSERT INTO guests (id, display_name, email, created_at) VALUES (?, ?, ?, ?)")
      .bind("g-no-email", "Reviewer", null, "2026-10-03T12:00:00Z")
      .run();
    const row = await harness.db
      .prepare("SELECT display_name, email, deleted_at FROM guests WHERE id = ?")
      .bind("g-no-email")
      .first<{ display_name: string; email: string | null; deleted_at: string | null }>();
    expect(row?.display_name).toBe("Reviewer");
    expect(row?.email).toBeNull();
    // `deleted_at` is the clock a 30-day purge reads (ADR-0015); null means
    // "not yet due", not "unknown".
    expect(row?.deleted_at).toBeNull();
  });

  // ── A17 ───────────────────────────────────────────────────────────────
  test("A17: invites refuses two rows with the same token_hash", async () => {
    const base = {
      repo: "vig-os/revkit",
      kind: "personal",
      can_comment: 1,
      revocable: 1,
      maxBrowsers: 1,
    };
    const insert = (id: string, hash: string): Promise<unknown> =>
      harness.db
        .prepare(
          "INSERT INTO invites (id, token_hash, repo, pr, kind, can_comment, revocable, max_browsers, expires_at, created_at)" +
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id, hash, base.repo, 7, base.kind, base.can_comment, base.revocable, base.maxBrowsers, "2026-10-17T12:00:00Z", "2026-10-03T12:00:00Z")
        .run();
    // 64 hex chars = a 256-bit token, hashed at rest (ADR-0009).
    await expect(insert("inv-1", "a".repeat(64))).resolves.toBeDefined();
    await expect(insert("inv-2", "a".repeat(64))).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  test("A17: the share-type and flag constraints keep `kind` a value, not a typo", async () => {
    // ADR-0009 names exactly three share types. A free-text column would let
    // `personal ` or `Personal` through and strand the row.
    await expect(insertInvite("inv-bad-kind", "b".repeat(64), "Personal")).rejects.toThrow(
      /CHECK constraint failed/i,
    );
    // And the 0/1 flags cannot drift into other integers.
    await expect(insertInvite("inv-bad-flag", "c".repeat(64), "team", 2)).rejects.toThrow(
      /CHECK constraint failed/i,
    );
    // A `personal` invite is bound to one browser; `max_browsers = 0` would
    // mean "no browsers may ever use this", which is not a share type.
    await expect(insertInvite("inv-bad-browsers", "d".repeat(64), "view", 1, 0)).rejects.toThrow(
      /CHECK constraint failed/i,
    );
    // ADR-0009's three types are accepted.
    for (const kind of ["personal", "team", "view"]) {
      await expect(insertInvite(`inv-ok-${kind}`, `${kind.charCodeAt(0)}`.repeat(64), kind)).resolves.toBeDefined();
    }
  });

  test("sessions has no CHECK on identity_kind, because the provider set is open", async () => {
    // ADR-0009's GitHub App and invites today, Authentik in #4. A closed
    // CHECK here would mean a table rewrite to add a provider, so the
    // discriminator stays free text — and the test says so, so the
    // decision is visible rather than an omission.
    await harness.db
      .prepare(
        "INSERT INTO sessions (id, identity_kind, identity_id, csrf_hash, created_at, expires_at)" +
          " VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind("s-1", "github", "gh-user-1", "e".repeat(64), "2026-10-03T12:00:00Z", "2026-10-04T12:00:00Z")
      .run();
    await harness.db
      .prepare(
        "INSERT INTO sessions (id, identity_kind, identity_id, csrf_hash, created_at, expires_at)" +
          " VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind("s-2", "authenik", "opaque-id", "f".repeat(64), "2026-10-03T12:00:00Z", "2026-10-04T12:00:00Z")
      .run();
    const kinds = await harness.db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>();
    expect(kinds?.n).toBe(2);
  });

  // ── A15 over the DIRECTORY, and slice 5's migration ──────────────────
  test("A15: applying the WHOLE directory twice is a no-op — including 0003", async () => {
    // The per-file case above is about `0001_init.sql`. Slice 5's
    // `0003_scoped_logs.sql` is the one file here that is NOT entirely
    // `CREATE … IF NOT EXISTS`, so the convergence claim has to be measured
    // over the directory rather than asserted per file. Every statement in it
    // is idempotent by construction (`IF NOT EXISTS`, `OR IGNORE`, `DELETE`),
    // and this is what proves it: applied twice, the second pass changes
    // nothing — and crucially does not re-empty `review_logs`.
    await harness.db.prepare("DELETE FROM review_logs").run();
    await harness.db
      .prepare("INSERT INTO review_logs (log_key, seq, ts, payload) VALUES (?, ?, ?, ?)")
      .bind("/revkit/pr-7", 1, "2026-10-04T12:00:00Z", "{}")
      .run();
    const before = await tableNames();
    const statements = await applyMigration(harness.db);
    expect(statements).toBeGreaterThan(sqlStatements(MIGRATION_SQL).length);
    expect(await tableNames()).toEqual(before);
    // The row survived the second application. `DELETE FROM events` is
    // idempotent and the copy is `OR IGNORE`; a `DROP TABLE` here would have
    // failed this, which is why the migration empties rather than drops.
    const kept = await harness.db
      .prepare("SELECT COUNT(*) AS n FROM review_logs")
      .first<{ n: number }>();
    expect(kept?.n).toBe(1);
  });

  test("0003: review_logs is keyed (log_key, seq), and log_key is NOT NULL", async () => {
    // The whole partition. `seq` alone being the key was the defect: with one
    // key per deployment there was no scope for a check to select on.
    type Column = { name: string; type: string; pk: number; notnull: number };
    const columns = await harness.db.prepare("PRAGMA table_info(review_logs)").all<Column>();
    const byName = new Map((columns.results ?? []).map((c) => [c.name, c]));
    expect([...byName.keys()].sort()).toEqual(["log_key", "payload", "seq", "ts"]);
    expect(byName.get("log_key")?.notnull).toBe(1);
    // `pk > 0` on BOTH: a composite key, so two logs may each hold `seq = 1`.
    expect(byName.get("log_key")?.pk).toBeGreaterThan(0);
    expect(byName.get("seq")?.pk).toBeGreaterThan(0);
    expect(byName.get("seq")?.type).toBe("INTEGER");
    // Two logs, one seq each — the fact the old schema made impossible. Wiped
    // first: the A15-directory case above seeded `/revkit/pr-7` seq 1, and this
    // case must not depend on that.
    await harness.db.prepare("DELETE FROM review_logs").run();
    const insert = (logKey: string, seq: number): Promise<unknown> =>
      harness.db
        .prepare("INSERT INTO review_logs (log_key, seq, ts, payload) VALUES (?, ?, ?, ?)")
        .bind(logKey, seq, "2026-10-04T12:00:00Z", "{}")
        .run();
    await expect(insert("/revkit/pr-7", 1)).resolves.toBeDefined();
    await expect(insert("/revkit/pr-8", 1)).resolves.toBeDefined();
    // …and the same log cannot hold the same seq twice.
    await expect(insert("/revkit/pr-7", 1)).rejects.toThrow(/UNIQUE constraint failed/i);
    // And a row with NO key cannot exist at all, so there is no unscoped event
    // for a query to find even if a statement forgot its predicate.
    await expect(
      harness.db
        .prepare("INSERT INTO review_logs (seq, ts, payload) VALUES (?, ?, ?)")
        .bind(99, "2026-10-04T12:00:00Z", "{}")
        .run(),
    ).rejects.toThrow(/NOT NULL/i);
  });

  test("0003: the retirement of `events` is COMPLETE — empty, and named by no statement in src/", async () => {
    // `events` cannot be renamed (D1 does not authorise
    // `sqlite_rename_table`), so the migration empties it and leaves it. An
    // empty table nobody reads is the safe shape; a table SOMEONE reads is the
    // defect this slice exists to remove. So both halves are asserted. FIRST, it
    // is empty, so a mistake returns nothing rather than a whole org's log.
    // SECOND, no statement in `src/` names it, so the mistake cannot be made
    // without a test failing here first.
    const seeded = await harness.db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    expect(seeded?.n).toBe(0);
    const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
    const srcFiles = readdirSync(srcDir).filter((f) => f.endsWith(".ts")).sort();
    expect(srcFiles.length).toBeGreaterThan(5);
    for (const file of srcFiles) {
      const text = readFileSync(join(srcDir, file), "utf8");
      // `events` as a WORD: `events_ts` and the retention prose are fine, an
      // unquoted table reference is not.
      const statement = /\b(?:FROM|INTO|UPDATE|TABLE)\s+events\b/i.exec(text);
      expect(statement, `${file} names the retired table`).toBeNull();
      // And neither is the legacy quarantine: it exists so nothing is
      // discarded, and no route may name it.
      const quarantine = /\b(?:FROM|INTO|UPDATE|TABLE)\s+events_unscoped_legacy\b/i.exec(text);
      expect(quarantine, `${file} names the quarantine`).toBeNull();
    }
  });

  test("0003: pre-existing rows are QUARANTINED, not discarded and not given a scope", async () => {
    // The question the migration has to answer rather than assume. It empties
    // `events`, copies every row into `events_unscoped_legacy`, and gives
    // neither a repository. "Nothing can mint an invite in production yet, so
    // the table is empty" is true in practice and not by construction — this
    // case is what makes the answer a decision rather than an accident.
    //
    // It re-applies the migration's own STATEMENTS on top of freshly seeded
    // legacy rows, on THIS harness — which is the production upgrade path (a
    // database at `0002` with rows in `events`) reproduced on a database that
    // has already had `0003` applied. `test/harness.ts` documents why it is not
    // a second `startWorker()`: this host kills the sixth concurrent workerd
    // instance in one `bun test` process and every later case in the file fails
    // with "Unable to connect". The re-application is safe BECAUSE the migration
    // is idempotent, which is the property the next assertions are about.
    await harness.db.prepare("DELETE FROM review_logs").run();
    await harness.db.prepare("DELETE FROM events_unscoped_legacy").run();
    try {
      await harness.db
        .prepare("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)")
        .bind(1, "2026-10-01T12:00:00Z", JSON.stringify({ seq: 1, ts: "2026-10-01T12:00:00Z" }))
        .run();
      await harness.db
        .prepare("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)")
        .bind(2, "2026-10-01T12:00:02Z", JSON.stringify({ seq: 2, ts: "2026-10-01T12:00:02Z" }))
        .run();
      for (const statement of sqlStatements(MIGRATIONS[2] as string)) {
        await harness.db.prepare(statement).run();
      }
      // Preserved, byte for byte, with its own seq — an operator who learns
      // which review those rows belonged to can put them back.
      const kept = await harness.db
        .prepare("SELECT seq, ts, payload FROM events_unscoped_legacy ORDER BY seq ASC")
        .all<{ seq: number; ts: string; payload: string }>();
      expect((kept.results ?? []).map((r) => r.seq)).toEqual([1, 2]);
      expect(kept.results?.[0]?.payload).toContain("2026-10-01T12:00:00Z");
      // The old table is empty, and the new one is empty: NOTHING was moved into
      // a review's log, because no review is known.
      expect((await harness.db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>())?.n).toBe(0);
      expect((await harness.db.prepare("SELECT COUNT(*) AS n FROM review_logs").first<{ n: number }>())?.n).toBe(0);
      // And the second half of the claim: applying the file AGAIN is a no-op
      // rather than an error, which is what `DELETE` was chosen over `DROP` for.
      for (const statement of sqlStatements(MIGRATIONS[2] as string)) {
        await harness.db.prepare(statement).run();
      }
      expect((await harness.db.prepare("SELECT COUNT(*) AS n FROM events_unscoped_legacy").first<{ n: number }>())?.n).toBe(2);
    } finally {
      // The seeded rows are this case's fixture, not state another case may
      // rely on; the migration emptied `events` itself.
      await harness.db.prepare("DELETE FROM events_unscoped_legacy").run();
    }
  });

  test("0003: the per-log retention index exists and leads with the log key", async () => {
    const indexes = await indexNames(harness.db, "review_logs");
    expect(indexes).toContain("review_logs_log_ts");
    const sql = await harness.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .bind("review_logs_log_ts")
      .first<{ sql?: string }>();
    // A sweep is always per-review, and the index has to make THAT the cheap
    // query — so `log_key` leads. A sweep that could drop the predicate would be
    // able to express "every log in this org", which is what the partition is
    // for.
    expect(sql?.sql).toMatch(/review_logs\s*\(\s*log_key\s*,\s*ts\s*\)/i);
  });

  async function indexNames(db: D1Database, table: string): Promise<string[]> {
    const rows = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
      .bind(table)
      .all<{ name: string }>();
    return (rows.results ?? []).map((r) => r.name);
  }

  // ── the shape the store depends on ────────────────────────────────────
  test("events carries seq and ts as query keys AND the full event in payload", async () => {
    // The daemon's store stores all three, and so does this one: `seq` and
    // `ts` are the two query keys (`since(after)`, and a future ADR-0015
    // retention sweep), while `payload` keeps the event whole so a row
    // parses without reassembly.
    type Column = { name: string; type: string; pk: number };
    const columns = await harness.db.prepare("PRAGMA table_info(events)").all<Column>();
    expect((columns.results ?? []).map((c) => c.name).sort()).toEqual(["payload", "seq", "ts"]);
    const seq = (columns.results ?? []).find((c) => c.name === "seq");
    expect(seq?.type).toBe("INTEGER");
    // `pk > 0` means it is part of the PRIMARY KEY, which is what makes a
    // concurrent seq collision a constraint violation rather than a
    // duplicate row.
    expect(seq?.pk).toBeGreaterThan(0);
  });

  test("the ts index exists, for parity with the daemon's store", async () => {
    const indexes = await harness.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'")
      .all<{ name: string }>();
    expect((indexes.results ?? []).map((i) => i.name)).toContain("events_ts");
  });

  async function tableNames(): Promise<string[]> {
    const rows = await harness.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();
    return (rows.results ?? []).map((row) => row.name);
  }

  function insertInvite(
    id: string,
    hash: string,
    kind: string,
    canComment = 1,
    maxBrowsers = 1,
  ): Promise<unknown> {
    return harness.db
      .prepare(
        "INSERT INTO invites (id, token_hash, repo, pr, kind, can_comment, revocable, max_browsers, expires_at, created_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(id, hash, "vig-os/revkit", null, kind, canComment, 1, maxBrowsers, "2026-10-17T12:00:00Z", "2026-10-03T12:00:00Z")
      .run();
  }
});
