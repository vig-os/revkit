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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MIGRATION_SQL, applyMigration, sqlStatements, startWorker, type Harness } from "./harness.ts";

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
