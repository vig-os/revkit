// Shared `schemaVersion` field for revkit's typed and persisted shapes
// (ADR-0003, ADR-0021). Every JSON/YAML/exported file revkit reads or writes
// carries a `schemaVersion`, so a breaking shape change is a MAJOR release.
// The message names the file's role: the default Zod union error otherwise
// reads as "Expected 1, got undefined", which is hard to fix without cross-
// referencing the ADRs.
//
// Owned by `@revkit/review-core` and re-used across the workspace (site
// content collections, exported thread archives, ask specs) so the accepted
// set moves in one place.
import { z } from "zod";

/**
 * The `schemaVersion` value revkit currently reads for typed and persisted
 * shapes. Bump this (and add a migration) when the shape of any data file
 * or exported archive changes in a breaking way (ADR-0021).
 */
export const CURRENT_SCHEMA_VERSION = 1 as const;

/** Accepted `schemaVersion` values — a soft-migration window for a loader
 * (accepts N and N-1 while a migration is offered) extends this array. */
export const acceptedSchemaVersions = [CURRENT_SCHEMA_VERSION] as const;

/**
 * Zod field that validates `schemaVersion` and produces a message that says
 * what to do, not just what went wrong. `fileRole` names the kind of file
 * so the error points the author at the right place (e.g. "vocab/terms.yaml"
 * or ".revkit/threads/<slug>.json").
 */
export function schemaVersionField(fileRole: string): z.ZodLiteral<typeof CURRENT_SCHEMA_VERSION> {
  return z.literal(
    CURRENT_SCHEMA_VERSION,
    `${fileRole}: schemaVersion must be ${CURRENT_SCHEMA_VERSION} (missing or unknown — see ADR-0003, ADR-0021 for the migration policy).`,
  );
}
