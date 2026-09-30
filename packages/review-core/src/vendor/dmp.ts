// Local typed wrapper over `diff-match-patch` (v1.0.5).
//
// Why this file:
//   The upstream `@types/diff-match-patch` package declares its module
//   with `export = diff_match_patch;`, which does not compose with
//   `verbatimModuleSyntax: true` + `module: ESNext` in this workspace
//   (there is no valid ESM syntax that accepts a bare `export =` under
//   those flags without `esModuleInterop`, which we do not enable).
//   Installing that types package would also fight any consumer that
//   later reaches for it themselves through `@revkit/review-core`.
//
//   An ambient `declare module "diff-match-patch"` in this workspace
//   would work, but it LEAKS across every project that walks into
//   review-core's sources (any consumer that later adds
//   `@types/diff-match-patch` would then clash). Kept out of the tree
//   for that reason.
//
//   The runtime shape is stable and simple: `module.exports =
//   diff_match_patch;` plus `module.exports.diff_match_patch =
//   diff_match_patch;`. Both Bun and esbuild surface the class through
//   the named-import shape below without any interop shim.
//
// The `@ts-ignore` on the sole `import` line is the entire scope of
// the type suppression — the rest of the workspace consumes
// `DiffMatchPatch` through the narrow, well-typed interface exported
// here, so no `any` escapes.
// @ts-ignore -- 'diff-match-patch' ships CJS-only types (see file
// comment above); the runtime shape is verified in
// `test/browser-build.test.ts` and `test/reanchor.test.ts`.
import { diff_match_patch as diffMatchPatchRuntime } from "diff-match-patch";

/** A single diff tuple emitted by `diff_main` and consumed by the
 * other DMP methods: `[op, text]`. `op` is one of `-1` (DELETE), `0`
 * (EQUAL) or `1` (INSERT). */
export type Diff = readonly [number, string];

/** The subset of the DMP instance API the re-anchoring engine uses.
 * Kept narrow so the surface area of the untyped import is documented
 * here and only here — a call the engine grows into needs a new field
 * on this interface, not a hidden `as any`. */
export interface DiffMatchPatch {
  /** Cost of an empty edit (higher = faster and coarser diffs). */
  Diff_EditCost: number;
  /** Seconds `diff_main` may spend before it stops early. */
  Diff_Timeout: number;
  /** Accept-a-match threshold (0.0 = perfect, 1.0 = very loose). */
  Match_Threshold: number;
  /** How far from the expected location a match may be before its
   * score is penalised (0 = must be exact, larger = broader). */
  Match_Distance: number;
  /** Bitap word size — patterns longer than this are refused by
   * `match_main`, so the caller truncates or slices. Default 32. */
  Match_MaxBits: number;

  /** Character-mode diff. Pass `false` for `opt_checklines` when the
   * inputs are already at whatever granularity you want compared. */
  diff_main(text1: string, text2: string, opt_checklines?: boolean): Diff[];
  /** Encode two texts to a per-line char sequence so `diff_main`
   * emits a line-mode diff cheaply. */
  diff_linesToChars_(text1: string, text2: string): {
    chars1: string;
    chars2: string;
    lineArray: string[];
  };
  /** Expand a line-mode diff back to per-line text. Mutates `diffs`. */
  diff_charsToLines_(diffs: Diff[], lineArray: string[]): void;
  /** Levenshtein distance between the two texts represented by
   * `diffs` (= number of edited characters). */
  diff_levenshtein(diffs: Diff[]): number;
  /** Given a location in `text1`, find the equivalent location in
   * `text2` under `diffs`. Used to walk an old-string offset onto
   * the new string it maps to. */
  diff_xIndex(diffs: Diff[], loc: number): number;

  /** Locate the best fuzzy match for `pattern` in `text` near `loc`.
   * Returns -1 for no match. */
  match_main(text: string, pattern: string, loc: number): number;
}

/** Constructor shape — the `new`-able class the runtime module
 * exports. */
export interface DiffMatchPatchConstructor {
  new (): DiffMatchPatch;
}

/** Runtime constructor, cast once through the narrow interface. Every
 * consumer inside review-core uses this; no other file imports from
 * `diff-match-patch` directly. */
export const DiffMatchPatch = diffMatchPatchRuntime as unknown as DiffMatchPatchConstructor;
