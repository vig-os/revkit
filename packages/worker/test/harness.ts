// Test harness for the hosted Worker: one miniflare instance per test
// file, the real `migrations/0001_init.sql` applied to its D1, and ONE
// build of the Worker shared across the file.
//
// **Why miniflare and not `wrangler dev`.** `wrangler dev` wants an
// account and a token; miniflare is the same workerd binary with an
// in-memory D1 and no network. Nothing here contacts Cloudflare: the D1
// database is named, never created, and no `wrangler` verb runs.
//
// **Why the migration is applied by the harness rather than by the
// store.** D1 migrations are out of band in production (`wrangler d1
// migrations apply`), so `D1ThreadStore` deliberately does not run DDL on
// boot. Applying the real migration file here means the schema the tests
// exercise is the schema that ships, character for character — and it
// makes `test/schema.test.ts`'s idempotence claim (A15) about the same
// bytes rather than about a copy.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { JSON_MEDIA_TYPE } from "../src/authz.ts";
import { INVITE_TOKEN_HMAC_KEY, MIN_INVITE_TOKEN_HMAC_KEY_CHARS, inviteTokenHasher } from "../src/invite-token.ts";
import { CSRF_HEADER, SESSION_COOKIE_NAME, issueSession, type IssuedSession } from "../src/session.ts";

const PKG_ROOT = new URL("../", import.meta.url);

/**
 * Every shipped D1 migration, in filename order — which is the order
 * `wrangler d1 migrations apply` walks the directory in, so the schema the
 * tests exercise is the schema a provisioned database gets.
 *
 * **Why this is a LIST and not one file.** Slice 1 shipped `0001_init.sql`
 * with an `invites` table whose columns nothing used, and slice 3 is the code
 * that uses them plus the two tables they need (`invite_redemptions`,
 * `rate_limit_counters`). Reading `0001_init.sql` alone would have made the
 * harness apply a schema the Worker cannot run against, which is the exact
 * failure the single-file version was written to prevent.
 *
 * `MIGRATION_SQL` stays exported because `test/schema.test.ts` asserts things
 * about that one file's bytes (A15 idempotence, A16/A17's constraints, and
 * that the statement splitter loses nothing). It is `MIGRATIONS[0]` by
 * construction, so the two cannot drift. **`MIGRATIONS[2]` is the scope axis**
 * (`0003_scoped_logs.sql`, slice 5) and it is in this list, which is why a test
 * that seeds the event log cannot seed the table slice 3 shipped any more.
 */
export const MIGRATIONS: readonly string[] = Object.freeze(
  ["0001_init.sql", "0002_invites.sql", "0003_scoped_logs.sql"]
    .map((name) => readFileSync(fileURLToPath(new URL(`migrations/${name}`, PKG_ROOT)), "utf8"))
    .map((sql) => sql.toString()),
);

/** The first migration, verbatim — comments and all. */
export const MIGRATION_SQL: string = MIGRATIONS[0] as string;

/**
 * Split a SQL file into single statements.
 *
 * **Needed because D1 has three SQL entry points and they disagree.**
 * Measured on workerd 2026-05-18 (miniflare 4.20260518.0, no Cloudflare
 * account, no network):
 *
 *   - `D1Database.exec(sql)` splits on `;` AND on newlines, and rejects a
 *     chunk carrying a `--` comment. A multi-line `CREATE TABLE` fails
 *     with `incomplete input`; a leading comment fails with
 *     `SQL code did not contain a statement`. Those strings come from
 *     workerd's own SQLite binding, so this is the platform, not
 *     miniflare.
 *   - `D1Database.prepare(sql).run()` accepts BOTH multi-line statements
 *     and `--` / block comments unchanged — asserted, with the `exec()`
 *     refusal alongside it, by the "PLATFORM FACT" case in
 *     `test/schema.test.ts`. That test exists because this module's whole
 *     reason for splitting the file is that second bullet.
 *   - `wrangler d1 migrations apply <database>` splits the migrations
 *     directory with its own `splitSqlIntoStatements`, which consumes `--`
 *     and block comments and then drops empty chunks. (Read from wrangler
 *     4.93.0's `cli.js` in the nix store — a local read; no Cloudflare
 *     endpoint was contacted. Note it takes no `--file` flag; see the
 *     corrected citation in `migrations/0001_init.sql`.)
 *
 * So the harness applies the migration ONE STATEMENT AT A TIME through
 * `prepare().run()`, with NO text transformation at all: the bytes the
 * tests execute are the bytes that ship, comments included. Only the
 * SPLIT is local, and `test/schema.test.ts` pins that the split loses
 * nothing.
 *
 * The splitter tracks `--` line comments, block comments, and
 * single/double/backtick-quoted strings, so a `'...;...'` DEFAULT or a
 * `--` inside a string literal cannot produce a truncated statement.
 */
