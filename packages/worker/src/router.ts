// Pure preview-path grammar for the hosted surface (ADR-0008,
// `review.exoma.org/<repo>/pr-<n>/`).
//
// **The path grammar is code; the hostname is configuration.** ADR-0008
// makes the Worker per-org, so the domain cannot be baked in here — and
// this file has no host in it at all. It answers one question: given a
// URL pathname, is this a preview path, and if so which repo and PR?
//
// Everything in this module is pure so it can be exhaustively tested
// without a Worker, an account, or a DNS record. That matters more than
// usual because these paths are the isolation boundary ADR-0012 leans on:
// a `..` or a doubled slash that slipped through would let one repo's
// preview read another's R2 key.
//
// **What is NOT here.** Serving anything. Deciding whether a path may be
// served (the ADR-0012 extension allowlist), whether a fork preview was
// approved, and whether `/_revkit/` exists — all slice 3. What is here is
// the recogniser, so slice 3 has one tested parser to build on instead
// of a regex it writes itself.

/** A parsed preview path. */
export interface PreviewRef {
  /** The repository segment, as it appeared in the path. */
  readonly repo: string;
  /** The PR number, as a positive integer. */
  readonly pr: number;
  /** The raw pathname, kept so a caller can build R2 keys from exactly
   * what was requested rather than from a re-serialised form. */
  readonly pathname: string;
}

/** ADR-0012's revkit-owned bundle root. Never a redirecting alias. */
export const REVKIT_BUNDLE_ROOT = "/_revkit/";

/** The reserved first segment that holds revkit's own bundles. ADR-0012:
 * `/_revkit/` is never a preview and never redirects. */
export const REVKIT_SEGMENT = "_revkit";

/** API routes live under this prefix and are not previews. */
export const API_SEGMENT = "api";

/**
 * A repository segment: the GitHub repo name shape. Deliberately
 * strict — the set of characters a real `owner/repo` name can contain —
 * because this segment becomes part of an R2 key and a permissive
 * pattern here is a path-traversal primitive.
 *
 * Refuses: empty, `.`/`..` (as a whole segment), a `/` (so a nested
 * path is not a preview), and any character outside
 * `A-Za-z0-9._-`.
 */
const REPO_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** The `pr-<n>` segment. `\d{1,9}` caps the number at nine digits so a
 * path cannot carry an unbounded integer into a key, and the bound is
 * far above any real PR number. Leading zeros are REFUSED rather than
 * accepted-and-normalised: two spellings of one PR would produce two
 * distinct R2 prefixes for one preview, which is exactly the aliasing
 * ADR-0012 forbids for `/_revkit/`. */
const PR_SEGMENT = /^pr-([1-9][0-9]{0,8})$/;

/**
 * Parse a preview path, or return undefined.
 *
 * Accepts exactly `<repo>/pr-<n>` and `<repo>/pr-<n>/…` — the trailing
 * path is the built site inside the preview. Returns undefined for
 * `/healthz`, `/api/threads`, `/_revkit/<version>/x.js`, `//`, and
 * anything with a traversal or over-long segment, because "not a preview"
 * is the answer a caller must be able to trust.
 */
export function parsePreviewPath(pathname: string): PreviewRef | undefined {
  if (!pathname.startsWith("/")) return undefined;
  // A doubled slash anywhere is refused rather than collapsed: two
  // spellings of one path must not both resolve.
  if (pathname.includes("//")) return undefined;
  // Reject the encoded and literal traversal forms before segmenting, so
  // no consumer has to remember. `%2e`/`%2f` are matched
  // case-insensitively by the `i` flag; workerd does not decode the
  // pathname for us before this runs.
  if (/%2e|%2f|%5c/i.test(pathname)) return undefined;
  const segments = pathname.split("/");
  // `.` and `..` are refused in EVERY segment, not only the first. The
  // trailing path is where the built site lives, so a preview key becomes
  // `<repo>/pr-<n>/` + this text; a `..` further along is exactly as able
  // to address a sibling preview's object as one in the first segment, and
  // an earlier revision of this file checked only segments 1 and 2. The
  // doubled-slash rule above already rejects the empty segments, so the
  // only remaining offenders are the two dot forms.
  for (const segment of segments) {
    if (segment === "." || segment === "..") return undefined;
  }
  // split("/") on "/a/b/" gives ["", "a", "b", ""] — the trailing "" is
  // the prefix marker, which is legal; a bare "/" gives ["", ""], which
  // has no repo.
  const repo = segments[1];
  const prSegment = segments[2];
  if (repo === undefined || prSegment === undefined) return undefined;
  if (repo === "" || repo === REVKIT_SEGMENT || repo === API_SEGMENT) return undefined;
  if (!REPO_SEGMENT.test(repo)) return undefined;
  const match = PR_SEGMENT.exec(prSegment);
  if (match === null) return undefined;
  const pr = Number.parseInt(match[1] as string, 10);
  if (!Number.isSafeInteger(pr) || pr < 1) return undefined;
  return { repo, pr, pathname };
}

/** True when `pathname` is under the revkit-owned bundle root. Used to
 * enforce ADR-0012's "never redirects" rule at the one place that could
 * redirect. */
export function isRevkitBundlePath(pathname: string): boolean {
  return pathname === REVKIT_BUNDLE_ROOT.slice(0, -1) || pathname.startsWith(REVKIT_BUNDLE_ROOT);
}
