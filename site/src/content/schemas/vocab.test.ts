// Tests for the vocabulary schema (`vocab/terms.yaml`, ADR-0003, C2). The
// build-time invariants exercised here are the ones the vocabulary guard
// (ADR-0005) later relies on: unique ids, non-empty terms/definitions, and
// aliases as an optional array of strings.
import { describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "@revkit/review-core";
import { vocabFileSchema } from "./vocab.ts";

const validFile = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  entries: [
    {
      id: "anchor",
      term: "anchor",
      definition: "A dual reference that pins a comment to a doc block.",
      aliases: ["dual anchor"],
    },
    {
      id: "orphaned",
      term: "orphaned",
      definition: "A comment whose text-quote could not be re-found.",
    },
  ],
};

describe("vocabFileSchema", () => {
  test("accepts a well-formed file and defaults missing aliases to []", () => {
    const result = vocabFileSchema.safeParse(validFile);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.entries[1].aliases).toEqual([]);
    expect(result.data.entries).toHaveLength(2);
  });

  test("rejects a file missing schemaVersion, naming the file role", () => {
    const missing = { entries: validFile.entries };
    const result = vocabFileSchema.safeParse(missing);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toContain("vocab/terms.yaml");
  });

  test("rejects a file with an unknown schemaVersion", () => {
    const bogus = { ...validFile, schemaVersion: CURRENT_SCHEMA_VERSION + 42 };
    const result = vocabFileSchema.safeParse(bogus);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(["schemaVersion"]);
  });

  test("rejects a duplicate id, naming the offending index", () => {
    const dupes = {
      ...validFile,
      entries: [validFile.entries[0], { ...validFile.entries[1], id: "anchor" }],
    };
    const result = vocabFileSchema.safeParse(dupes);
    expect(result.success).toBe(false);
    if (result.success) return;
    const message = JSON.stringify(result.error.issues);
    expect(message).toContain("duplicate id 'anchor'");
    expect(message).toContain("entries[0]");
  });

  test("rejects an empty entries array", () => {
    const empty = { ...validFile, entries: [] };
    const result = vocabFileSchema.safeParse(empty);
    expect(result.success).toBe(false);
  });

  test("rejects an entry with an empty term or definition", () => {
    const bad = {
      ...validFile,
      entries: [{ id: "x", term: "", definition: "d" }],
    };
    const result = vocabFileSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});