export function sqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] as string;
    const pair = sql.slice(index, index + 2);
    if (pair === "--") {
      const newline = sql.indexOf("\n", index);
      index = newline === -1 ? sql.length : newline;
      continue;
    }
    if (pair === "/*") {
      const close = sql.indexOf("*/", index + 2);
      index = close === -1 ? sql.length : close + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      current += char;
      index += 1;
      while (index < sql.length) {
        const inner = sql[index] as string;
        current += inner;
        index += 1;
        if (inner === char) break;
      }
      continue;
    }
    if (char === ";") {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = "";
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  const tail = current.trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

/** Apply every shipped migration to a D1 database, one statement at a time.
 * Idempotent by construction — every statement is `IF NOT EXISTS` — so
 * calling it twice is a no-op (A15). */
export async function applyMigration(db: D1Database): Promise<number> {
  const statements = MIGRATIONS.flatMap((sql) => sqlStatements(sql));
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
  return statements.length;
}

/** Both bundles this package's tests need, built ONCE per test process.
 *
 * **One `Bun.build` call, two entrypoints — deliberately.** Building them
 * separately makes the second call re-read every file in the graph that
 * `bun test` has already loaded, and on `bun 1.3.13` that fails with
 * `Unexpected reading file: packages/review-core/src/index.ts` (first as
 * `Unseekable reading file`). Both errors are Bun's, not revkit's; a
 * single build reads each file once and sidesteps both.
 *
 * **Why the outputs are matched BY NAME and then size-checked.** With two
 * entrypoints in one call, Bun's output order is NOT the entrypoint order,
 * so `outputs[0]` is not "the first entry". Indexing by output position
 * would have silently handed `workerBundle()` the PROBE's bundle (776 KB
 * instead of 20 KB) or the reverse, and a forbidden-pattern scan over the
 * wrong file passes just as green as one over the right file. `bundles()`
 * therefore matches on the emitted name and `A4` asserts each artefact's
 * expected magnitude, so a swapped or truncated bundle fails loudly rather
 * than being scanned.
 *
 * The flags are the ones proven to work for this graph: `browser` as the
 * target and `workerd`/`worker` as conditions. `nodejs_compat` is
 * deliberately NOT among them — `wrangler.jsonc` pins
 * `compatibility_flags: []` in the deployed Worker, and here the fact that
 * workerd has no `Buffer`/`process`/`require` to fall back on is what
 * enforces it. */
const BUILD_OPTIONS = {
  target: "browser",
  format: "esm",
  conditions: ["workerd", "worker", "browser"],
} as const;

/** Node/Bun escape hatches that must not appear in ANY bundle we ship or
 * test. Named here rather than inline so the scan has exactly one
 * definition, and so the mutation guard in `worker-runtime.test.ts` can
 * prove the scan is not vacuous by planting one. */
export const FORBIDDEN_BUNDLE_PATTERNS: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  { pattern: /require\s*\(/, what: "require(" },
  { pattern: /node:/, what: "node:" },
  { pattern: /bun:/, what: "bun:" },
  { pattern: /\bBuffer\b/, what: "Buffer" },
  { pattern: /process\.env/, what: "process.env" },
];

/** Every forbidden hit in `text`, as `"what@offset"`, one per PATTERN
 * (the first occurrence). Exported so a test can assert on the scan's own
 * behaviour, not only on its verdict. */
export function scanForForbidden(text: string): string[] {
  const hits: string[] = [];
  for (const { pattern, what } of FORBIDDEN_BUNDLE_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) hits.push(`${what}@${match.index}`);
  }
  return hits;
}

