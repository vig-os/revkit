// Consumer-root plumbing (M5 part 2, DESIGN-0002 §5, issue #57).
//
// When `revkit build` renders a CONSUMER repo through the packaged
// site, it exports `REVKIT_CONSUMER_ROOT=<absolute-consumer-repo-path>`
// into the astro/vite process. The site's `astro.config.mjs`,
// `content.config.ts`, and its `repoDocsLoader` / `plotsLoader` / vocab
// loader all read this file to decide whether they run in "own-repo"
// mode (revkit dogfooding itself) or "consumer" mode (rendering someone
// else's `docs/`, `vocab/`, `plots/` through the packaged pipeline).
//
// The rule: **when the env var is absent, every consumer-mode branch
// evaluates to the same value the current code produces today.** This
// keeps revkit's own build byte-for-byte the same (the "own build
// unchanged" acceptance for issue #57).
//
// Kept in one file so the flag is read once, and so tests can
// stub it via env instead of monkey-patching every module.

/** Read `REVKIT_CONSUMER_ROOT` from the process env. Trimmed. Returns
 * `null` when unset or blank — so consumer-mode branches can be
 * expressed as a falsy check. Absolute path is REQUIRED; a
 * relative value is rejected. */
export function readConsumerRoot(): string | null {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.REVKIT_CONSUMER_ROOT;
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith("/")) {
    throw new Error(
      `REVKIT_CONSUMER_ROOT must be an absolute path (got '${trimmed}'). Set it via 'revkit build' or unset it.`,
    );
  }
  return trimmed;
}

/** Env var name — kept in one place so a rename shows up in every
 * caller as a compile error. */
export const CONSUMER_ROOT_ENV = "REVKIT_CONSUMER_ROOT" as const;

/** Cache-dir env vars (set by `revkit build` so astro/vite write
 * caches under `<consumer>/.revkit/cache/…` and NEVER inside the
 * packaged site — the nix store is read-only). */
export const ASTRO_CACHE_DIR_ENV = "REVKIT_ASTRO_CACHE_DIR" as const;
export const VITE_CACHE_DIR_ENV = "REVKIT_VITE_CACHE_DIR" as const;

/** Base-path env var (#245 part 1 round 3). Set by `revkit build
 * --base <path>` so Astro emits prefixed asset and page URLs at
 * build time. The daemon serves the built pages under the matching
 * guard policy's `basePath` but never rewrites bodies — the base
 * path is a BUILD-TIME + RUNTIME property (ADR-0026 §"Plain Linux
 * host / VM" sub-path deployment), not a response rewrite.
 *
 * Shape: `/` (or empty) is the root deployment (the default; the
 * local daemon never sets this). Otherwise a leading slash + no
 * trailing slash, e.g. `/review`. Trailing slashes are stripped by
 * `normaliseBasePath` so `/review/` and `/review` collapse to one
 * canonical form, matching `createPublicOriginGuardPolicy`'s own
 * `basePath` derivation. */
export const BASE_PATH_ENV = "REVKIT_BASE_PATH" as const;

/** Read `REVKIT_BASE_PATH` from the process env and canonicalise it.
 * Returns `""` for unset / blank / `/` — the root deployment. A
 * leading slash is required; a trailing slash is stripped; a value
 * that is neither empty nor starts with `/` is rejected with a
 * clear error (the build fails loudly rather than ship with a
 * subtly wrong base).
 *
 * The companion `baseMetaContent` renders the value with the
 * TRAILING slash the browser's `URL` constructor wants when
 * resolving a `path` that starts with `/` against it — see
 * `packages/cli/src/rail/url.ts`. */
export function readBasePath(): string {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.REVKIT_BASE_PATH;
  if (raw === undefined || raw === null) return "";
  return normaliseBasePath(raw);
}

/** Canonicalise a user-supplied base path. Shared with
 * `revkit build --base` so the CLI and the astro config agree on
 * one shape. Exported from the site lib because it has no node:*
 * dependency and both consumers can import it. */
export function normaliseBasePath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed === "/") return "";
  if (!trimmed.startsWith("/")) {
    throw new Error(
      `REVKIT_BASE_PATH must start with '/' (got ${JSON.stringify(raw)}). Example: '/review'.`,
    );
  }
  // Strip any run of trailing slashes so `/review/` and `/review`
  // collapse to one canonical value.
  return trimmed.replace(/\/+$/u, "");
}

/** The value to stamp into `<meta name="revkit-base" content="…">`
 * at build time. Normalised to ALWAYS end in a slash so the rail's
 * runtime resolver treats it as a directory prefix:
 *   - root deployment → `/`
 *   - sub-path `/review` → `/review/`
 *
 * The rail's `revkitUrl(path)` helper resolves `path` (which starts
 * with `/`) against this value, so a trailing slash is required to
 * keep the prefix intact. */
export function baseMetaContent(basePath: string): string {
  if (basePath.length === 0) return "/";
  return basePath.endsWith("/") ? basePath : `${basePath}/`;
}

/** `<meta name="…">` the layout stamps at build time. The rail reads
 * it at runtime (`packages/cli/src/rail/url.ts`); re-exported from
 * one place so a rename shows up as a compile error on every reader
 * that imports this constant. */
export const BASE_META_NAME = "revkit-base" as const;
