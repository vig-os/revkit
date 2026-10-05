// ADR-0012's preview-path rules, as DATA and as one pure function.
//
// ADR-0012, first Decision bullet:
//
//   > **Preview paths never serve executable content.** Under `/<repo>/pr-<n>/`
//   > the Worker serves only HTML, JSON, images (PNG/JPEG/WebP/AVIF) and
//   > fonts; `.js`, `.mjs`, `.css`, `.wasm` and anything else are refused. SVG is
//   > served with `Content-Security-Policy: sandbox` and
//   > `Content-Disposition: inline` so it can't run script.
//
// and, in the hygiene bullet:
//
//   > the Worker derives `Content-Type` from the file extension against its own
//   > allowlist, **never from artifact or object metadata**.
//
// ── What this module decides, and what it deliberately does NOT read ─────────
//
// It takes the REQUEST PATH and the review's SCOPE PATH and answers one
// question: which object, typed how, or which refusal. **It never sees an R2
// object**, so there is no code path in this file that could read
// `httpMetadata.contentType` or `customMetadata` — the handler does not pass
// one in, and `test/preview.test.ts` plants a hostile `contentType` on a real
// object and asserts the response is typed from the extension.
//
// Two properties are worth stating because they are the reason this is a module
// and not four `switch` arms inside `index.ts`:
//
//   1. **The refusal is decided BEFORE the read.** The caller has to hold a
//      decision before it can name a key, so "refuse before the R2 read" is
//      structural here rather than a property of the order two statements
//      happen to be written in. `test/preview.test.ts` proves the read never
//      happens with a counting binding.
//   2. **The allowlist is a table, so adding a type is one line** and the
//      directory of what this surface can serve is readable without running
//      anything. ADR-0012's list is the table; nothing here widens it.
//
// ── Why the lookup is a `Map` and not a property read ────────────────────────
//
// An extension comes from a REQUEST PATH, so it is attacker-chosen, and
// `MEDIA_TYPES[ext]` on a plain object answers `"constructor"` and
// `"toString"` from `Object.prototype` — a non-undefined value for an extension
// nobody allowlisted, typed as whatever that function carries. A `Map` has no
// prototype chain, so a miss is a miss. This is the whole reason the two
// structures below exist rather than one.

/**
 * Which wrapper in `src/headers.ts` a served object goes through — a subset of
 * the shared policy's `ResponseKind`, because these are the four the preview
 * surface can produce.
 *
 *   - `html` — the preview document: `applyHtmlHeaders`, the FULL ADR-0012 CSP.
 *   - `svg` — `applySvgHeaders`: minimal CSP **plus `sandbox`** and
 *     `Content-Disposition: inline`, so a PR's SVG cannot run script.
 *   - `json` — `applyJsonHeaders`, which also carries `Cache-Control: no-store`.
 *   - `asset` — images and fonts: `applyAssetHeaders`, and deliberately NO CSP
 *     of its own, because browsers apply the EMBEDDING document's CSP to
 *     subresource loads and a `default-src 'none'` here would deny the
 *     document's own load of the asset.
 */
export type PreviewObjectKind = "html" | "json" | "svg" | "asset";

interface PreviewMediaType {
  readonly contentType: string;
  readonly kind: PreviewObjectKind;
}

/**
 * The extension → `Content-Type` allowlist, as DATA.
 *
 * **Exactly ADR-0012's list, and nothing else.** Two readings of that list are
 * deliberately refused rather than resolved:
 *
 *   - **`.xml` is not served.** The bullet names HTML, JSON, images, fonts and
 *     (by its own sentence) SVG. An XML document is a thing a browser renders
 *     as a document — the shared policy has an `xml` kind for exactly that
 *     reason — so serving a PR's `sitemap.xml` would be serving PR-controlled
 *     content this ADR does not say is safe. It is a one-line addition if a
 *     slice ever needs it, with `buildMinimalCspHeader("xml")` behind it.
 *   - **`.txt` is not served**, for the same reason: it is not on the list, and
 *     "harmless" is not a category this allowlist has.
 *
 * The keys are lowercase and looked up EXACTLY, so `.PNG` and `.Png` are
 * misses rather than folds: a case-insensitive lookup would make the set of
 * accepted spellings larger than the set of accepted types, and the second is
 * the one the ADR states.
 */