/** Every occurrence of every forbidden pattern, as `"what@offset"`. Needed
 * because the runtime probe legitimately CONTAINS one `Buffer` token — it is
 * the line that measures `typeof globalThis.Buffer` to prove the global is
 * absent — so a bundle that "must contain none" cannot be the assertion. */
export function scanAllForbidden(text: string): string[] {
  const hits: string[] = [];
  for (const { pattern, what } of FORBIDDEN_BUNDLE_PATTERNS) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))) {
      hits.push(`${what}@${match.index}`);
    }
  }
  return hits;
}

/** The shipped Worker (`src/index.ts`) and the ADR-0025 runtime probe
 * (`test/fixtures/runtime-probe.ts`), bundled for the workers runtime. */
export interface Bundles {
  readonly worker: string;
  readonly probe: string;
}

let bundlesPromise: Promise<Bundles> | undefined;

export function bundles(): Promise<Bundles> {
  bundlesPromise ??= (async () => {
    const result = await Bun.build({
      target: BUILD_OPTIONS.target,
      format: BUILD_OPTIONS.format,
      conditions: [...BUILD_OPTIONS.conditions],
      entrypoints: [
        fileURLToPath(new URL("src/index.ts", PKG_ROOT)),
        fileURLToPath(new URL("test/fixtures/runtime-probe.ts", PKG_ROOT)),
      ],
      naming: { entry: "[name].mjs" },
    });
    if (!result.success) {
      throw new Error(`worker bundle failed:\n${result.logs.map(String).join("\n")}`);
    }
    const byName = new Map<string, string>();
    for (const output of result.outputs) {
      const text = await output.text();
      byName.set(output.path.split("/").pop() ?? output.path, text);
    }
    const worker = byName.get("index.mjs");
    const probe = byName.get("runtime-probe.mjs");
    if (worker === undefined || probe === undefined) {
      throw new Error(
        `worker bundle produced unexpected outputs: ${[...byName.keys()].join(", ")} (wanted index.mjs and runtime-probe.mjs)`,
      );
    }
    return { worker, probe };
  })();
  return bundlesPromise;
}

/** The shipped Worker entry's bundle.
 *
 * **Large, and that is the point.** From M4 slice 2 `GET /api/threads`
 * constructs a real `D1ThreadStore` and reduces a real log, so the bundler
 * keeps `d1-store.ts` — and with it the whole `@revkit/review-core` graph —
 * in this artefact. Measured ~807 KB, against ~20 KB while slice 1 kept the
 * route closed. That is what the PLATFORM has to load in production, and it
 * means ADR-0025's "the same core serves all three surfaces" is now a claim
 * about the deployed artefact and not only about a test probe.
 *
 * The probe bundle stays as well: it is the graph EXECUTED inside workerd
 * with the same empty `compatibility_flags`, and the two are scanned
 * separately because they are different files. */
export async function workerBundle(): Promise<string> {
  return (await bundles()).worker;
}

/** The runtime-probe bundle — ADR-0025's gate, dispatched through its own
 * miniflare so the probe never becomes a route on the shipped Worker. It is
 * the second runtime the shared graph is MEASURED in, and the only artefact
 * that legitimately CONTAINS a `Buffer` token: its own measurement that the
 * global is absent. */
export async function probeBundle(): Promise<string> {
  return (await bundles()).probe;
}

// ── session helpers ───────────────────────────────────────────────────────

