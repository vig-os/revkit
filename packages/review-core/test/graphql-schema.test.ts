// GraphQL schema validation — OFFLINE test (PR-43 round-3 Blocker 1).
//
// Every document the adapter sends is validated against a stored
// SDL snapshot of GitHub's schema (`test/fixtures/github/graphql-schema.graphql`,
// refreshed by `scripts/validate-github-graphql.ts`). A field
// typo — like the round-2 miss that selected `side` on
// `PullRequestReviewComment` when only `PullRequestReviewThread`
// has it — turns this test red without a network call, so CI
// catches it (PR builds get no secrets, ADR-0014).
//
// The introspection snapshot is refreshed manually by running
// the script above after any query/mutation change. Read-only.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { buildSchema, parse, validate } from "graphql";
import { GITHUB_GRAPHQL_DOCUMENTS } from "../src/github-adapter.ts";

const SCHEMA_PATH = new URL("./fixtures/github/graphql-schema.graphql", import.meta.url).pathname;
const SDL = readFileSync(SCHEMA_PATH, "utf8");
// `assumeValid: true` — GitHub's public schema has some
// deprecation quirks that graphql-js v17's strict validator refuses
// (interface field non-deprecated vs impl deprecated); operation
// validation still works.
const SCHEMA = buildSchema(SDL, { assumeValid: true });

describe("GraphQL documents validate against the stored GitHub SDL schema", () => {
  const documents = Object.entries(GITHUB_GRAPHQL_DOCUMENTS);

  test("every document is registered (the map is non-empty)", () => {
    expect(documents.length).toBeGreaterThan(0);
  });

  for (const [name, doc] of documents) {
    test(`${name} validates`, () => {
      const errors = validate(SCHEMA, parse(doc));
      if (errors.length > 0) {
        throw new Error(
          `${name} failed schema validation:\n  ${errors.map((e) => e.message).join("\n  ")}`,
        );
      }
    });
  }
});

describe("stored SDL fixture", () => {
  test("has core GitHub types the adapter relies on", () => {
    // Cheap sanity: if the fixture is corrupted (e.g. accidentally
    // truncated), the types below would be missing and every
    // operation would fail with generic "unknown type" errors —
    // this test gives a clearer failure signal.
    for (const type of [
      "PullRequest",
      "PullRequestReview",
      "PullRequestReviewThread",
      "PullRequestReviewComment",
      "AddPullRequestReviewInput",
      "AddPullRequestReviewThreadInput",
      "SubmitPullRequestReviewInput",
      "PullRequestReviewThreadSubjectType",
      "DiffSide",
      "PullRequestReviewEvent",
      "Blob",
    ]) {
      expect(SCHEMA.getType(type), `SDL missing type ${type}`).toBeDefined();
    }
  });

  test("PullRequestReviewComment does NOT have `side` (round-2 miss)", () => {
    // Mutation guard for the specific PR-43 round-3 blocker: a
    // regression that re-added `side` / `startSide` to a
    // PullRequestReviewComment selection would fail against live
    // GitHub. This test locks in that the SDL still reflects that.
    const type = SCHEMA.getType("PullRequestReviewComment");
    expect(type).toBeDefined();
    const fields = (type as unknown as { getFields?: () => Record<string, unknown> }).getFields?.();
    expect(fields).toBeDefined();
    expect(fields!["side"]).toBeUndefined();
    expect(fields!["startSide"]).toBeUndefined();
    // But `line` / `originalLine` / `subjectType` DO exist.
    expect(fields!["line"]).toBeDefined();
    expect(fields!["originalLine"]).toBeDefined();
    expect(fields!["subjectType"]).toBeDefined();
  });
});
