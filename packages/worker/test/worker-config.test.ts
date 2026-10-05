// `wrangler.jsonc` as a TESTED contract (A28), not a reviewed file.
//
// One line here is load-bearing for ADR-0025: `compatibility_flags: []`.
// With no `nodejs_compat` the platform refuses a Node-only import and
// provides no `Buffer`/`process`/`require`, so a regression goes red on the
// first affected request rather than in production. A lint can be bypassed
// and a missing global cannot.
//
// The other line, `workers_dev: false`, is a **TRIPWIRE AND NOTHING MORE**,
// and the distinction is the whole point of this header:
//
//   - It is NOT an authorization check. The authorization this Worker
//     performs is: none.
//   - It evaporates the moment slice 3 or slice 5 adds a `routes` entry, or
//     anyone runs `wrangler dev --remote`, which ignores it entirely.
//   - It does NOT protect `/api/threads` today, because `/api/threads`
//     answers 501 for every verb (see `src/index.ts`). The route is closed
//     by CODE; this flag only means a mistake elsewhere has no public URL to
//     be wrong on.
//
// So the absence assertions below are a tripwire against a careless deploy,
// and must never be read as evidence that a request was authorized. The
// test that a route is closed is in `worker-runtime.test.ts`, where the
// handler's own 501 is asserted against a non-empty log.
//
// ADR-0014's absence assertions matter just as much as the compatibility
// ones: no secret exists in this repo, and "no secret-shaped value in the
// config or the package" is the part of that a local test can enforce before
// any secret does.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { readWranglerConfig } from "./harness.ts";

const PKG_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CONFIG = readWranglerConfig();
const RAW = readFileSync(join(PKG_ROOT, "wrangler.jsonc"), "utf8");
const CLI_VERSION = (JSON.parse(readFileSync(join(PKG_ROOT, "../cli/package.json"), "utf8")) as { version: string })
  .version;