/**
 * Mint a session the way the ONLY current issuer does.
 *
 * `issueSession` has no HTTP caller by design (`src/session.ts`'s header
 * explains why: a route that hands a session to whoever asks is an
 * unauthenticated endpoint, and a secret-gated one cannot be built or tested
 * without provisioning, #34). Tests call the same function `revkit deploy
 * init` will call, against the same D1 database the Worker reads, so an
 * authorized request here is authorized for the same reason a production one
 * will be: a row exists, it is unexpired, and its identity kind is one the
 * gate honours.
 */
export async function issueTestSession(
  db: D1Database,
  options: { readonly ttlMs?: number } = {},
): Promise<IssuedSession> {
  return issueSession(db, { kind: "operator", id: "operator" }, options);
}

/** Just the `Cookie` header value for a session. */
export function cookieHeader(sessionId: string): string {
  return `${SESSION_COOKIE_NAME}=${sessionId}`;
}

/** Every header an authorized request needs: the cookie, plus the CSRF token
 * for the state-changing ones. Built in one place so a test cannot
 * accidentally authorize half a call. */
export function authHeaders(issued: IssuedSession): Record<string, string> {
  return { cookie: cookieHeader(issued.sessionId), [CSRF_HEADER]: issued.csrfToken };
}

/** `Content-Type` for a state-changing call. ADR-0012 accepts only
 * `application/json`, so even a body-less POST has to declare it. */
export const JSON_HEADERS: Readonly<Record<string, string>> = { "content-type": JSON_MEDIA_TYPE };

// ── invite helpers ────────────────────────────────────────────────────────

/**
 * Every table a case can leave state in, cleared. The per-test reset, so a case
 * cannot pass because a previous case left a redemption, a guest, a rate-limit
 * counter or a comment behind — and `sessions` for the same reason: a guest
 * session from case N must not authorize case N+1.
 *
 * **`review_logs` IS cleared here, and that is the sixth statement.** Slice 5
 * first wrote a comment here saying the log was deliberately NOT wiped, on the
 * reasoning that the log is partitioned by scope since `0003_scoped_logs.sql` so
 * a case should clear exactly its own key — and then added the wipe four lines
 * below the comment, because a whole-table wipe is what the OTHER files' fixtures
 * (`test/d1-store.test.ts`, `test/worker-runtime.test.ts`, this file's own scope
 * cases) actually need. Two adjacent comments claiming opposite things is worse
 * than either alone: it would have misled whoever next weighed a seventh
 * statement.
 *
 * **So, the settled rule, stated once:** `resetInvites` clears every table a case
 * may write, INCLUDING `review_logs`, wholesale. A case that wants to touch only
 * one review's log — which is what a scope-isolation case is FOR, since a
 * neighbouring review's rows are the thing it is asserting about — clears its own
 * key with a scoped `DELETE` (see `seedLog` in `test/authorization.test.ts` and
 * `seedReview` in `test/invites.test.ts`). Both are correct at their own scope;
 * neither contradicts the other, and this paragraph says which is which.
 *
 * The cost is real and measured: six statements in the `beforeEach` of a
 * 120-test file, on a host where that file's timing is already close to bun's
 * per-test timeout (see the workerd-instance note at the top of this file).
 */
export async function resetInvites(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM review_logs").run();
  await db.prepare("DELETE FROM invite_redemptions").run();
  await db.prepare("DELETE FROM rate_limit_counters").run();
  await db.prepare("DELETE FROM invites").run();
  await db.prepare("DELETE FROM guests").run();
  await db.prepare("DELETE FROM sessions").run();
}

/** The name/value pair out of a `Set-Cookie` header value, so a test can build
 * the `Cookie` header a browser would send without a browser. */
