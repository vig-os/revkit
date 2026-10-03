// `wrangler.jsonc` as a TESTED contract (A28), not a reviewed file.
//
// Everything this slice's safety rests on lives in two lines of config that
// nothing else would catch:
//
//   `compatibility_flags: []` — no `nodejs_compat`, so the platform refuses
//   a Node-only import instead of a lint noticing it next quarter.
//
//   `workers_dev: false` — with no `routes` either, this Worker has NO
//   public URL until `revkit deploy init` provisions one. That is what
//   makes slice 1's unauthenticated `GET /api/threads` unreachable rather
//   than merely undocumented; slice 2's sessions land before provisioning
//   does, so there is no window where an unauthorised read is live.
//
// Both are invisible to the type checker and to the test suite, which is
// exactly why they are asserted here. The absence assertions matter just
// as much as the presence ones: ADR-0014's rule is that no secret exists
// in this repo, and "no secret-looking value in the config" is the part of
// that a local test can enforce before any secret does.

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
  test("workers_dev is FALSE — the Worker has no *.workers.dev URL", () => {
    expect(CONFIG["workers_dev"]).toBe(false);
  });

  test("no routes, no custom domain, no account id", () => {
    for (const key of ["routes", "account_id", "custom_domains", "dispatch_namespace"]) {
      expect(Object.keys(CONFIG)).not.toContain(key);
    }
  });

  test("the raw file declares none of them either, so a commented-out key cannot ship", () => {
    // Matched as JSON KEYS, not as bare words: this file's own comment
    // legitimately names every one of them to explain why it is absent,
    // and a test that failed on the explanation would push the next author
    // to delete the explanation instead of the key.
    for (const key of ["account_id", "routes", "custom_domains", "dispatch_namespace"]) {
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

  // ── ADR-0021: one version ─────────────────────────────────────────────
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
