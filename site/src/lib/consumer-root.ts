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