/**
 * One stored `comment.created` event, as the JSON blob `review_logs.payload`
 * holds.
 *
 * **This exists because four test files were each spelling the same eight-line
 * object literal.** `guardrails/duplication` measured that literal at exactly
 * four sites once slice 5 added `invites.test.ts`'s scope fixture, three of them
 * since slice 1. A hand-written payload is also a place for the schema to drift:
 * `reviewEventSchema.parse` is what reads it, so a fixture that quietly stopped
 * being a valid event would fail as a store error rather than as a fixture error.
 * Building it here means one shape, one anchor, one actor.
 *
 * **What it did NOT fix, stated so the number is not over-read.** `duplication`
 * still reports **four clone groups** in this package, and slice 5 reduced that
 * from **six at the base commit** — it did not reach zero. Two of the four are in
 * `test/invites.test.ts` and are a DIFFERENT duplication from the one this
 * extraction fixed: a ~71-line test case that appears twice in that file (in the
 * D1 half and the HTTP half), and a six-line pair in its `invite scope` describe.
 * Both pre-date slice 5 and neither is about event payloads. The gate is advisory
 * (exit 0) and nothing is blessed with `guardrails-ok`; this paragraph is here so
 * the next reader counts the gate's output against a claim that matches it.
 *
 * The `ts` is derived from `seq`, so a multi-event log's timestamps increase —
 * which is what ADR-0015's retention sweep reads.
 */
export function seedReviewEvent(options: {
  readonly seq: number;
  readonly threadId: string;
  readonly commentId: string;
  readonly body?: string;
}): { readonly ts: string; readonly payload: string } {
  const ts = `2026-10-04T12:00:${String(options.seq).padStart(2, "0")}Z`;
  return {
    ts,
    payload: JSON.stringify({
      seq: options.seq,
      ts,
      actor: { kind: "gh-user", id: "gerchowl" },
      kind: "comment.created",
      threadId: options.threadId,
      commentId: options.commentId,
      anchor: {
        path: "docs/a.mdx",
        startLine: 1,
        endLine: 1,
        quote: { exact: "x", prefix: "", suffix: "" },
        revision: "b".repeat(64),
      },
      body: options.body ?? "seeded review comment",
    }),
  };
}

/**
 * Insert `count` events into ONE review's log, at consecutive seqs.
 *
 * `logKey` is the store's own key, so a fixture cannot seed a log the store is
 * not pointed at — which is the point of slice 5: a fixture that writes somebody
 * else's log is how a scope test passes for the wrong reason.
 */
export async function seedLogEvents(
  db: D1Database,
  logKey: string,
  count: number,
  options: { readonly prefix?: string; readonly body?: string; readonly from?: number } = {},
): Promise<void> {
  const from = options.from ?? 1;
  for (const seq of Array.from({ length: count }, (_unused, index) => from + index)) {
    const event = seedReviewEvent({
      seq,
      threadId: `${options.prefix ?? "th-seed"}-${seq}`,
      commentId: `c-${options.prefix ?? "th-seed"}-${seq}`,
      ...(options.body === undefined ? {} : { body: options.body }),
    });
    await db
      .prepare("INSERT INTO review_logs (log_key, seq, ts, payload) VALUES (?, ?, ?, ?)")
      .bind(logKey, seq, event.ts, event.payload)
      .run();
  }
}

export function cookieValue(setCookie: string): string {
  const first = (setCookie.split(";")[0] ?? "").trim();
  const equals = first.indexOf("=");
  return equals === -1 ? "" : first.slice(0, equals);
}

/** The value out of a `Set-Cookie`, by cookie NAME — which is what a test
 * asserting "the redeem response set the browser cookie" actually wants, and
 * it cannot be satisfied by the session cookie by accident. */
export function setCookieValue(setCookie: string, name: string): string | undefined {
  for (const part of setCookie.split(/,\s*(?=[A-Za-z0-9_-]+=)/)) {
    const pair = (part.split(";")[0] ?? "").trim();
    if (!pair.startsWith(`${name}=`)) continue;
    return pair.slice(name.length + 1);
  }
  return undefined;
}

/**
 * The HMAC key the offline harness binds. A FIXED literal, not a random one,
 * because a test that asserts "this token hashes to that digest" needs the key
 * to be knowable; nothing here depends on the key being secret, and the real one
 * is a Worker secret provisioned by `revkit deploy init` (slice 8, #34).
 *
 * It is long enough to clear `MIN_INVITE_TOKEN_HMAC_KEY_CHARS`, and it is
 * visibly not a production value — the point of a fixed literal is that a reader
 * can see it is a test input.
 */
