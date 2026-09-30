// Dual anchor for a comment (ADR-0006). A thread is anchored to a source
// range AND a text-quote selector (W3C Web Annotation style: `exact` with
// `prefix` and `suffix` context), and records the revision it was created
// on. When the source moves, the re-anchoring pipeline (M2 item 5) maps
// the range, verifies the quote, fuzzy-searches on miss, and marks the
// thread `orphaned` if the quote can no longer be found — never dropped.
//
// `commit` is optional and holds the PR-head git SHA the anchor was
// captured against. The M3 local PR-review surface (ADR-0025) records it
// so the GitHub adapter can pin a pending review to the right
// `commit_id`; the M2 local rail leaves it undefined. Reserved on the v0
// wire so M3 lands without a `schemaVersion` bump.
import { z } from "zod";
import { isValidRepoRelativePath } from "./path.ts";
import { GIT_COMMIT_HEX_REGEX, SHA256_HEX_REGEX } from "./revision.ts";

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

/** Structural validator for a repo-relative anchor path.
 *
 * Calls `isValidRepoRelativePath` from `./path.ts` — the SINGLE
 * source of truth (PR #38 round-2 review) so the daemon, the rail,
 * `check-dist`, and the GitHub adapter apply the exact same rule.
 * The predicate encodes the full rule (length, charset, containment,
 * empty segments); this schema just wraps it in a Zod message. */
export const anchorPathSchema = z
  .string()
  .refine(isValidRepoRelativePath, {
    message:
      "anchor.path must be repo-relative POSIX, 1..512 chars, no '..'/'.'/'//' segments, " +
      "no control chars, no `:`/`*`/`?`/`<`/`>`/`|`/`\"`, no leading `/`, no backslash.",
  });

/** An anchor: file path plus 1-indexed inclusive line range, the text-quote
 * selector for the range, and the revision it was captured on. Refined so
 * `endLine >= startLine`. Line numbers are 1-based (matching editors and
 * `data-src="<file>#L<n>-L<m>"`). */
export const anchorSchema = z
  .object({
    path: anchorPathSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    quote: textQuoteSchema,
    revision: z
      .string()
      .regex(SHA256_HEX_REGEX, "revision must be a lowercase 64-char SHA-256 hex string (see revisionOf)."),
    commit: z
      .string()
      .regex(
        GIT_COMMIT_HEX_REGEX,
        "commit must be a lowercase git commit id — 40 hex (SHA-1) or 64 hex (SHA-256 repos) — (ADR-0025 M3 head-pinning).",
      )
      .optional(),
  })
  .strict()
  .refine((a) => a.endLine >= a.startLine, {
    message: "anchor: endLine must be >= startLine (1-indexed, inclusive).",
    path: ["endLine"],
  });

export type Anchor = z.infer<typeof anchorSchema>;
