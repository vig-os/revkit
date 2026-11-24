// Runtime base-path resolver for the rail bundle (#245 part 1
// round 3, DECISION c).
//
// **Why this exists.** A sub-path deployment serves revkit under
// `${publicOrigin}/review/…` — every API, SSE and asset request the
// rail makes must carry `/review` as its prefix. The previous shape
// server-side-rewrote absolute-path literals in response bodies; that
// missed template-literal URLs (`` `/api/threads/${id}/replies` ``),
// corrupted prose and the rail's own `"/"` path-normaliser, and
// could not tell URLs from data (ADR-0026 §"Plain Linux host / VM"
// — base path is BUILD-TIME + RUNTIME, never a response rewrite).
//
// The new shape:
//
//   1. **Build time.** `revkit build --base /review` sets Astro
//      `base` so every page/asset href is emitted prefixed, and the
//      layout stamps `<meta name="revkit-base" content="/review/">`
//      into the HTML.
//   2. **Runtime.** EVERY URL the rail opens goes through
//      `revkitUrl(path)` from this module. The helper reads the
//      meta content at mount, caches it, and resolves any
//      root-absolute `path` against the base. A missing meta
//      (local daemon, or an older build) falls back to `/` —
//      unchanged behaviour.
//
// The helper is intentionally a free function (no Solid signal, no
// reactivity): the base is a fixed property of the page the rail
// mounted into, so it is resolved ONCE at module load and reused.
// Any later URL built with it carries the prefix even when the
// caller used a template literal.
//
// **Static check (ADR-0026 compliance net).** A test under
// `packages/cli/test/rail/url.test.ts` reads the built rail bundle
// and refuses any root-absolute API, SSE or asset path outside the
// helper's own source, so a future contributor who typed
// `fetch("/api/…")` without going through `revkitUrl` is caught at
// `bun test` rather than on a reverse-proxy deployment.

/** `name` of the `<meta>` the layout stamps with the deployment's
 * base path at build time. Mirrors `BASE_META_NAME` in
 * `site/src/lib/consumer-root.ts`; duplicated as a literal because
 * the rail bundle is built for the BROWSER and must not import a
 * module that pulls in node:fs. A unit test asserts the two agree. */
export const BASE_META_NAME = "revkit-base";

/** Fallback when no meta tag is present. Matches the local daemon
 * (whose astro build does not emit a base) — the rail resolves
 * every `path` against `/`, i.e. identity. Normalised to end in `/`
 * so `resolve` below can use `startsWith` safely. */
const DEFAULT_BASE = "/";

/** Read the meta tag's `content`. Returns the DEFAULT_BASE when the
 * tag is missing or carries an empty / non-slash value — those are
 * the cases the rail treats as "no base". The injector and the
 * Astro layout only ever write a value that starts with `/` and
 * ends with `/`; anything else means someone hand-authored a page,
 * and falling back to `/` is safer than refusing to open a URL.
 *
 * Export is for unit tests ONLY: `revkitUrl` reads the base once
 * at module init and the cached value is what the rail actually
 * uses. */
export function readBaseMeta(
  doc: {
    querySelector: (selector: string) => { getAttribute: (name: string) => string | null } | null;
  } = typeof document !== "undefined" ? document : { querySelector: () => null },
): string {
  try {
    const raw = doc
      .querySelector(`meta[name="${BASE_META_NAME}"]`)
      ?.getAttribute("content");
    if (raw === null || raw === undefined) return DEFAULT_BASE;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return DEFAULT_BASE;
    if (!trimmed.startsWith("/")) return DEFAULT_BASE;
    return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  } catch {
    return DEFAULT_BASE;
  }
}

/** The cached base path, resolved once on module load. The rail is
 * a Solid island that mounts into a page the daemon has already
 * returned, so by the time any of its code runs the `<meta>` is in
 * the DOM. A later caller that wants the live value in a test
 * should call `readBaseMeta` directly. */
const CACHED_BASE: string = readBaseMeta();

/** Resolve a root-absolute path against the page's base. Accepts
 * any `path` that starts with `/` (that includes template-literal
 * URLs: `` `/api/threads/${id}/replies` ``); other shapes are
 * returned unchanged, so a fully qualified `https://…` URL or a
 * protocol-relative `//cdn` is passed through verbatim.
 *
 * Idempotent: a `path` that already starts with the base is left
 * alone, which matters for a page that carries both revkit-emitted
 * links (`/review/foo`) and rail-constructed URLs. */
export function revkitUrl(path: string): string {
  if (path.length === 0 || !path.startsWith("/") || path.startsWith("//")) {
    return path;
  }
  // DEFAULT_BASE is `/` and every rail path starts with `/`, so
  // identity returns the input unchanged. The host-sub-path case
  // strips the leading `/` and concatenates once.
  if (CACHED_BASE === DEFAULT_BASE) return path;
  // Idempotent: a caller that passed `/review/api/foo` by accident
  // (e.g. because they already called `revkitUrl` once) is handled.
  if (path === CACHED_BASE.slice(0, -1) || path.startsWith(CACHED_BASE)) return path;
  return CACHED_BASE + path.slice(1);
}
