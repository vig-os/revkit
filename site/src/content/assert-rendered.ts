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
//   - Throw a typed error that names the source file AND carries the
//     underlying render error captured off the loader context's logger.
//
// Why NOT a logger / stderr hook for the OBSERVATION: astro's glob loader
// emits the error via `logger.error(...)` (a structured call), but the string
// it writes is only a human-readable message; there is no structured channel
// through which to subscribe to "an entry failed to render". A structural
// check on the data store observes the SAME invariant (every entry promised
// a render produced one) without pattern-matching log text, and catches any
// other loader with the same silent-catch shape, not just astro's glob.
//
// However, the structured observation alone is not enough for a GOOD error
// message. The loader's `logger.error` is also the ONE place the underlying
// render error surfaces at — astro does not re-throw it. So `wrapLogger`
// here intercepts those `error(...)` calls and keeps per-entry
// messages in a side-channel map that `assertEveryEntryRendered` reads to
// attach the render error to the thrown `EmptyRenderedBodyError`.
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

/** Return the dist-relative HTML path Starlight writes for a docs
 * entry whose store id is `entryId`. Astro's glob loader stores the
 * SLUG as the entry id (see `astro/dist/content/loaders/glob.js`'s
 * `generateIdDefault` which returns the already-slugified path), so
 * no re-slugging is needed — `entry.id` already honours
 * `github-slugger` + any explicit `slug:` frontmatter. The remaining
 * work is Starlight-specific:
 *
 *   - `""` (root slug) and `"index"` (Starlight's
 *     `normalizeIndexSlug` in `@astrojs/starlight/dist/utils/routing`)
 *     both route to `/` → `index.html`.
 *   - Every other slug `foo/bar` routes to `/foo/bar/` →
 *     `foo/bar/index.html`.
 *
 * Shared by the astro-side loader (to build the manifest) AND the
 * assert path (to report the dist page for a failed entry). */
export function distPathFromEntryId(entryId: string): string {
  const normalised =
    entryId === "" || entryId === "index"
      ? ""
      : entryId.replace(/^\/+|\/+$/g, "");
  return normalised.length === 0 ? "index.html" : `${normalised}/index.html`;
}

/** Optional context the caller may thread in to improve the error. */
export interface AssertEveryEntryRenderedOptions {
  /** Side channel from `wrapLogger`: per-entry underlying render error.
   * The key is the string astro's glob loader passes to
   * `logger.error('Error rendering <id>: <message>')` — i.e. the entry
   * basename. When present, the thrown error carries the matched
   * message as its `cause` AND in the formatted `.message`. */
  readonly renderErrorsByEntryBasename?: ReadonlyMap<string, string>;
  /** When set, the source path is rewritten relative to this absolute
   * consumer root; astro reports `filePath` relative to the staging
   * root (e.g. `src/content/docs/bad-math.md`), and `revkit build`
   * symlinks `<staging>/src/content/docs/` → `<consumer>/docs/`, so
   * stripping the `src/content/` prefix gives the consumer-visible
   * path (`docs/bad-math.md`). When this option is absent the raw
   * `filePath` (own-repo mode) is reported. */
  readonly consumerRoot?: string;
}

/** Thrown by `assertEveryEntryRendered` when a docs entry has a non-empty
 * source body but rendered to empty (or missing) HTML. Carries the id
 * and the source path so callers can surface both. */