export const TEST_INVITE_TOKEN_HMAC_KEY = "revkit-offline-test-invite-token-hmac-key-000000000000";

/** The same key as a hasher, for the D1-level cases that call `mintInvite`,
 * `loadInviteByToken` and `redeemInvite` directly rather than over HTTP. */
export async function testTokenHasher(): Promise<ReturnType<typeof inviteTokenHasher>> {
  return inviteTokenHasher(TEST_INVITE_TOKEN_HMAC_KEY);
}

/** A running miniflare plus its D1 handle. */
export interface Harness {
  readonly mf: Miniflare;
  /** The D1 database the Worker sees as `env.DB`. */
  readonly db: D1Database;
  /** Dispatch a request through the real workerd, exactly as the
   * platform would. The `init` type is miniflare's OWN `RequestInit`:
   * `bun`'s and `@cloudflare/workers-types`' declarations of the DOM
   * `RequestInit` disagree on `body`'s type, and pinning the harness to
   * one of them would import that disagreement into every call site. */
  readonly dispatch: (
    input: string,
    init?: Parameters<Miniflare["dispatchFetch"]>[1],
  ) => ReturnType<Miniflare["dispatchFetch"]>;
  dispose(): Promise<void>;
}

/** `wrangler.jsonc` as plain JSON. The comments are stripped with a
 * string-aware scanner rather than a regex, because a naive `//`-split
 * would corrupt any value containing `//` — and the shipped file's own
 * comments are full of `https://`. `test/worker-config.test.ts` asserts
 * the stripped form still parses to the same values the file declares,
 * so this cannot quietly read a different config than the one that ships. */
export function readWranglerConfig(): Record<string, unknown> {
  return JSON.parse(stripJsonComments(readFileSync(fileURLToPath(new URL("wrangler.jsonc", PKG_ROOT)), "utf8")));
}

