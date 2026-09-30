// CSP inline-script hash loader (ADR-0012, issue #22).
//
// The site build emits `dist/.revkit/csp-hashes.json` — the same
// inline-script hashes `revkit check-dist` allowlists, one artefact
// per build. `revkit serve` reads it at startup and hands the hex
// digests to the header builder so `script-src` allows every inline
// bootstrap Starlight and Astro emit.
//
// Fail-closed: if the artefact is missing or malformed, we return
// `loaded: false` and the daemon logs a warning. The header builder
// then omits the hash sources — inline scripts will not run in the
// browser, but the daemon still serves. This matches the ADR-0012
// principle of "the daemon serves an ADR-0012-compliant policy or it
// serves a stricter one; it never widens `script-src`".

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** Shape of `csp-hashes.json`. Matches `emit-csp-hashes.ts`. */
export const cspHashesSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("sha256"),
  // Every hex-encoded SHA-256 the build emitted. Keys of a set live
  // as an ordered array on disk so the JSON diffs cleanly.
  hashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)).default([]),
});

export type CspHashesArtefact = z.infer<typeof cspHashesSchema>;

/** Where the emitter writes the artefact, relative to the served
 * directory (typically `site/dist`). */
export const CSP_HASHES_ARTEFACT_PATH = ".revkit/csp-hashes.json";

/** Result of `loadCspHashes` — either a loaded artefact or the reason
 * it could not be loaded (for logging). */
export type LoadCspHashesResult =
  | { readonly loaded: true; readonly hashes: readonly string[]; readonly artefactPath: string }
  | { readonly loaded: false; readonly reason: string; readonly artefactPath: string };

/** Read `<dir>/.revkit/csp-hashes.json` from disk and return its
 * parsed set of hashes. Never throws — a missing or malformed
 * artefact returns `loaded: false`.
 *
 * `distDir` is the directory the daemon serves (its `--dir` value,
 * or the CWD's `site/dist` when omitted). */
export function loadCspHashes(distDir: string): LoadCspHashesResult {
  const artefactPath = join(distDir, CSP_HASHES_ARTEFACT_PATH);
  let raw: string;
  try {
    raw = readFileSync(artefactPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT"
        ? "artefact missing (run `bun run build` under site/ to emit it)"
        : `read failed: ${(error as Error).message}`;
    return { loaded: false, reason, artefactPath };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { loaded: false, reason: `invalid JSON: ${(error as Error).message}`, artefactPath };
  }
  const parsed = cspHashesSchema.safeParse(json);
  if (!parsed.success) {
    return { loaded: false, reason: `schema mismatch: ${parsed.error.issues.map((i) => i.message).join("; ")}`, artefactPath };
  }
  // Deduplicate in case the emitter version differs. The header
  // builder itself is order-insensitive; we sort so a diff between
  // two artefacts is textual noise only when the input actually
  // changed.
  const dedup = Array.from(new Set(parsed.data.hashes)).sort();
  return { loaded: true, hashes: dedup, artefactPath };
}
