// Shared Zod pieces for revkit's typed-data files (ADR-0003).
//
// Every JSON/YAML file revkit reads or writes carries a `schemaVersion` so a
// breaking schema change is a MAJOR release (ADR-0003 Acceptance, ADR-0021).
// The version is validated with a message that names the file's role, because
// the default union error otherwise reads as "Expected 1, got undefined" —
// which is hard to fix without cross-referencing the ADRs.
// Imports `astro/zod` (an npm module) rather than the virtual `astro:content`
// so bun test can load this file without the Astro build server standing up.
import { z } from "astro/zod";

/**
 * The `schemaVersion` value revkit currently reads for typed-data files. Bump
 * this (and add a migration) when the shape of any data file changes in a
 * breaking way (ADR-0021).
 */
export const CURRENT_SCHEMA_VERSION = 1 as const;

/** Accepted `schemaVersion` values — a soft-migration window for the loader
 * (accepts N and N-1 while a migration is offered) would extend this array. */
export const acceptedSchemaVersions = [CURRENT_SCHEMA_VERSION] as const;

/**
 * Zod field that validates `schemaVersion` and produces a message that says
 * what to do, not just what went wrong. `fileRole` names the kind of file so
 * the error points the author at the right place (e.g. "vocab/terms.yaml").
 */
export function schemaVersionField(fileRole: string): z.ZodLiteral<typeof CURRENT_SCHEMA_VERSION> {
  return z.literal(
    CURRENT_SCHEMA_VERSION,
    `${fileRole}: schemaVersion must be ${CURRENT_SCHEMA_VERSION} (missing or unknown — see ADR-0003, ADR-0021 for the migration policy).`,
  );
}