export const PREVIEW_MEDIA_TYPES: Readonly<Record<string, PreviewMediaType>> = Object.freeze({
  html: { contentType: "text/html; charset=utf-8", kind: "html" },
  json: { contentType: "application/json; charset=utf-8", kind: "json" },
  svg: { contentType: "image/svg+xml", kind: "svg" },
  png: { contentType: "image/png", kind: "asset" },
  jpg: { contentType: "image/jpeg", kind: "asset" },
  jpeg: { contentType: "image/jpeg", kind: "asset" },
  webp: { contentType: "image/webp", kind: "asset" },
  avif: { contentType: "image/avif", kind: "asset" },
  woff: { contentType: "font/woff", kind: "asset" },
  woff2: { contentType: "font/woff2", kind: "asset" },
});

/** Every extension this surface serves, sorted — the allowlist as a list, so a
 * test can assert against the whole directory rather than against the types it
 * happens to exercise. Derived, never written a second time. */
export const ALLOWED_PREVIEW_EXTENSIONS: readonly string[] = Object.freeze(
  Object.keys(PREVIEW_MEDIA_TYPES).sort(),
);

/** The lookup, built from the table above. `Map` for the reason in this file's
 * header; the table stays the data and this stays the index over it. */
const MEDIA_TYPES: ReadonlyMap<string, PreviewMediaType> = new Map(Object.entries(PREVIEW_MEDIA_TYPES));

/** What a preview's own trailing slash resolves to.
 *
 * **Without this, the product's own entry point is a 404.** The redemption
 * answers `303` to `previewScopePath(repo, pr) + "/"`, so `<repo>/pr-<n>/` is the
 * first URL every guest and every `Location` in this Worker names. An empty
 * trailing path has no extension and would be refused by the rule below, which
 * would leave the surface with no reachable document at all.
 *
 * It is a CONSTANT, not a lookup: `index.html` is allowlisted, so the result of
 * appending it is decided by the same table as any other name — there is no
 * second path to an HTML response here. A DIRECTORY request that does not end in
 * a slash (`…/pr-7/docs`) is still refused, because `docs` has no extension and
 * inventing `docs/index.html` would make "no extension" mean "whatever a build
 * happened to emit". */
export const PREVIEW_INDEX_OBJECT = "index.html";

/** Every reason the preview surface can refuse a path, as one closed list, and
 * `PreviewRefusal` derived from it — so a new reason cannot be produced without
 * being registered, and it cannot reach a response body or a log line from
 * request content. Every member is a property of the PATH's shape, never of a
 * file's existence. */
export const PREVIEW_REFUSALS = [
  /** The pathname does not sit under the scope path it was classified with.
   * Unreachable over HTTP (`previewScopePath` is a literal prefix of every path
   * `parsePreviewPath` accepted) and pinned because this module must be safe for
   * a caller that got there another way. */
  "scope-mismatch",
  /** An empty segment: two spellings of one path must not both resolve. */
  "doubled-slash",
  /** `%2e`, `%2f` or `%5c`, case-insensitively. `parsePreviewPath` refuses
   * these before the route is classified, so this is the same rule at the place
   * a key is actually built. */
  "encoded-separator",
  /** A `.` or `..` segment. */
  "traversal",
  /** A trailing dot: `index.html.` is a name the extension table cannot speak
   * about, and a platform that strips trailing dots would answer it with
   * `index.html`'s bytes under a spelling nobody allowlisted. */
  "trailing-dot",
  /** No extension at all, or a name that is nothing but an extension (`.html`),
   * or a trailing-slash name (`docs/`). */
  "no-extension",
  /** The extension is not in the table — which is where `.js`, `.mjs`, `.css`,
   * `.wasm`, `.HTML` and every double extension land (`x.html.js`'s extension
   * IS `js`). */
  "extension-not-allowlisted",
] as const;

