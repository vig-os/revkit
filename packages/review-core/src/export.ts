// Export / import format for threads (ADR-0006 Acceptance). One shape,
// used by `revkit threads export|import` to move between the local
// `bun:sqlite` store and the hosted D1 store, so a local review can be
// published to a hosted PR (and vice versa). The event log is the source
// of truth (ADR-0006), so an archive is the events — the derived
// `Thread` view rebuilds by reducing them.
//
// The exported bytes carry `schemaVersion` (ADR-0003 / ADR-0021) so a
// future breaking change to the shape lands with a migration, not a
// silent misread. `parseArchive` also runs the shared `validateNext`
// (see `validator.ts`) across the sequence, so an archive whose events
// individually pass Zod but produce an inconsistent log (a reply to a
// missing thread, a duplicate commentId, and so on) is refused at the
// byte boundary — one rule set at the store boundary and the archive
// boundary.
import { z } from "zod";
import { reviewEventSchema, type ReviewEvent } from "./events.ts";
import { CURRENT_SCHEMA_VERSION, schemaVersionField } from "./schema-version.ts";
import { emptyLogState, validateNext } from "./validator.ts";

/** The wire shape of an archive. `events` are ordered by `seq` ascending
 * (strict; gaps allowed) and any two events carry distinct `seq` values.
 * Refinements enforce both, plus a `validateNext` play-through. */
export const threadArchiveSchema = z
  .object({
    schemaVersion: schemaVersionField("revkit threads export|import archive"),
    events: z.array(reviewEventSchema),
  })
  .strict()
  .superRefine((archive, ctx) => {
    let previous = 0;
    const seen = new Set<number>();
    for (const [index, event] of archive.events.entries()) {
      if (seen.has(event.seq)) {
        ctx.addIssue({
          code: "custom",
          path: ["events", index, "seq"],
          message: `duplicate seq ${event.seq} — an archive is an append-only log; seqs must be unique.`,
        });
        continue;
      }
      seen.add(event.seq);
      if (event.seq <= previous) {
        ctx.addIssue({
          code: "custom",
          path: ["events", index, "seq"],
          message: `events out of order: seq ${event.seq} appears after seq ${previous} — archive events are ordered by seq ascending.`,
        });
      }
      previous = event.seq;
    }
    // Play the log through the shared transition validator so a
    // shape-clean archive that references a missing thread / parent /
    // ask / comment fails at parse — the same rule set the store's
    // `append` path enforces.
    const state = emptyLogState();
    for (const [index, event] of archive.events.entries()) {
      const result = validateNext(state, event);
      if (!result.ok) {
        // `transition` rides on the issue as STRUCTURED data, not just as
        // text in `message`. A refusal that reached the store boundary
        // through this issue has to report the same `kind` the store's own
        // dry run would report for the same invariant, or a caller
        // branching on `ThreadStoreImportError.rejection.kind` sees
        // `invalid-shape` for an archive that is semantically broken
        // rather than malformed. `prepareImport` (see `store.ts`) reads
        // this field; without it, the only way to recover the kind would be
        // parsing `message`, which is exactly what the typed `rejection`
        // field exists to avoid (#72).
        ctx.addIssue({
          code: "custom",
          path: ["events", index],
          message: `log invariant: ${result.rejection.kind} — ${result.rejection.message}`,
          transition: result.rejection,
        });
        return;
      }
    }
  });

export type ThreadArchive = z.infer<typeof threadArchiveSchema>;

/** Interface subset: `exportArchive` only needs `since`. Kept narrow so
 * a caller that wraps a store (say, a filtered view) can still export
 * without exposing the whole `ThreadStore`. */
interface SinceSource {
  since(after: number): Promise<ReviewEvent[]>;
}

/** Export a store's events into an archive object, ready to
 * `JSON.stringify` for the on-disk / on-wire form. `.since(0)` returns
 * every event; the store may inject its own ordering (e.g. an index
 * scan) so we sort again here to make the archive shape independent of
 * a store's iteration order. */
export async function exportArchive(store: SinceSource): Promise<ThreadArchive> {
  const events = await store.since(0);
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  return threadArchiveSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    events: ordered,
  });
}

/** Parse an unknown JSON value as a `ThreadArchive`. Throws with the
 * schema's `path`-annotated issues on any mismatch — including a
 * `validateNext` violation — so a hosted archive with a foreign field
 * or a semantically-inconsistent log fails at the boundary rather than
 * silently dropping data. */
export function parseArchive(raw: unknown): ThreadArchive {
  return threadArchiveSchema.parse(raw);
}
