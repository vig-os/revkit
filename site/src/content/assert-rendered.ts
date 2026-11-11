// Structural "did markdown actually render?" check for the `docs` content
// collection (issue #237).
//
// Astro's glob loader (astro/dist/content/loaders/glob.js) wraps the per-entry
// markdown render in a try/catch: on failure it logs the error and stores the
// entry with `rendered: undefined`. Starlight then renders an empty
// `sl-markdown-content`, `revkit build` exits 0, and `check-dist` sees valid
// HTML. A review surface that silently ships empty pages is a release-grade
// defect class; this module turns the silent catch into a loud build failure.
//
// Chosen approach: a STRUCTURAL check on astro's content data store.
//
//   - Enumerate every entry the docs loader placed on the store.
//   - For each entry with a non-empty source body, require a non-empty
//     `rendered.html`.
//   - Throw a typed error that names the source file and the entry id.
//
// Why NOT a logger / stderr hook: astro's glob loader emits the error via
// `logger.error(...)` (a structured call), but the string it writes is only
// a human-readable message; there is no structured channel through which
// to subscribe to "an entry failed to render". A structural check on the
// data store observes the SAME invariant (every entry promised a render
// produced one) without pattern-matching log text, and catches any other
// loader with the same silent-catch shape, not just astro's glob.
//
// The check runs INSIDE the composed docs loader (see `content.config.ts`),
// so a failure throws from `loader.load()`. Astro treats a load-time throw
// as a fatal content-sync error and exits non-zero — which is what makes
// `revkit build` surface the failure.

/** Minimal shape of an astro content-store entry we need to read. Kept
 * structural so this module does not take a hard type dependency on
 * astro's `DataEntry` (which lives under a dist path that moves between
 * releases). */
export interface ContentStoreEntry {
  readonly id: string;
  readonly body?: string;
  readonly filePath?: string;
  readonly rendered?: { readonly html?: string } | undefined;
}

/** Thrown by `assertEveryEntryRendered` when a docs entry has a non-empty
 * source body but rendered to empty (or missing) HTML. Carries the id
 * and the source path so callers can surface both. */
export class EmptyRenderedBodyError extends Error {
  readonly entryId: string;
  readonly source: string;
  readonly cause?: unknown;
  constructor(entryId: string, source: string, cause?: unknown) {
    super(
      `revkit content gate (#237): entry '${entryId}' (source: ${source}) ` +
        `has a non-empty source body but rendered to empty HTML. The markdown ` +
        `renderer silently failed; the built page would ship an empty ` +
        `sl-markdown-content region. See astro's build log above for the ` +
        `underlying render error.`,
    );
    this.name = "EmptyRenderedBodyError";
    this.entryId = entryId;
    this.source = source;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** Return `true` when `body` is MDX/markdown content that should render to
 * non-empty HTML. A body is only treated as "empty" when it has no
 * non-whitespace characters at all — a frontmatter-only doc (criterion 4)
 * has `body === ""` after astro strips the frontmatter, so `.trim()` catches
 * that case cleanly. */
export function hasNonEmptyBody(body: string | undefined): boolean {
  if (body === undefined) return false;
  return body.trim().length > 0;
}

/** Return `true` when the entry's rendered HTML has at least one
 * non-whitespace character. A rendered entry whose `html` is the empty
 * string (or all whitespace) counts as empty too. */
export function hasNonEmptyRenderedHtml(
  rendered: ContentStoreEntry["rendered"],
): boolean {
  if (rendered === undefined) return false;
  const html = rendered.html ?? "";
  return html.trim().length > 0;
}

/** Walk the entries from one astro content store and throw the FIRST
 * `EmptyRenderedBodyError` found: a non-empty body that rendered to no
 * HTML. Entries with an empty body (frontmatter-only docs) are skipped,
 * so `index.md` with just `---\ntitle: X\n---\n` stays green (criterion
 * 4). Entries with `deferredRender: true` are also skipped — astro has
 * not yet asked for their render, and the guarantee this module enforces
 * (every rendered-entry has non-empty HTML) does not apply to them.
 *
 * Throws on the first violation rather than collecting every one, so the
 * build log leads with the originating file. The caller is expected to
 * run this once per load pass; a deterministic sort by id keeps the
 * "first" that surfaces stable across runs. */
export function assertEveryEntryRendered(
  entries: Iterable<readonly [string, ContentStoreEntry]>,
): void {
  const sorted = [...entries].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [id, entry] of sorted) {
    if (!hasNonEmptyBody(entry.body)) continue;
    // Deferred entries will render later via a virtual module; their
    // `rendered` is intentionally undefined at this point.
    if ((entry as { deferredRender?: boolean }).deferredRender === true) {
      continue;
    }
    if (!hasNonEmptyRenderedHtml(entry.rendered)) {
      const source = entry.filePath ?? id;
      throw new EmptyRenderedBodyError(id, source);
    }
  }
}
