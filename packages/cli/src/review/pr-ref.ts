// Parse a PR reference into a `{owner, repo, pullNumber}` triple, the
// coordinate the `GitHubAdapter` (`@revkit/review-core`) takes. Accepted
// shapes (deliberately narrow — no guessing):
//
//   - `123`                                 — bare number, uses the
//                                             `defaultRepoSlug` env
//   - `owner/repo#123`                      — repo slug + `#` + number
//   - `https://github.com/o/r/pull/123`     — full URL
//   - `http://github.com/o/r/pull/123`      — full URL
//   - `github.com/o/r/pull/123`             — scheme-less URL
//
// Anything else is refused as a usage error. The parser is a pure
// function: no fetch, no filesystem — the caller invokes the adapter
// separately once a `PrRef` is in hand.

import type { PrRef } from "@revkit/review-core";

/** Parsed outcome. `ok: false` carries a human-readable message the CLI
 * dispatcher renders as a usage error. */
export type PrRefParseResult =
  | { readonly ok: true; readonly ref: PrRef }
  | { readonly ok: false; readonly message: string };

/** The maximum GitHub PR number we accept — GitHub's own PR numbers
 * are 32-bit integers, but we cap at a much smaller number that's
 * larger than any real project would reach. Rejects overflow attempts
 * (`999999999999...`). */
const PR_NUMBER_MAX = 1_000_000;

/** Allowlist of characters in `owner` / `repo` segments. GitHub's own
 * rules are stricter (no leading `-`, no `..`, etc.) but this shape
 * check is enough to keep a parser abuse (spaces, quotes, path
 * traversal) out of URLs the adapter constructs. */
const SLUG_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Parse a PR reference. `defaultSlug` (`owner/repo`) is used when
 * the caller passed a bare number. Returns a discriminated result
 * so the CLI can render a specific message on rejection. */
export function parsePrRef(raw: string, defaultSlug: string): PrRefParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "revkit review: expected a PR number or URL" };
  }

  // Bare number: `123`.
  if (/^[0-9]+$/.test(trimmed)) {
    const num = Number.parseInt(trimmed, 10);
    if (!isValidPrNumber(num)) {
      return { ok: false, message: `revkit review: PR number out of range: ${trimmed}` };
    }
    const parsedSlug = parseSlug(defaultSlug);
    if (parsedSlug === undefined) {
      return { ok: false, message: `revkit review: default repo slug is malformed: '${defaultSlug}'` };
    }
    return { ok: true, ref: { ...parsedSlug, pullNumber: num } };
  }

  // `owner/repo#123` — the shape used in gh cross-refs.
  const hashMatch = trimmed.match(/^([^#]+)#([0-9]+)$/);
  if (hashMatch !== null) {
    const slug = hashMatch[1] ?? "";
    const numStr = hashMatch[2] ?? "";
    const num = Number.parseInt(numStr, 10);
    if (!isValidPrNumber(num)) {
      return { ok: false, message: `revkit review: PR number out of range: ${numStr}` };
    }
    const parsedSlug = parseSlug(slug);
    if (parsedSlug === undefined) {
      return { ok: false, message: `revkit review: invalid repo slug in '${trimmed}'` };
    }
    return { ok: true, ref: { ...parsedSlug, pullNumber: num } };
  }

  // URL or scheme-less URL.
  const urlPath = extractGithubUrlPath(trimmed);
  if (urlPath === undefined) {
    return {
      ok: false,
      message:
        `revkit review: could not parse '${trimmed}' as a PR reference — ` +
        `expected NUMBER, owner/repo#NUMBER, or https://github.com/owner/repo/pull/NUMBER`,
    };
  }
  // URL path is `/owner/repo/pull/NUMBER` (possibly with a trailing
  // fragment `/files` or `#discussion_r...`, which we ignore).
  const parts = urlPath.split("/").filter((s) => s.length > 0);
  if (parts.length < 4 || parts[2] !== "pull") {
    return {
      ok: false,
      message: `revkit review: URL '${trimmed}' does not look like a PR page (expected /owner/repo/pull/N)`,
    };
  }
  const owner = parts[0] ?? "";
  const repo = parts[1] ?? "";
  const numStr = parts[3] ?? "";
  if (!/^[0-9]+$/.test(numStr)) {
    return {
      ok: false,
      message: `revkit review: URL '${trimmed}' has a non-numeric PR number segment`,
    };
  }
  const num = Number.parseInt(numStr, 10);
  if (!isValidPrNumber(num)) {
    return { ok: false, message: `revkit review: PR number out of range: ${numStr}` };
  }
  if (!SLUG_SEGMENT_RE.test(owner) || !SLUG_SEGMENT_RE.test(repo)) {
    return { ok: false, message: `revkit review: URL has an invalid owner/repo segment` };
  }
  return { ok: true, ref: { owner, repo, pullNumber: num } };
}

/** Extract the URL pathname if `raw` names a github.com PR page.
 * Accepts `https://`, `http://` and scheme-less shapes; refuses any
 * other host. Returns `undefined` when the shape does not match. */
function extractGithubUrlPath(raw: string): string | undefined {
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    return undefined;
  }
  return url.pathname;
}

/** Parse `owner/repo` into a `PrRef` prefix. Returns `undefined` if
 * either segment is empty or violates the segment allowlist. */
function parseSlug(slug: string): { readonly owner: string; readonly repo: string } | undefined {
  const parts = slug.split("/");
  if (parts.length !== 2) return undefined;
  const owner = parts[0] ?? "";
  const repo = parts[1] ?? "";
  if (!SLUG_SEGMENT_RE.test(owner) || !SLUG_SEGMENT_RE.test(repo)) return undefined;
  return { owner, repo };
}

function isValidPrNumber(num: number): boolean {
  return Number.isInteger(num) && num > 0 && num <= PR_NUMBER_MAX;
}
