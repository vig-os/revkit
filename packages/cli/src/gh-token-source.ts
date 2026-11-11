// `gh` token source for the M3 local PR-review surface (ADR-0025).
//
// Reads the reviewer's own token by invoking `gh auth token` — the
// exact same identity `gh pr create` and every other `gh` command
// uses. The token lives in memory only for the duration of the
// caller's promise, never appears in a log line, and never crosses
// the daemon → browser boundary.
//
// The runner is the injectable `GhRunner` (`./gh-runner.ts`), so unit
// tests exercise argument construction without touching the network.
// The default runner uses `Bun.spawn` — the same seam every other
// `gh` call in the CLI uses (ADR-0005).
//
// **Security invariants** (ADR-0013, ADR-0014):
//   - argv, not shell — the child process is spawned with an array,
//     so no shell interpolation can be tricked into echoing the
//     token onto a pipe.
//   - short-lived — each call re-runs `gh auth token`, so a token
//     that was revoked between calls is naturally re-fetched. The
//     caller (`GitHubAdapter.rest`/`graphql`) uses the returned
//     string once and drops it.
//   - error redaction — the runner's stderr is scrubbed through
//     `redactTokenInMessage` before being attached to a thrown
//     error, so a stray token in a `gh` diagnostic never leaks.
//   - allowlisted logger — the daemon logger (`serve/logger.ts`)
//     already refuses arbitrary fields, so there is no "log the
//     token" path.

import { redactTokenInMessage, type TokenSource } from "@revkit/review-core";
import { spawnGh, type GhRunner } from "./gh-runner.ts";

/** Options for `createGhTokenSource`. `gh` is the injectable runner
 * (defaults to `spawnGh`), `hostname` is the GitHub host to read a
 * token for (defaults to `github.com` — leaves the flag off, which
 * lets `gh` pick its default host, GHES included). */
export interface GhTokenSourceOptions {
  readonly gh?: GhRunner;
  /** Passed to `gh auth token --hostname <hostname>` when set. */
  readonly hostname?: string;
}

/**
 * Build a `TokenSource` that runs `gh auth token` at use time.
 *
 * Errors:
 *   - the CLI is not installed → `gh auth token` returns exit code
 *     127 (via the shell) or the spawn throws; we wrap either as a
 *     `GhTokenSourceError` with the actionable message.
 *   - the user is not authenticated → `gh` returns non-zero with a
 *     stderr containing "not logged into any GitHub hosts"; we
 *     surface a short message that names the fix.
 *   - the returned stdout is empty or contains obviously-invalid
 *     characters → we refuse, so a fake `gh` shim on `$PATH`
 *     cannot make us send a garbage bearer to GitHub.
 */
export function createGhTokenSource(options: GhTokenSourceOptions = {}): TokenSource {
  const runner: GhRunner = options.gh ?? spawnGh;
  const args = ["auth", "token", ...(options.hostname !== undefined ? ["--hostname", options.hostname] : [])];
  return {
    async getToken(): Promise<string> {
      let result;
      try {
        result = await runner(args);
      } catch (err) {
        // Spawn failure (e.g. gh not on PATH). No token has been
        // seen yet, so redact with the empty string just to strip
        // any `Authorization: Bearer` prose in the message.
        throw new GhTokenSourceError(
          `failed to spawn 'gh ${args.join(" ")}': ${redactTokenInMessage((err as Error).message, "")}`,
        );
      }
      if (result.exitCode !== 0) {
        // gh's own message covers "not logged in"; surface it,
        // scrubbed. Do not print stdout on a failure — even a
        // failed call may have written partial output.
        const stderr = result.stderr.trim();
        const hint = stderr.length > 0 ? stderr : "gh auth token exited non-zero with no stderr";
        throw new GhTokenSourceError(
          `gh auth token failed (exit ${result.exitCode}): ${redactTokenInMessage(hint, "")} — run 'gh auth login' to authenticate.`,
        );
      }
      const token = result.stdout.trim();
      if (token.length === 0) {
        throw new GhTokenSourceError(
          "gh auth token returned empty output — run 'gh auth login' to authenticate.",
        );
      }
      if (!isPlausibleGhToken(token)) {
        // A response with whitespace, control characters or a
        // pathological length would be either a broken gh install
        // or something impersonating gh on the PATH. Refuse.
        throw new GhTokenSourceError(
          `gh auth token returned an implausible value (${token.length} chars) — refusing to send as a bearer.`,
        );
      }
      return token;
    },
  };
}

/** Error class the daemon's request path narrows on to render a
 * clean 'gh not authenticated' page instead of a 500. */
export class GhTokenSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhTokenSourceError";
  }
}

/**
 * Cheap structural check on a token string. Rejects whitespace,
 * control characters, obviously-empty strings and lengths outside a
 * sane band (GitHub tokens today are 40–255 characters; a PAT prefix
 * plus a random tail sits comfortably in that range).
 *
 * We do NOT check the specific GitHub prefixes (`ghp_` etc.) here:
 * `gh` can hold a PAT with any prefix a user's environment defines,
 * and enterprise deployments may issue different prefixes. The
 * length/character-class check is enough to catch a fake shim
 * returning "hello world" or "".
 */
export function isPlausibleGhToken(value: string): boolean {
  if (value.length < 20 || value.length > 512) return false;
  for (let i = 0; i < value.length; i++) {
    const cc = value.charCodeAt(i);
    // Refuse whitespace (space, tab, CR, LF), control chars,
    // and non-ASCII. GitHub tokens are ASCII alphanumeric plus
    // `_` and `-`.
    if (cc <= 0x20 || cc >= 0x7f) return false;
  }
  return true;
}
