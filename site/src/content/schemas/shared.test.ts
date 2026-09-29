// Tests for the shared schemaVersion field — the acceptance-criterion for
// ADR-0003 (every data file carries schemaVersion; missing or unknown
// values fail loudly with a message that names the file's role).
import { describe, expect, test } from "bun:test";
import { z } from "astro/zod";
import { CURRENT_SCHEMA_VERSION, acceptedSchemaVersions, schemaVersionField } from "./shared.ts";

// Local re-declaration mirrors the shape a data-file schema builds around
// the field, so a regression in schemaVersionField's error wiring trips a
// test rather than surfacing on a build months later.
const wrapped = z.object({
  schemaVersion: schemaVersionField("test/example.yaml"),
  payload: z.string(),
});

describe("schemaVersionField", () => {
  test("the accepted set contains the current version", () => {
    expect(acceptedSchemaVersions).toContain(CURRENT_SCHEMA_VERSION);
  });

  test("accepts a file whose schemaVersion is the current version", () => {
    const result = wrapped.safeParse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: "ok",
    });
    expect(result.success).toBe(true);
  });

  test("rejects a file that is missing schemaVersion, with a hint at the required value", () => {
    const result = wrapped.safeParse({ payload: "ok" });
    expect(result.success).toBe(false);
    if (result.success) return;
    const message = JSON.stringify(result.error.issues);
    expect(message).toContain("test/example.yaml");
    expect(message).toContain(String(CURRENT_SCHEMA_VERSION));
  });

  test("rejects a file with an unknown schemaVersion", () => {
    const unknownVersion = CURRENT_SCHEMA_VERSION + 99;
    const result = wrapped.safeParse({
      schemaVersion: unknownVersion,
      payload: "ok",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const path = result.error.issues[0]?.path;
    expect(path).toEqual(["schemaVersion"]);
  });
});