export type PreviewRefusal = (typeof PREVIEW_REFUSALS)[number];

/** One object to read, and how to type it. Produced only on the serve path. */
export interface PreviewObjectTarget {
  /** The path inside the review, e.g. `docs/index.html`. Kept so a log line or
   * a test can name what was asked for without re-deriving it from the key. */
  readonly objectPath: string;
  /**
   * The R2 key: `<repo>/pr-<n>/<objectPath>`, with **no leading slash**.
   *
   * **The layout is DESIGN-0001 §6.1's, not a new one.** That section says R2
   * holds "one built site per `<repo>/pr-<n>/`", and `previewScopePath` already
   * spells a review as `/<repo>/pr-<n>`. So the key is that scope path with its
   * leading slash dropped and the built site's path appended — which means the
   * key is derived from the SAME string the log partition uses, and one review's
   * objects can never share a prefix with another's.
   */
  readonly key: string;
  /** From the table above, i.e. from the PATH. Never from the object. */
  readonly contentType: string;
  readonly kind: PreviewObjectKind;
}

export type PreviewTargetDecision =
  | { readonly kind: "serve"; readonly target: PreviewObjectTarget }
  | { readonly kind: "refused"; readonly reason: PreviewRefusal };

/**
 * Resolve one request path against one review's scope, or refuse it.
 *
 * `scopePath` is the route's `PreviewScope.logKey` (`/<repo>/pr-<n>`) and
 * `pathname` is the request's normalised pathname. Both come from the same
 * `classifyRoute` call, so the key cannot be built from anything the caller
 * supplied separately.
 *
 * **Total, pure, and it reads no object.** That is the whole security argument:
 * a PR-controlled artefact cannot get its own bytes typed as anything, because
 * nothing here has seen the artefact.
 */
export function previewTargetFor(scopePath: string, pathname: string): PreviewTargetDecision {
  const prefix = `${scopePath}/`;
  if (!pathname.startsWith(prefix)) return refused("scope-mismatch");
  const requested = pathname.slice(prefix.length);
  if (requested.includes("//")) return refused("doubled-slash");
  if (ENCODED_SEPARATOR.test(requested)) return refused("encoded-separator");
  for (const segment of requested.split("/")) {
    if (segment === "." || segment === "..") return refused("traversal");
  }
  const objectPath = requested === "" ? PREVIEW_INDEX_OBJECT : requested;
  // The NAME, not the path: `docs/` and `docs` are both refused here, and a
  // directory with an extension in an earlier segment (`docs.js/index.html`) is
  // not — the extension that decides the type is the one on the file.
  const name = objectPath.slice(objectPath.lastIndexOf("/") + 1);
  if (name.endsWith(".")) return refused("trailing-dot");
  const dot = name.lastIndexOf(".");
  // `dot === -1` is "no extension"; `dot === 0` is a name that is nothing but
  // one (`.html`), which has no name to attach a type to and is refused with the
  // same reason rather than served as the document it looks like.
  if (dot <= 0) return refused("no-extension");
  const media = MEDIA_TYPES.get(name.slice(dot + 1));
  if (media === undefined) return refused("extension-not-allowlisted");
  return {
    kind: "serve",
    target: {
      objectPath,
      key: `${scopePath.slice(1)}/${objectPath}`,
      contentType: media.contentType,
      kind: media.kind,
    },
  };
}

/** `%2e` is a dot, `%2f` a slash and `%5c` a backslash, and a WHATWG path
 * treats a backslash as a separator — so all three are a second spelling of a
 * traversal. Matched case-insensitively because the hex digits are, and because
 * `parsePreviewPath` matches them the same way: this is the same rule, not a
 * second one. */
const ENCODED_SEPARATOR = /%2e|%2f|%5c/i;

function refused(reason: PreviewRefusal): PreviewTargetDecision {
  return { kind: "refused", reason };
}
