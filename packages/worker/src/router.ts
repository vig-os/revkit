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
// approved, and whether `/_revkit/` exists — all slice 3. What is here is the
// recogniser, so slice 3 has one tested parser to build on instead of a regex
// it writes itself.
//
// **What slice 5 added, and why it belongs in this file.** The scope axis. A
// route's scope is `parsePreviewPath`'s `(repo, pr)` — plus the `logKey` those
// two derive, which is how `migrations/0003_scoped_logs.sql` partitions one
// deployment's many reviews into one log each. Both halves come from HERE, from
// the grammar, so "which review is this request for" has exactly one answer in
// the package: the path. Nothing else derives it, nothing reads it from a
// header, and nothing a caller can set influences it.

/** A parsed preview path. */
export interface PreviewRef {
  /** The repository segment, as it appeared in the path. */
  readonly repo: string;
  /** The PR number, as a positive integer. */
  readonly pr: number;
  /** The raw pathname, kept so a caller can build R2 keys from exactly
   * what was requested rather than from a re-serialised form. */
  readonly pathname: string;
  /**
   * This preview's identity as one review's log — `previewScopePath(repo, pr)`,
   * which is the two-segment scope path, NOT the requested pathname.
   *
   * **It is the same string as the scope path on purpose.** ADR-0008's preview
   * address and the partition `migrations/0003_scoped_logs.sql` puts on
   * `review_logs` are one spelling here, so a route's `scope` carries both
   * halves and there is no second derivation of a log key anywhere in this
   * package. A separate `logKey(repo, pr)` function would be one more function
   * that could disagree with the path grammar, and the disagreement would be a
   * cross-review read.
   */
  readonly logKey: string;
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

/**
 * Is this a repository name this surface is willing to act on?
 *
 * **One predicate, two consumers, and the second one is load-bearing.** Slice
 * 3 compares an invite's `repo` column against a preview path's repository
 * segment on every authorized guest request (ADR-0012's per-call scope check),
 * and that comparison is only sound if both sides were validated by the SAME
 * rule. Two patterns would leave inputs that one side accepts and the other
 * rejects, and a scope check that misses those is a cross-repo read.
 *
 * Exported rather than re-implemented in `src/invites.ts`, and re-implemented
 * is exactly what this avoids: a copy would also be a second thing to widen.
 */
export function isRepoName(value: string): boolean {
  return REPO_SEGMENT.test(value);
}

/** The `pr-<n>` segment. `\d{1,9}` caps the number at nine digits so a
 * path cannot carry an unbounded integer into a key, and the bound is
 * far above any real PR number. Leading zeros are REFUSED rather than
 * accepted-and-normalised: two spellings of one PR would produce two
 * distinct R2 prefixes for one preview, which is exactly the aliasing
 * ADR-0012 forbids for `/_revkit/`. */
const PR_SEGMENT = /^pr-([1-9][0-9]{0,8})$/;

/**
 * ADR-0008's preview address for one review, without a trailing slash:
 * `/<repo>/pr-<n>`.
 *
 * **This string is the log key** (see `PreviewRef.logKey`), which is why it lives
 * here, beside the grammar that produces the two halves of it, rather than in
 * the store that consumes it. `index.ts` builds the redemption's redirect target
 * from it and `classifyRoute` carries it as `Route.scope.logKey`; both spellings
 * come from this one function.
 *
 * No validation: callers pass values `parsePreviewPath` already accepted, and a
 * second predicate here would be a second rule to keep in step with the first.
 * The value is still safe to interpolate into a D1 bind parameter, because a
 * bind parameter is never concatenated into SQL.
 */
export function previewScopePath(repo: string, pr: number): string {
  return `/${repo}/pr-${pr}`;
}

/**
 * `GET|HEAD <repo>/pr-<n>/api/threads` — the scoped read, and the ONLY spelling
 * of it (slice 5).
 *
 * **Why the API lives under the preview rather than beside it.** `GET /api/threads`
 * named no repository, so ADR-0012's per-call scope check had nothing to select
 * on and every authorized caller — including a stranger holding a guest invite —
 * read the whole org's log. Putting the scope **in the path** fixes three things
 * at once, and each is a property rather than a convenience:
 *
 *   1. It cannot be forgotten, because there is no unscoped spelling to forget.
 *      `/api/threads` is no longer a route: `repo === API_SEGMENT` already made
 *      `parsePreviewPath` refuse it, and with the constant gone it classifies as
 *      `unknown` and answers 404 for every caller, guest or operator.
 *   2. It is not a parameter, so it is not attacker-chosen. `parseThreadsQuery`
 *      refuses every parameter but `since`, so `?log_key=`/`?repo=`/`?scope=` are
 *      400s rather than a way to pick somebody else's log.
 *   3. It matches ADR-0008 rather than inventing a second convention — the same
 *      `<repo>/pr-<n>` the R2 preview keys will be built from.
 *
 * **The base must be exactly two segments.** `/<repo>/pr-<n>/docs/api/threads` is
 * a path INSIDE a built site that happens to end in the API suffix, and it is
 * refused here: `parsePreviewPath` ignores everything after the PR segment, so
 * without this check a preview of a document called `api/threads` would answer
 * the review's thread log.
 */
export function parseScopedThreadsPath(pathname: string): PreviewRef | undefined {
  if (!pathname.endsWith(SCOPED_THREADS_SUFFIX)) return undefined;
  const base = pathname.slice(0, pathname.length - SCOPED_THREADS_SUFFIX.length);
  const preview = parsePreviewPath(base);
  if (preview === undefined) return undefined;
  if (base.split("/").length !== SCOPED_SEGMENTS) return undefined;
  return preview;
}

/** The suffix a preview's own thread API hangs off. Named, because the route
 * table, the store's log key and the tests all have to agree about it. */
export const SCOPED_THREADS_SUFFIX = "/api/threads";

/**
 * `<repo>/pr-<n>` + the API suffix — the URL of one review's thread read.
 *
 * **Named because four modules need this string and a template repeated four
 * times is four things that can disagree** (the `duplication` gate measured the
 * clone at exactly four sites). It is also the pair the tests assert the route
 * table against, so a caller that builds the path any other way is immediately
 * wrong rather than subtly right.
 */
export function scopedThreadsPath(repo: string, pr: number): string {
  return `${previewScopePath(repo, pr)}${SCOPED_THREADS_SUFFIX}`;
}

/** `"/<repo>/pr-<n>"` splits into exactly three parts; a deeper base is a built
 * site's path, not the API. Stated as a count rather than a shape test so the
 * rule has one name. */
const SCOPED_SEGMENTS = 3;

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
  if (!isRepoName(repo)) return undefined;
  const match = PR_SEGMENT.exec(prSegment);
  if (match === null) return undefined;
  const pr = Number.parseInt(match[1] as string, 10);
  if (!Number.isSafeInteger(pr) || pr < 1) return undefined;
  return { repo, pr, pathname, logKey: previewScopePath(repo, pr) };
}

