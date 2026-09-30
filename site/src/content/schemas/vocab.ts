// Vocabulary schema (`vocab/terms.yaml`) — one place a term is defined
// (DESIGN-0001 §3, C2). `<Term id>` references and the vocabulary guard
// (ADR-0005) both look up entries here by `id`.
import { z } from "astro/zod";
import { schemaVersionField } from "@revkit/review-core";

/** One vocabulary entry: an id used by `<Term id>`, the term as prose, its
 * definition, and any aliases whose bold definition in prose (`**X** is/means
 * …`) counts as a redefinition of this term. */
export const vocabEntrySchema = z.object({
  id: z.string().min(1),
  term: z.string().min(1),
  definition: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
});

export type VocabEntry = z.infer<typeof vocabEntrySchema>;

/** The whole `vocab/terms.yaml` file. Ids must be unique — a duplicate would
 * make `<Term id>` ambiguous. */
export const vocabFileSchema = z
  .object({
    schemaVersion: schemaVersionField("vocab/terms.yaml"),
    entries: z.array(vocabEntrySchema).min(1),
  })
  .superRefine((file, ctx) => {
    const seen = new Map<string, number>();
    for (const [index, entry] of file.entries.entries()) {
      const previous = seen.get(entry.id);
      if (previous !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "id"],
          message: `vocab/terms.yaml: duplicate id '${entry.id}' (also at entries[${previous}]). Ids must be unique so <Term id> resolves to one entry.`,
        });
      } else {
        seen.set(entry.id, index);
      }
    }
  });

export type VocabFile = z.infer<typeof vocabFileSchema>;