export class EmptyRenderedBodyError extends Error {
  readonly entryId: string;
  readonly source: string;
  readonly underlying: string | null;
  constructor(entryId: string, source: string, underlying: string | null) {
    const underlyingLine = underlying === null
      ? ""
      : `\n  Underlying render error: ${underlying}`;
    super(
      `revkit content gate (#237): entry '${entryId}' (source: ${source}) ` +
        `has a non-empty source body but rendered to empty HTML. The markdown ` +
        `renderer silently failed; the built page would ship an empty ` +
        `sl-markdown-content region.${underlyingLine}`,
    );
    this.name = "EmptyRenderedBodyError";
    this.entryId = entryId;
    this.source = source;
    this.underlying = underlying;
    if (underlying !== null) {
      // ES2022's `Error.cause` is settable through the two-arg
      // constructor; assigning via `Object.assign` keeps the TS lib
      // check happy under an older lib target while preserving the
      // runtime chain.
      Object.assign(this, { cause: new Error(underlying) });
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

/** Rewrite a staging-root-relative `filePath` to a consumer-root-relative
 * path when the packaged build is active (criterion 1: name the
 * consumer's source path, not `src/content/docs/...`). */
export function toConsumerPath(
  filePath: string,
  consumerRoot: string | undefined,
): string {
  if (consumerRoot === undefined) return filePath;
  // `<staging>/src/content/docs/` → `<consumer>/docs/`. Also handle the
  // alternate case where astro records a path already under `docs/`.
  const normalised = filePath.replace(/\\/g, "/");
  const strippedContent = normalised.replace(/^src\/content\//, "");
  return strippedContent;
}

/** Pattern the astro glob loader writes for every caught render error.
 * See `astro/dist/content/loaders/glob.js` ~:145:
 *
 *   logger.error(`Error rendering ${entry}: ${error.message}`);
 *
 * `entry` is the entry basename (unlike the entry id, which may carry
 * a directory prefix for nested files). We key the captured side-
 * channel map by that basename so lookup matches astro's own emit. */
const ASTRO_RENDER_ERROR_PREFIX = "Error rendering ";

/** Intercept `error(...)` calls on an astro loader context's logger
 * so every structured `Error rendering <entry>: <message>` line is
 * recorded into `out` keyed by the entry's basename, then forwarded
 * to the real logger. Returns a restore function that reinstalls the
 * original `error` method; callers run it in a `finally` to leave the
 * context clean for other consumers.
 *
 * In-place mutation (rather than a wrapped clone) keeps the types
 * simple and avoids the generic-constraint gymnastics that creating
 * a replacement `LoaderContext` would require. Astro keeps its
 * normal reference and sees the same side effects. */
export function captureRenderErrorsFromLogger(
  logger: LoggerLike,
  out: Map<string, string>,
): () => void {
  const original = logger.error;
  const bound = original.bind(logger);
  logger.error = (message: string) => {
    captureRenderError(message, out);
    bound(message);
  };
  return () => {
    logger.error = original;
  };
}

/** Internal — exported only for test. Parse astro's logger line and, if
 * it matches the "Error rendering <entry>: <message>" shape, record
 * `<entry>` → `<message>` on `out`. */
export function captureRenderError(
  message: string,
  out: Map<string, string>,
): void {
  if (!message.startsWith(ASTRO_RENDER_ERROR_PREFIX)) return;
  const rest = message.slice(ASTRO_RENDER_ERROR_PREFIX.length);
  const colonIdx = rest.indexOf(":");
  if (colonIdx === -1) return;
  const entry = rest.slice(0, colonIdx).trim();
  const detail = rest.slice(colonIdx + 1).trim();
  if (entry.length > 0 && detail.length > 0) {
    out.set(entry, detail);
  }
}

/** Minimal logger shape we need to wrap. Kept to the single method we
 * actually touch (`error`) so astro's own `AstroIntegrationLogger`
 * class — which has many more fields with concrete types — remains
 * assignable to this parameter type at the content.config.ts call
 * site. */
export interface LoggerLike {
  error: (message: string) => void;
}

/** Collect the dist-relative page paths for every docs entry with a
 * non-empty source body. Shared by the astro-side loader (to write
 * the manifest `revkit build` later passes to `check-dist`) and
 * directly by unit tests.
 *
 * Deferred entries are included: their body IS non-empty and astro
 * will render them later; a dist page whose content root is empty
 * for a deferred entry is still a defect. (The build-time assert
 * skips them because `rendered.html` is intentionally absent at the
 * moment of the check.) */
export function collectPagesFromStore(
  entries: Iterable<readonly [string, ContentStoreEntry]>,
): Set<string> {
  const out = new Set<string>();
  for (const [id, entry] of entries) {
    if (!hasNonEmptyBody(entry.body)) continue;
    out.add(distPathFromEntryId(id));
  }
  return out;
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
  options: AssertEveryEntryRenderedOptions = {},
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
      const rawSource = entry.filePath ?? id;
      const source = toConsumerPath(rawSource, options.consumerRoot);
      const underlying = findUnderlyingRenderError(
        id,
        rawSource,
        options.renderErrorsByEntryBasename,
      );
      throw new EmptyRenderedBodyError(id, source, underlying);
    }
  }
}

/** Look up the captured render error for one entry, trying the id, its
 * basename AND the source's basename (astro's glob loader logs the
 * glob entry name, which equals the file basename for flat layouts
 * and the relative path for nested ones). Returns `null` when nothing
 * matches so `EmptyRenderedBodyError`'s format skips the "Underlying"
 * line cleanly. */
function findUnderlyingRenderError(
  entryId: string,
  sourcePath: string,
  errors: ReadonlyMap<string, string> | undefined,
): string | null {
  if (errors === undefined) return null;
  // Candidates in order of preference: the id, the id's basename, the
  // source basename, and the full source path (normalised to /).
  const candidates = new Set<string>();
  candidates.add(entryId);
  const idBase = entryId.split("/").pop();
  if (idBase !== undefined) candidates.add(idBase);
  const normalisedSource = sourcePath.replace(/\\/g, "/");
  candidates.add(normalisedSource);
  const srcBase = normalisedSource.split("/").pop();
  if (srcBase !== undefined) candidates.add(srcBase);
  for (const key of candidates) {
    const hit = errors.get(key);
    if (hit !== undefined) return hit;
  }
  return null;
}