function stripJsonComments(source: string): string {
  let out = "";
  let index = 0;
  let inString = false;
  while (index < source.length) {
    const char = source[index] as string;
    const pair = source.slice(index, index + 2);
    if (inString) {
      out += char;
      if (char === "\\") {
        out += source[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (pair === "//") {
      const newline = source.indexOf("\n", index);
      index = newline === -1 ? source.length : newline;
      continue;
    }
    if (pair === "/*") {
      const close = source.indexOf("*/", index + 2);
      index = close === -1 ? source.length : close + 2;
      continue;
    }
    if (char === '"') inString = true;
    out += char;
    index += 1;
  }
  return out;
}

/** Start a miniflare serving `src/index.ts`, with `0001_init.sql`
 * already applied. Each call gets its own in-memory D1, so tests are
 * isolated and order-independent.
 *
 * The compatibility date, the compatibility flags and the `vars` all come
 * from `wrangler.jsonc` rather than from literals here. That is not
 * tidiness: an earlier revision hard-coded them, the harness and the
 * shipped config silently disagreed about which vars exist, and every
 * request 500'd on a missing `REVKIT_VERSION` while `wrangler.jsonc`
 * looked fine. One source for both is the only version of this that
 * cannot drift. */
export async function startWorker(
  options: {
    readonly script?: string;
    /** Override the `vars` from `wrangler.jsonc`. `null` means bind
     * NOTHING, which is how a test provokes the handler's catch block:
     * `REVKIT_VERSION` is read while building the header context, so a
     * Worker deployed without it throws before any route runs — the
     * misconfigured-deploy shape, driven rather than described. */
    readonly vars?: Record<string, string> | null;
    /** Override `INVITE_TOKEN_HMAC_KEY`, the invite-token HMAC key. `null`
     * means bind NOTHING for it, which is how the missing-secret shape is
     * driven rather than described. */
    readonly inviteTokenKey?: string | null;
  } = {},
): Promise<Harness> {
  const config = readWranglerConfig();
  const vars = options.vars === undefined ? (config["vars"] as Record<string, string>) : options.vars;
  // The key arrives through `bindings`, NOT through miniflare's `secrets`
  // option — miniflare 4.20260518.0 IGNORES `secrets` (measured:
  // `env.INVITE_TOKEN_HMAC_KEY` came back `undefined` with
  // `secrets: { … }`, and the same value through `bindings` came back as the
  // string). Slice 3's first cut read that measurement as "a keyed hash is
  // verified nowhere"; the correct reading is "the harness was wrong", because
  // `wrangler secret put` also lands in `env` and from inside the Worker the two
  // are indistinguishable. `REVKIT_VERSION` was already supplied this way.
  const key = options.inviteTokenKey === undefined ? TEST_INVITE_TOKEN_HMAC_KEY : options.inviteTokenKey;
  const bindings = { ...(vars ?? {}), ...(key === null ? {} : { [INVITE_TOKEN_HMAC_KEY]: key }) };
  const mf = new Miniflare({
    modules: true,
    script: options.script ?? (await workerBundle()),
    compatibilityDate: config["compatibility_date"],
    compatibilityFlags: config["compatibility_flags"],
    bindings: Object.keys(bindings).length === 0 ? undefined : bindings,
    d1Databases: { DB: `revkit-test-${Math.random().toString(36).slice(2)}` },
  } as MiniflareOptions);
  // Boot timing, on demand. `getD1Database` is where a miniflare instance
  // actually starts workerd and opens its D1 session — measured at 102 ms
  // median over 30 consecutive boots, with a 168 ms worst case and no spike
  // above 1 s. That is the number to suspect when a whole worker-leg run is
  // bimodal (observed: 5.9 s typical, 26 s and 38 s twice in 45 runs on a
  // host at loadavg 30), so the harness prints the per-boot cost when
  // REVKIT_WORKER_BOOT_LOG=1 is set rather than leaving it to be guessed at.
  //
  // **Keep the number of instances low, and here is the measurement for why.**
  // Slice 2 re-opened `GET /api/threads`, so the shipped entry stopped being
  // tree-shaken and every default `startWorker()` began loading an ~807 KB
  // module graph instead of a ~20 KB one. Nothing about THAT is slow — 14
  // sequential boots of the 807 KB bundle in a plain `bun run` take 265-445 ms
  // each, no failures — but under `bun test` on this host (loadavg 31, six
  // users) the suite became DETERMINISTICALLY stuck: whichever test file ran
  // after `worker-runtime.test.ts` would sit in `getD1Database` forever, bun
  // would print "killed 1 dangling process", and a `--timeout 30000` run did
  // not help, so it was a hang and not a slow boot. Bisected to the instance
  // COUNT rather than the size: 5 boots in one file plus one more was the
  // cliff, and `worker-runtime.test.ts` was creating five (harness, probe, and
  // three more for its misconfigured-deploy cases).
  //
  // The fix was to make that file create THREE — not by deleting cases, but by
  // reusing the `harness` it already had as the healthy control for the
  // "same script, only the var differs" case, which is a STRONGER control
  // (identical bytes by construction) and two fewer workerd spawns. The suite
  // has been green and stable across 12+ consecutive runs since.
  //
  // The mechanism behind the cliff was NOT identified. What is pinned is the
  // observable: the budget, and the fact that raising it fixes it. Do not read
  // this as "miniflare is broken" — it is a note about how many 800 KB
  // workerd instances this host tolerates inside one `bun test`.
  const bootStarted = performance.now();
  const db = await mf.getD1Database("DB");
  const dbReady = performance.now();
  await applyMigration(db);
  if (process.env["REVKIT_WORKER_BOOT_LOG"] === "1") {
    const ms = (dbReady - bootStarted).toFixed(0);
    process.stderr.write(`[harness] workerd+D1 ready in ${ms}ms (migrated by ${(performance.now() - dbReady).toFixed(0)}ms)\n`);
  }
  return {
    mf,
    db,
    dispatch: (input, init) => mf.dispatchFetch(input, init),
    dispose: () => mf.dispose(),
  };
}