/** True when `pathname` is under the revkit-owned bundle root. Used to
 * enforce ADR-0012's "never redirects" rule at the one place that could
 * redirect. */
export function isRevkitBundlePath(pathname: string): boolean {
  return pathname === REVKIT_BUNDLE_ROOT.slice(0, -1) || pathname.startsWith(REVKIT_BUNDLE_ROOT);
}

// ── the `?since=` query on the thread read ─────────────────────────────────

/** The only query parameter `GET /api/threads` accepts. */
export const SINCE_PARAM = "since";

/**
 * A canonical non-negative decimal integer: no sign, no leading zero unless
 * the value IS `0`, no radix prefix, no exponent, no decimal point, no
 * surrounding whitespace, no thousands separator, and at most 16 digits so a
 * path cannot carry an unbounded integer into a query.
 *
 * Every one of those refusals is a real spelling, not a hypothetical: `?since=`
 * (empty) means the client lost its resume point, `?since=-1` would ask for
 * the whole log by a route that is supposed to ask for a DELTA, `?since=1e3`
 * and `?since=0x10` are the two ways a number can be written and read as
 * different numbers by different parsers, and `?SINCE=1` is a case variant
 * that a case-insensitive read would treat as a different parameter entirely.
 * Refusing them with 400 is the point: the alternative — coerce and hope —
 * is how a resume point silently becomes "from 0" and a client re-reads the
 * whole log on every poll.
 */
const CANONICAL_INTEGER = /^(?:0|[1-9][0-9]{0,15})$/;

/** The parse result, as a union rather than a `number | undefined` so
 * "absent" and "malformed" cannot be confused by a caller: `undefined` used
 * to mean both, which is exactly the confusion that produced slice 1's
 * "a query string never turns the 501 into anything else" test. */
export type ThreadsQuery =
  | { readonly kind: "full" }
  | { readonly kind: "delta"; readonly since: number }
  | {
      readonly kind: "invalid";
      /** A CLOSED vocabulary of reasons — this string is returned in the
       * response body, so it must never be built from the input. */
      readonly reason: "since-not-a-canonical-integer" | "since-repeated" | "unknown-parameter";
      /** The offending parameter NAME, or `"since"` — a name is a bounded
       * token, never a value, so this is safe to echo. */
      readonly parameter: string;
    };

/**
 * Parse the scoped read's query string.
 *
 * **Unknown parameters are REFUSED, not ignored.** Ignoring them is how a
 * second spelling of a request grows unnoticed.
 *
 * **Slice 5 did NOT add a parameter here, and that is the design.** The obvious
 * way to scope a read is `GET /api/threads?repo=…&pr=…`, and the refusal below
 * was written to stop exactly that spelling shipping by accident. Instead the
 * scope moved into the PATH — `<repo>/pr-<n>/api/threads`, `parseScopedThreadsPath`
 * — which is strictly better: a path is structural (a caller cannot forget to
 * send one, and there is no query string to tamper with in transit), and it is
 * ADR-0008's own address rather than a second convention.
 *
 * So this refusal is now load-bearing rather than prophylactic, and
 * `test/authorization.test.ts` drives `?repo=`, `?scope=` and `?log_key=` at the
 * scoped read and asserts 400 `unknown-parameter` for each — the spellings a
 * caller would reach for if the scope were not in the path.
 *
 * `parameter` is the name and never the value: a reflected value in a
 * response body is a reflected-XSS vector the moment anything renders it.
 */
export function parseThreadsQuery(search: string): ThreadsQuery {
  const params = new URLSearchParams(search);
  let since: number | undefined;
  for (const [name, value] of params) {
    if (name !== SINCE_PARAM) return { kind: "invalid", reason: "unknown-parameter", parameter: name };
    if (since !== undefined) return { kind: "invalid", reason: "since-repeated", parameter: SINCE_PARAM };
    if (!CANONICAL_INTEGER.test(value)) {
      return { kind: "invalid", reason: "since-not-a-canonical-integer", parameter: SINCE_PARAM };
    }
    since = Number.parseInt(value, 10);
  }
  return since === undefined ? { kind: "full" } : { kind: "delta", since };
}
