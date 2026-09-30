#!/usr/bin/env bun
// Introspect the live GitHub GraphQL schema (read-only) and validate
// every document the adapter sends against it. Writes the schema
// as SDL to `test/fixtures/github/graphql-schema.graphql` so the
// offline unit test (`test/graphql-schema.test.ts`) can run the
// same check in CI without a network.
//
// **Read-only.** Uses the standard introspection query
// (`__schema { ... }`) — no mutations. The adapter's write
// operations are only *validated* (parsed + checked against the
// schema), never executed.
//
// Run locally after any query/mutation change (mutation input
// rename, new field selection):
//
//     nix develop -c bash -c "cd packages/review-core && bun scripts/validate-github-graphql.ts"
//
// Requires `gh auth token` (the same TokenSource M3 uses).

import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  buildClientSchema,
  buildSchema,
  getIntrospectionQuery,
  parse,
  printSchema,
  validate,
  type IntrospectionQuery,
} from "graphql";
import { GITHUB_GRAPHQL_DOCUMENTS } from "../src/github-adapter.ts";

const GRAPHQL_URL = "https://api.github.com/graphql";
const SCHEMA_PATH = new URL("../test/fixtures/github/graphql-schema.graphql", import.meta.url).pathname;

function readGhToken(): string {
  const result = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`gh auth token failed (${result.status}): ${result.stderr}`);
  }
  const token = result.stdout.trim();
  if (token.length === 0) throw new Error("gh auth token returned empty output");
  return token;
}

async function introspect(token: string): Promise<IntrospectionQuery> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "revkit-schema-validator/0.0",
    },
    body: JSON.stringify({ query: getIntrospectionQuery() }),
  });
  if (!res.ok) throw new Error(`introspection failed: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { data?: IntrospectionQuery; errors?: Array<{ message: string }> };
  if (body.errors !== undefined && body.errors.length > 0) {
    throw new Error(`introspection errors: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (body.data === undefined) throw new Error("introspection returned no data");
  return body.data;
}

/** Strip descriptions from the introspection then convert to SDL.
 * SDL is more compact than JSON, and GitHub's docstrings dominate
 * the file size — stripping them shrinks the fixture from ~3 MB
 * to something committable. Everything we need for validation
 * (field names, types, arguments, enum values) is preserved. */
function toStrippedSdl(introspection: IntrospectionQuery): string {
  const clone = JSON.parse(JSON.stringify(introspection)) as IntrospectionQuery;
  const stripDesc = (x: unknown): void => {
    if (x === null || typeof x !== "object") return;
    if (Array.isArray(x)) {
      for (const item of x) stripDesc(item);
      return;
    }
    const obj = x as Record<string, unknown>;
    if ("description" in obj) delete obj.description;
    if ("deprecationReason" in obj) delete obj.deprecationReason;
    for (const v of Object.values(obj)) stripDesc(v);
  };
  stripDesc(clone);
  // GitHub's public schema has some deprecation quirks that
  // graphql-js v17's strict validator refuses; skip it —
  // operation validation (below) is the check we care about.
  const schema = buildClientSchema(clone, { assumeValid: true });
  return printSchema(schema);
}

async function main(): Promise<void> {
  console.log("Fetching GitHub GraphQL introspection ...");  // guardrails-ok: CLI progress output
  const token = readGhToken();
  const introspection = await introspect(token);

  // 1. Validate every adapter document against the LIVE schema.
  const liveSchema = buildClientSchema(introspection, { assumeValid: true });
  let failed = 0;
  for (const [name, doc] of Object.entries(GITHUB_GRAPHQL_DOCUMENTS)) {
    const errors = validate(liveSchema, parse(doc));
    if (errors.length > 0) {
      failed++;
      console.error(`FAIL ${name}:`);
      for (const err of errors) console.error(`  - ${err.message}`);
    } else {
      console.log(`ok   ${name}`);  // guardrails-ok: CLI progress output
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} document(s) failed schema validation against LIVE schema.`);
    process.exit(1);
  }

  // 2. Save as SDL (descriptions stripped) so CI can validate offline.
  const sdl = toStrippedSdl(introspection);
  writeFileSync(SCHEMA_PATH, sdl);
  /* guardrails-ok: CLI progress output */ console.log(`\nWrote SDL schema fixture (${(sdl.length / 1024).toFixed(0)} KB) to ${SCHEMA_PATH}`);

  // 3. Belt-and-braces: also validate against the SDL we just wrote,
  //    to catch any drift in the SDL emitter itself.
  const sdlSchema = buildSchema(sdl, { assumeValid: true });
  let sdlFailed = 0;
  for (const [name, doc] of Object.entries(GITHUB_GRAPHQL_DOCUMENTS)) {
    const errors = validate(sdlSchema, parse(doc));
    if (errors.length > 0) {
      sdlFailed++;
      console.error(`FAIL against SDL ${name}: ${errors.map((e) => e.message).join("; ")}`);
    }
  }
  if (sdlFailed > 0) {
    console.error(`\n${sdlFailed} document(s) failed against the SDL — the SDL fixture is broken.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
