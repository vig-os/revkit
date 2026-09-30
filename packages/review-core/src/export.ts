// Export / import format for threads (ADR-0006 Acceptance). One shape,
// used by `revkit threads export|import` to move between the local
// `bun:sqlite` store and the hosted D1 store, so a local review can be
// published to a hosted PR (and vice versa). The event log is the source
// of truth (ADR-0006), so an archive is the events — the derived
// `Thread` view rebuilds by reducing them.
//
// The exported bytes carry `schemaVersion` (ADR-0003 / ADR-0021) so a
// future breaking change to the shape lands with a migration, not a
// silent misread.
import { z } from "zod";
import { reviewEventSchema, type ReviewEvent } from "./events.ts";
import { schemaVersionField } from "./schema-version.ts";
import type { ThreadStore } from "./store.ts";

/** The wire shape of an archive. `events` are ordered by `seq` ascending
 * — the array's iteration order IS the log order — and any two events
 * carry distinct `seq` values. Refinements enforce both; a random
 * out-of-order archive fails at import. */
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
  });

export type ThreadArchive = z.infer<typeof threadArchiveSchema>;

/** Export a store's events into an archive object, ready to `JSON.stringify`
 * for the on-disk / on-wire form. `.since(0)` returns every event; the
 * store may inject its own ordering (e.g. an index scan) so we sort again
 * here to make the archive shape independent of a store's iteration
 * order. */
export async function exportArchive(store: ThreadStore): Promise<ThreadArchive> {
  const events = await store.since(0);
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  return threadArchiveSchema.parse({
    schemaVersion: 1,
    events: ordered,
  });
}

/** Parse an unknown JSON value as a `ThreadArchive`. Throws with the
 * schema's `path`-annotated issues on any mismatch, so a hosted archive
 * with a foreign field fails at the boundary rather than silently
 * dropping data. */
export function parseArchive(raw: unknown): ThreadArchive {
  return threadArchiveSchema.parse(raw);
}

/** Re-parse events from an archive into `ReviewEvent[]`. A convenience
 * over `parseArchive(...).events` when the caller only wants to replay
 * the log through a store. */
export function eventsFromArchive(archive: ThreadArchive): ReviewEvent[] {
  return archive.events.slice();
}