describe("wrangler.jsonc", () => {
  // ── the runtime gate ──────────────────────────────────────────────────
  test("compatibility_flags is present and EMPTY", () => {
    // Present-and-empty, not absent: an absent key means "whatever
    // wrangler defaults to", and the default is not a decision anyone
    // made on purpose.
    expect(Object.keys(CONFIG)).toContain("compatibility_flags");
    expect(CONFIG["compatibility_flags"]).toEqual([]);
    const raw = CONFIG["compatibility_flags"] as string[];
    expect(raw.some((flag) => flag.includes("nodejs_compat"))).toBe(false);
  });

  test("main points at the Worker entry that the tests actually bundle", () => {
    expect(CONFIG["main"]).toBe("src/index.ts");
  });

  test("compatibility_date is pinned, not floating", () => {
    expect(CONFIG["compatibility_date"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // ── the reachability gate ─────────────────────────────────────────────
  test("workers_dev is FALSE — a tripwire, so a mistaken deploy has no public URL", () => {
    // Read the file's own comment before "fixing" this to true.
    expect(CONFIG["workers_dev"]).toBe(false);
  });

  test("no routes and no custom domain — and this is what would void the tripwire", () => {
    // If a future slice adds a `routes` entry for previews, `workers_dev:
    // false` stops protecting anything, so the two have to be read together
    // and the reason has to be re-argued at the time. Asserted separately
    // from the flag above so flipping one without the other is visible.
    for (const key of ["routes", "account_id", "custom_domains", "dispatch_namespace"]) {
      expect(Object.keys(CONFIG)).not.toContain(key);
    }
  });

  test("no `triggers` — ADR-0015's cron is deferred BECAUSE this harness cannot exercise one", () => {
    // **This is the config half of a platform fact, and the two halves are one
    // decision.** A Cloudflare Cron Trigger is declared here and nowhere else, so
    // a `triggers.crons` line in this file would be a claim no test in this repo
    // could check: miniflare dispatches `fetch`, and a `scheduled` event is a
    // separate entry point. That is ADR-0015's stated reason for not wiring the
    // schedule, and it is measured — not asserted — by `test/invites.test.ts`'s
    // "PLATFORM FACT: this harness cannot dispatch a `scheduled` event" case,
    // which fails the day miniflare grows the capability.
    //
    // So this case and that one go red at the SAME moment, from the same cause,
    // and between them they say what to do: add the handler, drive it in a test,
    // and only then declare the trigger. Adding the line first is the untestable
    // claim, which is exactly what the deferral declines to ship.
    //
    // Until then the gap is real and stated in ADR-0015: **guests are retained
    // indefinitely** — the wrong direction for a privacy clock. `revkit deploy
    // status` (slice 7) is where an operator learns no sweep is running.
    expect(Object.keys(CONFIG)).not.toContain("triggers");
  });

  test("the raw file declares none of them either, so a commented-out key cannot ship", () => {
    // Matched as JSON KEYS, not as bare words: this file's own comment
    // legitimately names every one of them to explain why it is absent,
    // and a test that failed on the explanation would push the next author
    // to delete the explanation instead of the key. `triggers` is in the list
    // for the reason above; the RAW check is what stops
    // `"triggers": { /* … */ }` from shipping while the parsed form is clean.
    for (const key of ["account_id", "routes", "custom_domains", "dispatch_namespace", "triggers"]) {
      expect(RAW).not.toContain(`"${key}"`);
    }
    expect(RAW).not.toContain('"workers_dev": true');
  });

  // ── A28: nothing secret-looking ───────────────────────────────────────
  test("A28: no var value looks like a credential", () => {
    const vars = (CONFIG["vars"] ?? {}) as Record<string, string>;
    const names = Object.keys(vars);
    expect(names.length).toBeGreaterThan(0);
    for (const [name, value] of Object.entries(vars)) {
      expect(name.toLowerCase()).not.toMatch(/secret|token|password|key|credential|cookie/);
      // A secret SHAPE, not just a secret-looking name: a base64/hex blob,
      // or any GitHub/Cloudflare token prefix.
      expect(value).not.toMatch(/gh[pousr]_[A-Za-z0-9]{16,}/);
      expect(value).not.toMatch(/github_pat_/);
      expect(value).not.toMatch(/^[A-Za-z0-9+/]{32,}={0,2}$/);
      expect(value.length).toBeLessThan(64);
    }
  });

  test("A28: no secret VALUE lives in this package, and the D1 schema stores only field NAMES", () => {
    // ADR-0014: no secret in a tracked file. The database has columns
    // named `csrf_hash` and `token_hash` — field names in a schema that
    // stores hashes, which is the correct design, not a leak. What must
    // not exist is a VALUE. So the strong assertion is on secret SHAPES,
    // and the field-name claim is asserted separately and precisely,
    // against the migration rather than against prose.
    const pattern = /secret|token|password/i;
    const secretShape = /gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|\b[A-Za-z0-9+/]{40,}={0,2}\b/;
    let matched = 0;
    for (const file of trackedSourceFiles()) {
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, index) => {
        if (!pattern.test(line)) return;
        matched += 1;
        expect(
          secretShape.test(line),
          `${file.slice(PKG_ROOT.length)}:${index + 1} carries a secret-shaped value: ${line.trim()}`,
        ).toBe(false);
      });
    }
    // The scan is not vacuous: the schema and the redactor really do talk
    // about tokens and secrets, so this walks real hits.
    expect(matched).toBeGreaterThan(0);
  });

  test("A28: every token-ish mention in the D1 schema is a column or an index, not a value", () => {
    const migration = readFileSync(join(PKG_ROOT, "migrations/0001_init.sql"), "utf8");
    const mentions = migration
      .split("\n")
      .filter((line) => /secret|token|password/i.test(line))
      .map((line) => line.trim());
    expect(mentions.length).toBeGreaterThan(0);
    for (const mention of mentions) {
      // Either a column declaration, or a comment sentence explaining the
      // column. A `token_hash` VALUE would appear as a quoted literal.
      expect(mention).toMatch(/^(--.*)?$|token_hash|csrf_hash/);
      expect(mention).not.toMatch(/'[^']{16,}'/);
    }
  });

  test("A28: the placeholder database id is an obvious placeholder, not a plausible fake", () => {
    // `wrangler d1 create` is owner-gated (#34), so the id is filled in by
    // `revkit deploy init`. A plausible-looking UUID would make a
    // misconfigured deploy fail confusingly much later; an obvious
    // placeholder fails immediately and says why.
    const bindings = CONFIG["d1_databases"] as { binding: string; database_id: string }[];
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.binding).toBe("DB");
    expect(bindings[0]?.database_id).toBe("PLACEHOLDER_REPLACED_BY_REVKIT_DEPLOY_INIT");
    expect(bindings[0]?.database_id).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  // ── the preview bucket: the binding NAME is a contract, the resource is not ──
  test("`PREVIEWS` is declared, once, and nothing writes to it", () => {
    // The half of the preview surface that can be wrong offline is the BINDING
    // NAME: `src/index.ts` reads `env.PREVIEWS.get`, so a rename here is a 500 on
    // every preview path in a deployment that looks correct in review. Asserted
    // the way the D1 binding is — by name, from the parsed file, not from prose.
    const buckets = CONFIG["r2_buckets"] as { binding: string; bucket_name: string }[];
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.binding).toBe("PREVIEWS");
    expect(buckets[0]?.bucket_name).toBe("revkit-previews");
    // `bucket_name` is a NAME rather than an id, so there is no id to be an
    // obvious placeholder — and **nothing has created a bucket with it.** That is
    // deliberate and out of scope: provisioning is `wrangler r2 bucket create`,
    // which needs an account (#130). A deployment whose bucket does not exist
    // fails loudly at the binding, and one whose bucket is empty answers 404 on
    // every preview path — the honest answer for a review nothing was built for.
  });

  // ── ADR-0021: one version ─────────────────────────────────────────────
  test("the invite-token HMAC key is NAMED but never DECLARED", async () => {
    // ADR-0012's "stored as HMAC" needs a key, and ADR-0014 says no secret goes
    // in a tracked file. Those two only reconcile if the binding is named here
    // and its VALUE is not — a Worker secret reaches `env` by name, so the name
    // is public and the value never is. Asserting both halves: a deploy that
    // forgot the secret must fail loudly (asserted in `test/invites.test.ts`),
    // and this file must never become where someone pastes the secret to make
    // that go away.
    const { INVITE_TOKEN_HMAC_KEY, MIN_INVITE_TOKEN_HMAC_KEY_CHARS } = await import("../src/invite-token.ts");
    const vars = (CONFIG["vars"] ?? {}) as Record<string, string>;
    expect(Object.keys(vars)).not.toContain(INVITE_TOKEN_HMAC_KEY);
    expect(RAW).toContain(INVITE_TOKEN_HMAC_KEY); // the comment says why
    // And no `vars` value is long enough to BE a key, which is the shape a
    // pasted secret would take.
    for (const value of Object.values(vars)) {
      expect(value.length, "a vars value this long is a pasted secret").toBeLessThan(MIN_INVITE_TOKEN_HMAC_KEY_CHARS);
    }
    // `secrets_store` would put the secret's *name* in this file as well; it is
    // not used, and asserting its absence keeps that a decision.
    expect(Object.keys(CONFIG)).not.toContain("secrets_store");
  });

  test("REVKIT_VERSION matches the CLI's version, so the release train cannot drift them apart", () => {
    const vars = (CONFIG["vars"] ?? {}) as Record<string, string>;
    expect(vars["REVKIT_VERSION"]).toBe(CLI_VERSION);
  });

  test("the JSONC comment stripper reads the file, not a mangled copy of it", () => {
    // The harness strips comments to parse this file; if the stripper were
    // wrong the tests would be asserting against a different config than
    // the one that ships. The file is comment-heavy on purpose, so this
    // proves the parse is faithful on a config that really has comments.
    expect(RAW).toContain("//");
    expect(CONFIG["name"]).toBe("revkit-review");
    expect(typeof CONFIG["compatibility_date"]).toBe("string");
  });
});

/** Every `.ts` / `.sql` / `.jsonc` / `.json` / `.md` file in the package,
 * so the A28 scan covers source, schema, config and docs alike. */
function trackedSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules") continue;
        walk(full);
        continue;
      }
      if (/\.(ts|sql|jsonc|json|md)$/.test(entry)) out.push(full);
    }
  };
  walk(PKG_ROOT);
  return out;
}
