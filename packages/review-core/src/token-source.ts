// TokenSource — the runtime-neutral seam every backend uses to obtain a
// bearer credential (ADR-0025). The core knows nothing about where the
// token came from: the local surface (M3) reads `gh auth token` on the
// reviewer's machine, and the hosted surface (M4) reads the GitHub App's
// user-to-server token minted for the current session. Both hand this
// interface to the same `GitHubAdapter`.
//
// **Handling rules** — a `TokenSource` implementation MUST:
//   - fetch a token at call time and never cache one longer than the
//     caller's promise settles. The `GitHubAdapter` calls this once per
//     request, so a cache would only save microseconds and would extend
//     the window a leaked reference can be used.
//   - never write the token to disk, to a log line, or to an outgoing
//     HTTP response body. The daemon logger's runtime allowlist (see
//     `packages/cli/src/serve/logger.ts`) already refuses arbitrary
//     fields, and this interface is here to remind future implementers
//     of the same rule at the API boundary.
//
// A backend that needs the token in memory across multiple requests
// (e.g. an installation token good for one hour) can still implement
// this interface: it just refreshes on demand and caches internally,
// under its own memory-management rules, without exposing the cached
// value.

/** A source of bearer credentials for the GitHub adapter. */
export interface TokenSource {
  /**
   * Return the bearer token for the next outgoing request. Called
   * exactly once per adapter call; may throw if the token cannot be
   * obtained (e.g. `gh` is not authenticated). The returned string
   * MUST NOT be logged or written to disk by the implementation.
   */
  getToken(): Promise<string>;
}

/**
 * Redact a bearer token in a free-form string. Every error message that
 * flows through the adapter passes through this function so a stack
 * trace or an upstream error that happens to include the token can never
 * be logged verbatim.
 *
 * The rules are intentionally coarse — a leaked token is a security
 * failure, so we prefer over-redaction to a missed pattern:
 *   - the exact `token` value, when non-empty, is replaced by
 *     `<redacted:token>`;
 *   - a GitHub token pattern (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`,
 *     `github_pat_`) followed by a hex or base62 tail is replaced with
 *     `<redacted:ghtoken>`, whether or not it matches `token`. This
 *     catches the case where a leaked message includes a DIFFERENT
 *     token (a nearby PAT the user's terminal happened to echo);
 *   - an `Authorization: Bearer <anything>` header is replaced with
 *     `Authorization: Bearer <redacted>`.
 */
export function redactTokenInMessage(message: string, token: string): string {
  let out = message;
  // Exact token first — the caller's active credential is the highest
  // priority match, and doing it first avoids double-redacting when
  // the token itself matches the GitHub pattern below.
  if (token.length > 0) {
    // Replace all occurrences. `split`/`join` avoids a regex escape.
    out = out.split(token).join("<redacted:token>");
  }
  // GitHub token prefixes plus a plausible tail (letters, digits,
  // underscore). Length 20+ narrows the match away from prose.
  //
  // Cannot use `\b` for the start boundary: `_` is a word character
  // in JS regex, so `\bghp_` fails to match on `foo_ghp_...`. Use
  // an explicit lookbehind for a non-alphanumeric character or the
  // start of the string (PR-43 nit).
  out = out.replace(/(?<![A-Za-z0-9])(gh[opusr]_|github_pat_)[A-Za-z0-9_]{20,}/g, "<redacted:ghtoken>");
  // `Authorization: Bearer <anything up to whitespace or quote>`.
  out = out.replace(/(Authorization:\s*Bearer\s+)[^\s"']+/gi, "$1<redacted>");
  return out;
}
