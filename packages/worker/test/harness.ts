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

const PKG_ROOT = new URL("../", import.meta.url);

/** The shipped D1 migration, verbatim — comments and all. */
export const MIGRATION_SQL: string = readFileSync(
  fileURLToPath(new URL("migrations/0001_init.sql", PKG_ROOT)),
  "utf8",
);

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
 *   - `wrangler d1 migrations apply --file=...` splits with its own
 *     `splitSqlIntoStatements`, which consumes `--` and block comments
 *     and then drops empty chunks. (Read from wrangler 4.93.0's
 *     `cli.js` in the nix store — a local read; no Cloudflare endpoint
 *     was contacted.)
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

/** Apply the shipped migration to a D1 database, one statement at a
 * time. Idempotent by construction — every statement is
 * `IF NOT EXISTS` — so calling it twice is a no-op (A15). */
export async function applyMigration(db: D1Database): Promise<number> {
  const statements = sqlStatements(MIGRATION_SQL);
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
 * **Small, and that is correct.** `GET /api/threads` is closed (ADR-0012
 * authorization), so nothing reachable from `src/index.ts` constructs a
 * `D1ThreadStore` any more and the bundler tree-shakes `d1-store.ts` — and
 * with it the whole `@revkit/review-core` graph — out of this artefact.
 * Measured: ~20 KB, against ~790 KB while the route was open. So this
 * bundle is what the PLATFORM has to load, and ADR-0025's "the core runs in
 * workerd" claim is proven against `probeBundle()` instead, which is the
 * same graph reached through a route that is not part of the shipped
 * surface. */
export async function workerBundle(): Promise<string> {
  return (await bundles()).worker;
}

/** The runtime-probe bundle — ADR-0025's gate, dispatched through its own
 * miniflare so the probe never becomes a route on the shipped Worker. This
 * is the artefact that CONTAINS `@revkit/review-core` and `d1-store.ts`,
 * which is why the forbidden-pattern scan has to run over both. */
export async function probeBundle(): Promise<string> {
  return (await bundles()).probe;
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
export async function startWorker(options: { readonly script?: string } = {}): Promise<Harness> {
  const config = readWranglerConfig();
  const mf = new Miniflare({
    modules: true,
    script: options.script ?? (await workerBundle()),
    compatibilityDate: config["compatibility_date"],
    compatibilityFlags: config["compatibility_flags"],
    bindings: config["vars"],
    d1Databases: { DB: `revkit-test-${Math.random().toString(36).slice(2)}` },
  } as MiniflareOptions);
  const db = await mf.getD1Database("DB");
  await applyMigration(db);
  return {
    mf,
    db,
    dispatch: (input, init) => mf.dispatchFetch(input, init),
    dispose: () => mf.dispose(),
  };
}
