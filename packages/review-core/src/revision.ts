// Revision id for a source file (ADR-0006 Acceptance): SHA-256 of the file
// normalised to LF line endings, hex-encoded. Windows checkouts, editors
// that autoconvert on save and cross-OS agents all produce the same id for
// the same content — otherwise a CRLF/LF flip would look like a rewrite and
// orphan every thread on the file.
//
// Runs via WebCrypto (`crypto.subtle`), which is globally available in Bun,
// in a Cloudflare Worker and in every browser revkit supports (ADR-0018),
// so this file needs no runtime-specific import (ADR-0025).

/** Regex for a hex-encoded SHA-256 (64 lowercase hex characters). Exported
 * so every schema that stores a revision id (`anchorSchema`,
 * `handover.revision`) shares one definition and moves in one place. */
export const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

/** Regex for a full-length git commit SHA (40 lowercase hex characters).
 * Used by `Anchor.commit`, which is the optional PR-head SHA the M3 local
 * PR-review surface (ADR-0025) records against a comment so the GitHub
 * adapter can pin a pending review to the right `commit_id`. */
export const GIT_SHA_HEX_REGEX = /^[0-9a-f]{40}$/;

/**
 * Content hash of a source string, LF-normalised. Returns 64 lowercase
 * hex characters — the value stored in `Anchor.revision` and the format
 * `anchorSchema` validates.
 *
 * `\r\n` and lone `\r` are both mapped to `\n` so an in-place LF→CRLF
 * check-out and an editor's auto-conversion produce the same id for the
 * same content.
 */
export async function revisionOf(source: string): Promise<string> {
  const normalised = source.replace(/\r\n?/g, "\n");
  const bytes = new TextEncoder().encode(normalised);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
