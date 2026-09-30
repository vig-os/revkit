// Dual anchor for a comment (ADR-0006). A thread is anchored to a source
// range AND a text-quote selector (W3C Web Annotation style: `exact` with
// `prefix` and `suffix` context), and records the revision it was created
// on. When the source moves, the re-anchoring pipeline (M2 item 5) maps
// the range, verifies the quote, fuzzy-searches on miss, and marks the
// thread `orphaned` if the quote can no longer be found — never dropped.
import { z } from "zod";

/** Regex for the revision id: SHA-256 as 64 lowercase hex characters (see
 * `revisionOf`). A tighter shape check than "any string" so a `revkit
 * threads import` on a foreign archive fails at the boundary. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Text-quote selector (W3C Web Annotation §4.2.4). `prefix` and `suffix`
 * disambiguate a repeated `exact` inside the same file — the re-anchoring
 * pipeline (ADR-0006) uses all three together. `prefix` / `suffix` may
 * legitimately be empty at the start or end of a file, so the empty string
 * is accepted; `exact` is not, since a zero-length quote can't identify a
 * range. */
export const textQuoteSchema = z
  .object({
    exact: z.string().min(1),
    prefix: z.string(),
    suffix: z.string(),
  })
  .strict();

export type TextQuote = z.infer<typeof textQuoteSchema>;

/** An anchor: file path plus 1-indexed inclusive line range, the text-quote
 * selector for the range, and the revision it was captured on. Refined so
 * `endLine >= startLine`. Line numbers are 1-based (matching editors and
 * `data-src="<file>#L<n>-L<m>"`). */
export const anchorSchema = z
  .object({
    path: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    quote: textQuoteSchema,
    revision: z.string().regex(SHA256_HEX, "revision must be a lowercase 64-char SHA-256 hex string (see revisionOf)."),
  })
  .strict()
  .refine((a) => a.endLine >= a.startLine, {
    message: "anchor: endLine must be >= startLine (1-indexed, inclusive).",
    path: ["endLine"],
  });

export type Anchor = z.infer<typeof anchorSchema>;
