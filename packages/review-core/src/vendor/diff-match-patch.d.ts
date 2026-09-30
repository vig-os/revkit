// Local ESM-shaped types for the `diff-match-patch` npm package (v1.0.5).
//
// The upstream `@types/diff-match-patch` uses CommonJS-only
// `export = diff_match_patch;`, which does not play with our
// `verbatimModuleSyntax: true` + `module: ESNext` build. At runtime, both
// Bun and browser bundlers surface the package as `module.exports =
// diff_match_patch;` and expose the class under a namespaced key too
// (`module.exports.diff_match_patch`), so this declaration matches what
// the ESM interop actually returns.
//
// Kept minimal — declares only the members the re-anchoring engine
// actually calls. Broader coverage lives in the upstream package for
// consumers that need it.
declare module "diff-match-patch" {
  /** A single diff tuple: [op, text]. `op` is one of `DIFF_DELETE` (-1),
   * `DIFF_EQUAL` (0) or `DIFF_INSERT` (1). */
  export type Diff = [number, string];

  export class diff_match_patch {
    /** Cost of an empty edit operation in terms of edit characters
     * (larger = faster, less accurate). Default 4. */
    Diff_EditCost: number;
    /** Number of seconds to spend on `diff_main` before giving up.
     * Default 1.0 second. */
    Diff_Timeout: number;
    /** At what point is no match declared (0.0 = perfect, 1.0 = very loose). */
    Match_Threshold: number;
    /** How far to search for a match (0 = exact location, 1000+ = broad
     * match). A match this many characters away from the expected location
     * scores like a perfect match against a location zero characters
     * away. */
    Match_Distance: number;
    /** The number of bits in an int. `match_main` truncates the pattern
     * to this many characters (word size, default 32). */
    Match_MaxBits: number;

    /** Compute a line-mode set of diffs. */
    diff_main(text1: string, text2: string, opt_checklines?: boolean): Diff[];
    /** Convert the two texts to a sequence of characters (one per unique
     * line) so `diff_main` produces a line-mode diff cheaply. */
    diff_linesToChars_(text1: string, text2: string): {
      chars1: string;
      chars2: string;
      lineArray: string[];
    };
    /** Reverse of `diff_linesToChars_` — expand the char-diff back to the
     * original per-line text (mutates `diffs`). */
    diff_charsToLines_(diffs: Diff[], lineArray: string[]): void;
    /** Compute the Levenshtein distance between the two texts represented
     * by the diff. */
    diff_levenshtein(diffs: Diff[]): number;

    /** Locate the best match for `pattern` in `text` near `loc`. Returns
     * -1 if no match. */
    match_main(text: string, pattern: string, loc: number): number;

    static DIFF_DELETE: -1;
    static DIFF_INSERT: 1;
    static DIFF_EQUAL: 0;
  }
}
