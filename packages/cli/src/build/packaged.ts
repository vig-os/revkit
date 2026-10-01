// `revkit build` core (M5 part 2, issue #57, DESIGN-0002 §5).
//
// Renders a CONSUMER repo's `docs/` (plus `vocab/`, `plots/`) through
// the PACKAGED site (the nix output shipped with the CLI). The
// packaged site directory is READ-ONLY: it lives under
// `/nix/store/…/libexec/revkit/site/`, so this module stages a
// WRITABLE astro root under `<consumer>/.revkit/build/` where:
//
//   1. Every entry from the packaged site is symlinked in (config,
//      src/, scripts/, tsconfig, package.json). One exception:
//      `src/content/docs/` is a REAL directory holding a symlink
//      to `<consumer>/docs/` — Starlight's docsLoader reads from
//      the collection's default base and finds the consumer's tree
//      through this indirection.
//   2. `vocab/` and `plots/` (and `.revkit/`) at the STAGING root
//      are symlinks to the consumer's paths, so the content-config
//      loaders that read `../vocab/terms.yaml` and `../plots/…`
//      RELATIVE TO THE ASTRO PROJECT still land on the consumer's
//      files.
//   3. `<staging>/node_modules` is a symlink to the packaged root's
//      `node_modules` (the FOD-materialised dep tree) so astro,
//      Solid, Starlight, Tailwind, katex and every other dep resolve
//      through node's normal walk. Combined with `vite.resolve.
//      preserveSymlinks: true` (set in `astro.config.mjs` when
//      REVKIT_CONSUMER_ROOT is present), an MDX file at
//      `<staging>/src/content/docs/index.mdx` (symlink to
//      `<consumer>/docs/index.mdx`) resolves imports from the
//      staging path — not from `<consumer>/docs/` where there is
//      no node_modules.
//   4. Astro and vite caches are redirected to
//      `<consumer>/.revkit/cache/{astro,vite}/` via env
//      (`REVKIT_ASTRO_CACHE_DIR`, `REVKIT_VITE_CACHE_DIR`), which
//      the packaged `astro.config.mjs` picks up. This is why NOTHING
//      lands in the nix store or the packaged site.
//   5. HOME/TMPDIR are pinned to a per-build scratch (via the
//      shared `spawnAstroBuild` primitive).
//
// The site config's consumer-mode branch (`REVKIT_CONSUMER_ROOT` set)
// enumerates the consumer's `docs/` tree to build the Starlight
// sidebar (M5 part 2 sidebar decision, DESIGN-0002 §5 update:
// autogenerate from the consumer's own directory shape).

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAstroBuild, type SpawnLike } from "../review/build.ts";
import { unlinkStale } from "../review/build.ts";

/** Input to `runPackagedBuild`. */
export interface RunPackagedBuildOptions {
  /** Absolute path to the consumer's workspace root — the one that
   * carries the `revkit` marker in `package.json`. Its `docs/`,
   * `vocab/`, `plots/` are rendered. */
  readonly consumerRoot: string;
  /** Absolute path where astro should write its output. Defaults
   * to `<consumerRoot>/.revkit/dist` — see `defaultConsumerDist`. */
  readonly distOutDir?: string;
  /** Absolute path to the packaged CLI's package root — the
   * directory that contains `packages/`, `site/`, `node_modules/`
   * side by side (revkit repo checkout in dev; nix store output
   * in the packaged flow). When omitted, walks up from
   * `import.meta.url`. */
  readonly packageRoot?: string;
  /** Injectable spawner for tests. Defaults to the shared
   * `spawnAstroBuild`'s default (`Bun.spawn`). */
  readonly spawn?: SpawnLike;
}

/** Result of a successful packaged build. */
export interface RunPackagedBuildResult {
  /** Where astro wrote its output. */
  readonly distOutDir: string;
  /** Where staging lives — kept for debugging; the caller may
   * remove it. `revkit build` leaves it for a fast follow-up
   * `revkit serve` (no rebuild churn if content is unchanged). */
  readonly stagingDir: string;
  /** Packaged site root that was staged FROM. Reported so the
   * caller can print it in `stdout` and a test can assert it is
   * a nix-store path in the packaged flow. */
  readonly packagedSiteDir: string;
}

/** The default consumer dist directory. Kept as a constant so both
 * `revkit build` (which writes here) and `revkit serve` (which reads
 * here when `--dir` is absent) agree without a string copy. */
export function defaultConsumerDist(consumerRoot: string): string {
  return join(consumerRoot, ".revkit", "dist");
}

/** The default staging dir. */
export function defaultConsumerStaging(consumerRoot: string): string {
  return join(consumerRoot, ".revkit", "build");
}

/** Cache dirs under `<consumer>/.revkit/cache/`. Astro / Vite are
 * redirected here so nothing lands in the nix store or the packaged
 * site directory. */
export function consumerCacheDirs(consumerRoot: string): {
  readonly astro: string;
  readonly vite: string;
} {
  return {
    astro: join(consumerRoot, ".revkit", "cache", "astro"),
    vite: join(consumerRoot, ".revkit", "cache", "vite"),
  };
}

/** Walk from a caller-provided source URL (`import.meta.url`) up to
 * the packaged CLI's package root — the directory whose layout
 * is `packages/`, `site/`, `node_modules/`. In the packaged nix
 * flow that's `$out/libexec/revkit/`; in dev it's the repo
 * checkout. */
export function inferPackageRoot(fromFileUrl: string): string {
  // packages/cli/src/build/packaged.ts → four parents up.
  const here = fileURLToPath(fromFileUrl);
  return resolvePath(dirname(here), "..", "..", "..", "..");
}

/** The two layouts `bun install` produces in this repo — the
 * packaged CLI (nix FOD, `--linker=hoisted`, all deps at the
 * workspace root's `node_modules/`) and the dev shell (default
 * isolated linker, per-workspace `node_modules/`). Kept here as a
 * pair so `findPackagedTrustedStack` returns BOTH the astro
 * binary and the `node_modules/` dir whose contents match it —
 * `stageAstroRoot` must symlink node_modules from the same layout
 * that provides the binary. */
export interface TrustedStack {
  /** Absolute path to the `astro` binary. */
  readonly astroBin: string;
  /** Absolute path to the `node_modules/` directory that
   * contains every runtime dep — `@astrojs/*`, Solid, Tailwind,
   * `@revkit/*`, katex, etc. Used as the symlink target for
   * `<staging>/node_modules`. */
  readonly nodeModulesDir: string;
  /** Which layout: "hoisted" (packaged / FOD) or "isolated"
   * (dev). Reported for logging + tests. */
  readonly layout: "hoisted" | "isolated";
}

/** Locate the trusted stack inside the package. Handles both
 * hoisted (FOD, all deps at `<pkg>/node_modules/`) and isolated
 * (dev, per-workspace `<pkg>/site/node_modules/`) linker layouts.
 * Throws if neither exists — we NEVER fall back to `PATH` or
 * `bunx` / `npx` (a fetch-happy fallback would defeat the "no
 * registry" rule). */
export function findPackagedTrustedStack(packageRoot: string): TrustedStack {
  // Hoisted (FOD default in `nix/revkit-package.nix`) — root
  // node_modules holds all binaries AND all deps.
  const hoistedBin = join(packageRoot, "node_modules", ".bin", "astro");
  const hoistedNm = join(packageRoot, "node_modules");
  if (existsSync(hoistedBin) && existsSync(join(hoistedNm, "@astrojs", "starlight"))) {
    return { astroBin: hoistedBin, nodeModulesDir: hoistedNm, layout: "hoisted" };
  }
  // Isolated (dev: `bun install` in a workspace defaults to per-
  // workspace `.bin`). Astro AND @astrojs/starlight live under
  // `site/node_modules/`. This is the same layout `runSafeBuild`
  // in `review/build.ts` uses.
  const isolatedBin = join(packageRoot, "site", "node_modules", ".bin", "astro");
  const isolatedNm = join(packageRoot, "site", "node_modules");
  if (existsSync(isolatedBin) && existsSync(join(isolatedNm, "@astrojs", "starlight"))) {
    return { astroBin: isolatedBin, nodeModulesDir: isolatedNm, layout: "isolated" };
  }
  throw new Error(
    `revkit build: trusted astro stack not found in the packaged CLI. Looked at:\n` +
      `  ${hoistedBin} + ${hoistedNm}/@astrojs/starlight\n` +
      `  ${isolatedBin} + ${isolatedNm}/@astrojs/starlight\n` +
      `The package may be misassembled — see nix/revkit-package.nix.`,
  );
}

/** @deprecated pre-#57 export kept for tests. Prefer
 * `findPackagedTrustedStack` which returns node_modules too. */
export function findPackagedAstroBin(packageRoot: string): string {
  return findPackagedTrustedStack(packageRoot).astroBin;
}

/** Symlink a set of entries from `srcDir` into `dstDir`, one entry
 * at a time (per-entry symlinks so a resolver that walks INTO the
 * dir sees a real directory). Skips names in `skip`. */
function symlinkEntries(srcDir: string, dstDir: string, skip: ReadonlySet<string>): void {
  mkdirSync(dstDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    if (skip.has(name)) continue;
    const from = join(srcDir, name);
    const to = join(dstDir, name);
    unlinkStale(to);
    symlinkSync(from, to);
  }
}

/** Stage the writable astro root at `<consumer>/.revkit/build/`.
 *
 * Layout after staging:
 *
 *   <staging>/
 *     astro.config.mjs         → <packagedSite>/astro.config.mjs
 *     package.json             → <packagedSite>/package.json
 *     tsconfig.json            → <packagedSite>/tsconfig.json
 *     scripts/                 → <packagedSite>/scripts/       (real dir)
 *     src/
 *       lib/                   → <packagedSite>/src/lib
 *       styles/                → <packagedSite>/src/styles
 *       content.config.ts      → <packagedSite>/src/content.config.ts
 *       content/               (real dir; site-owned per-entry)
 *         schemas/             → <packagedSite>/src/content/schemas
 *         utils/               → <packagedSite>/src/content/utils
 *         loaders/             → <packagedSite>/src/content/loaders
 *         i18n/                → <packagedSite>/src/content/i18n
 *         docs/                → <consumer>/docs/       (CONSUMER's tree)
 *     public/                  → <packagedSite>/public/ (KaTeX assets;
 *                                 present after `prebuild` runs; when
 *                                 absent in the nix package, staging
 *                                 creates an empty dir)
 *     node_modules/            → <packageRoot>/node_modules/
 *     vocab/                   → <consumer>/vocab/     (optional)
 *     plots/                   → <consumer>/plots/     (optional)
 *     .revkit/                 → <consumer>/.revkit/
 */
/** Copy `from` to `to`, refusing every symlink in the tree that
 * escapes `confineRoot` (real-path resolved once at the top). This is
 * NOT the daemon's `resolveWithinRoot` — that primitive answers HTTP
 * requests one path at a time; here we walk a whole tree and refuse
 * fail-closed as we go. The two policies match ("no symlinks anywhere
 * in the chain that resolve outside the root"), and both are audited
 * whenever the shape of the containment check changes (see the header
 * on `serve/confined-path.ts`).
 *
 * The rule is deliberately strict: any symlink under the consumer's
 * `docs/` tree is refused, even one that points at a sibling INSIDE
 * `docs/`. Docs authoring does not need symlinks; a link surface
 * that big is not worth the review cost. `revkit check`'s file-
 * discovery walker follows the same policy for content dirs.
 *
 * Exported for direct testing. */
export function copyConfined(from: string, to: string, confineRoot: string): void {
  const st = lstatSync(from);
  if (st.isSymbolicLink()) {
    throw new Error(
      `revkit build: refusing symlink under the consumer's docs/ tree: ${from}. ` +
        `Docs must be plain files or directories — a symlink under docs/ is refused ` +
        `whether it escapes the root or not (matches revkit check's content-dir policy).`,
    );
  }
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true, mode: 0o755 });
    // Belt-and-braces: the symlink refusal above catches any link.
    // Also verify the physical `from` sits under `confineRoot` — a
    // caller who passes a `from` outside `confineRoot` (a bug in
    // the caller, not a hostile input) surfaces here rather than
    // in a later I/O.
    const fromReal = realpathSync(from);
    if (fromReal !== confineRoot && !fromReal.startsWith(confineRoot + "/")) {
      throw new Error(
        `revkit build: refusing to copy from outside the consumer's docs/ tree: ` +
          `${from} -> ${fromReal} (root ${confineRoot})`,
      );
    }
    for (const name of readdirSync(from)) {
      copyConfined(join(from, name), join(to, name), confineRoot);
    }
    return;
  }
  if (st.isFile()) {
    copyFileSync(from, to);
    return;
  }
  // Neither file nor directory nor symlink (fifo, socket, etc.).
  // Refuse — none of them belong in a docs tree.
  throw new Error(
    `revkit build: refusing non-regular entry under the consumer's docs/ tree: ${from}`,
  );
}

export function stageAstroRoot(options: {
  readonly consumerRoot: string;
  readonly packageRoot: string;
  readonly stagingDir: string;
  /** The trusted stack picked by `findPackagedTrustedStack` —
   * carries the node_modules dir that provides `<staging>/node_
   * modules`. Required so hoisted (packaged) and isolated (dev)
   * layouts stage the SAME deps that the astro binary was
   * built against. */
  readonly trustedStack: TrustedStack;
}): { readonly packagedSiteDir: string } {
  const { consumerRoot, packageRoot, stagingDir, trustedStack } = options;

  const packagedSiteDir = join(packageRoot, "site");
  if (!existsSync(packagedSiteDir) || !statSync(packagedSiteDir).isDirectory()) {
    throw new Error(
      `revkit build: packaged site directory not found at '${packagedSiteDir}'`,
    );
  }
  const packagedNodeModules = trustedStack.nodeModulesDir;
  if (!existsSync(packagedNodeModules)) {
    throw new Error(
      `revkit build: trusted node_modules not found at '${packagedNodeModules}'`,
    );
  }
  const consumerDocsDir = join(consumerRoot, "docs");
  if (!existsSync(consumerDocsDir)) {
    throw new Error(
      `revkit build: consumer's docs directory not found at '${consumerDocsDir}'. Add a docs/ tree first.`,
    );
  }

  // Clean staging so a previous run's stale symlinks (moved files,
  // renamed dirs) never carry over.
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true, mode: 0o755 });

  // Top-level packaged-site entries: symlink each, except src/
  // (fine-grained below) and node_modules/dist/.astro/.vite (never
  // needed; may not exist).
  symlinkEntries(
    packagedSiteDir,
    stagingDir,
    new Set(["src", "node_modules", "dist", ".astro", ".vite", "public", "tests"]),
  );

  // `public/` — a REAL directory in staging (never a symlink to
  // packaged), so `revkit build` can materialise KaTeX assets under
  // `<staging>/public/_katex/` without writing through into the
  // read-only nix store. If the packaged site has a `public/`
  // (dev mode where `prebuild` ran), per-entry symlink each of
  // its top-level entries in; then `writeKatexAssets` overlays
  // `_katex/`.
  const packagedPublic = join(packagedSiteDir, "public");
  const stagingPublic = join(stagingDir, "public");
  mkdirSync(stagingPublic, { recursive: true, mode: 0o755 });
  if (existsSync(packagedPublic)) {
    for (const name of readdirSync(packagedPublic)) {
      // Skip `_katex` — we write a fresh copy below (dev mode may
      // have a stale one from a previous `prebuild`, and the nix
      // package never ships one).
      if (name === "_katex") continue;
      const from = join(packagedPublic, name);
      const to = join(stagingPublic, name);
      unlinkStale(to);
      symlinkSync(from, to);
    }
  }

  // src/ — real dir, per-entry symlinks except content/.
  const srcSrc = join(packagedSiteDir, "src");
  const srcDst = join(stagingDir, "src");
  symlinkEntries(srcSrc, srcDst, new Set(["content"]));

  // src/content/ — real dir, per-entry symlinks except docs/.
  const contentSrc = join(srcSrc, "content");
  const contentDst = join(srcDst, "content");
  symlinkEntries(contentSrc, contentDst, new Set(["docs", "index.mdx", "math-and-plots.mdx"]));

  // src/content/docs/ — real dir; the consumer's docs tree is
  // COPIED here (not symlinked). Astro's built-in route resolver
  // constructs component URLs by joining a route's `component`
  // spec against `config.root`; when that component is an
  // injected Starlight route (`@astrojs/starlight/routes/...
  // .astro`), astro relies on node's module resolution to have
  // already resolved the specifier to a real path. If the docs
  // were symlinked in and vite ran with `preserveSymlinks: true`
  // (the only vite mode that keeps `<staging>/node_modules/` on
  // the walk path when the file was accessed through a symlink),
  // astro's routing would then look for the route file at
  // `<staging>/@astrojs/starlight/routes/...` and fail with
  // ENOENT. The copy trades a small IO cost for a
  // whole-toolchain-simple path.
  //
  // The copy uses `copyConfined` (below) which refuses any
  // symlink that would escape the consumer's docs root. Bare
  // `cpSync({ dereference: true })` chases symlinks blindly, so
  // a `docs/leak.md -> /etc/passwd` would land in
  // `.revkit/dist/leak/index.html` — a whole-file exfiltration
  // path visible via the daemon. The confined walker refuses
  // BEFORE the copy, matching `revkit check`'s existing symlink
  // refusal in content-owning dirs.
  const docsDst = join(contentDst, "docs");
  rmSync(docsDst, { recursive: true, force: true });
  mkdirSync(docsDst, { recursive: true, mode: 0o755 });
  const consumerDocsReal = realpathSync(consumerDocsDir);
  for (const name of readdirSync(consumerDocsDir)) {
    const from = join(consumerDocsDir, name);
    const to = join(docsDst, name);
    copyConfined(from, to, consumerDocsReal);
  }

  // node_modules — a REAL directory at staging with per-entry
  // symlinks into the trusted stack. NOT a single symlink to the
  // packaged deps: vite would then try to create
  // `<staging>/node_modules/.vite/` through the symlink, which
  // in the packaged flow resolves to a nix-store path and fails
  // with EACCES. A real dir lets vite drop its `.vite/` cache
  // alongside the deps at a writable path; the deps themselves
  // remain read-only under the store.
  //
  // Scoped `@astrojs/`, `@revkit/`, etc. get their entries
  // per-package (a resolver walking into the scope dir needs to
  // see a real directory).
  const stagingNodeModules = join(stagingDir, "node_modules");
  mkdirSync(stagingNodeModules, { recursive: true, mode: 0o755 });
  for (const name of readdirSync(packagedNodeModules)) {
    const from = join(packagedNodeModules, name);
    const to = join(stagingNodeModules, name);
    // `@scope` — real dir, per-package symlinks inside.
    if (name.startsWith("@") && statSync(from).isDirectory()) {
      mkdirSync(to, { recursive: true, mode: 0o755 });
      for (const pkgName of readdirSync(from)) {
        const pkgFrom = join(from, pkgName);
        const pkgTo = join(to, pkgName);
        unlinkStale(pkgTo);
        symlinkSync(pkgFrom, pkgTo);
      }
    } else {
      unlinkStale(to);
      symlinkSync(from, to);
    }
  }

  // Optional consumer data trees. The site's content.config.ts
  // reads `../vocab/terms.yaml` and `../plots/` RELATIVE TO THE
  // ASTRO PROJECT (i.e., `<staging>/../…`) — but staging is
  // `<consumer>/.revkit/build/`, so `<staging>/../` is
  // `<consumer>/.revkit/`. Symlink these entries INSIDE staging so
  // `<staging>/vocab/…` resolves — but that means the relative
  // path from the astro project (staging) is `./vocab/terms.yaml`,
  // NOT `../vocab/terms.yaml`.
  //
  // Rather than change the content-config's relative paths, we
  // create the following alternative layout: symlink
  // `<consumer>/.revkit/build-vocab` -> `<consumer>/vocab` and
  // teach content-config to read `../build-vocab/terms.yaml` in
  // consumer mode. That is fragile.
  //
  // Simpler: symlink the ACTUAL parent paths.
  // `<consumer>/.revkit/vocab` -> `<consumer>/vocab` (so
  // `../vocab/terms.yaml` from staging resolves).
  const stagingParent = dirname(stagingDir); // <consumer>/.revkit
  const consumerVocab = join(consumerRoot, "vocab");
  const parentVocab = join(stagingParent, "vocab");
  // Remove a stale symlink from a previous run; keep a REAL
  // directory (a consumer that manually created `.revkit/vocab/`
  // would signal something we should not overwrite).
  unlinkStale(parentVocab);
  if (existsSync(consumerVocab)) {
    symlinkSync(consumerVocab, parentVocab);
  }
  const consumerPlots = join(consumerRoot, "plots");
  const parentPlots = join(stagingParent, "plots");
  unlinkStale(parentPlots);
  if (existsSync(consumerPlots)) {
    symlinkSync(consumerPlots, parentPlots);
  }

  return { packagedSiteDir };
}

/** Materialise KaTeX CSS + woff2 fonts under `<stagingPublic>/_katex/`.
 * Ports the logic from `site/scripts/copy-katex-assets.ts`, but
 * (a) reads katex from the packaged root's `node_modules/katex/dist/`
 * so no `require.resolve` walk is needed at CLI runtime, and (b)
 * writes to the WRITABLE staging public dir instead of the
 * read-only packaged site.
 *
 * Absence is tolerated — the packaged CLI ships katex today, but a
 * future slim variant might not. When katex is missing the log
 * says so; astro will build without math-styled pages. */
export function writeKatexAssets(options: {
  /** node_modules dir of the trusted stack — same one that
   * `stageAstroRoot` symlinks into `<staging>/node_modules`. */
  readonly nodeModulesDir: string;
  readonly stagingPublic: string;
}): { copied: number; version: string } | null {
  const katexPackageJson = join(options.nodeModulesDir, "katex", "package.json");
  if (!existsSync(katexPackageJson)) return null;
  const katexDist = join(options.nodeModulesDir, "katex", "dist");
  const srcCss = join(katexDist, "katex.min.css");
  const srcFontsDir = join(katexDist, "fonts");
  if (!existsSync(srcCss) || !existsSync(srcFontsDir)) return null;

  const outDir = join(options.stagingPublic, "_katex");
  const outFontsDir = join(outDir, "fonts");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outFontsDir, { recursive: true, mode: 0o755 });
  copyFileSync(srcCss, join(outDir, "katex.min.css"));

  let copied = 0;
  for (const entry of readdirSync(srcFontsDir)) {
    if (!entry.endsWith(".woff2")) continue;
    const srcFile = join(srcFontsDir, entry);
    if (!statSync(srcFile).isFile()) continue;
    copyFileSync(srcFile, join(outFontsDir, entry));
    copied++;
  }
  if (copied === 0) return null;

  const pkg: unknown = JSON.parse(readFileSync(katexPackageJson, "utf8"));
  const version = pkg && typeof pkg === "object" && "version" in pkg && typeof (pkg as { version?: unknown }).version === "string"
    ? (pkg as { version: string }).version
    : "unknown";
  writeFileSync(
    join(outDir, "README.txt"),
    `Generated by revkit build from katex@${version}. Do not edit by hand.\n`,
  );
  return { copied, version };
}

/** Run the packaged build. Stages, spawns astro, returns paths. */
export async function runPackagedBuild(
  options: RunPackagedBuildOptions,
): Promise<RunPackagedBuildResult> {
  const consumerRoot = options.consumerRoot;
  if (!isAbsolute(consumerRoot)) {
    throw new Error(`revkit build: consumerRoot must be absolute (got '${consumerRoot}')`);
  }
  if (!existsSync(consumerRoot) || !statSync(consumerRoot).isDirectory()) {
    throw new Error(`revkit build: consumerRoot '${consumerRoot}' does not exist`);
  }

  const packageRoot = options.packageRoot ?? inferPackageRoot(import.meta.url);
  const trustedStack = findPackagedTrustedStack(packageRoot);

  const stagingDir = defaultConsumerStaging(consumerRoot);
  const distOutDir = options.distOutDir ?? defaultConsumerDist(consumerRoot);
  const caches = consumerCacheDirs(consumerRoot);
  mkdirSync(caches.astro, { recursive: true, mode: 0o755 });
  mkdirSync(caches.vite, { recursive: true, mode: 0o755 });

  const { packagedSiteDir } = stageAstroRoot({
    consumerRoot,
    packageRoot,
    stagingDir,
    trustedStack,
  });

  // KaTeX assets — dropped into staging's public/_katex/ so
  // pages with `$…$` math load their fonts self-hosted, matching
  // what `bun run build` in the revkit repo produces via
  // `site/scripts/copy-katex-assets.ts` at `prebuild` time.
  writeKatexAssets({
    nodeModulesDir: trustedStack.nodeModulesDir,
    stagingPublic: join(stagingDir, "public"),
  });

  await spawnAstroBuild({
    astroBin: trustedStack.astroBin,
    astroRoot: stagingDir,
    outDir: distOutDir,
    // The staging root already has astro.config.mjs (as a symlink)
    // — astro picks it up by default; no --config needed.
    // cwd = staging so node's resolver walks into
    // `<staging>/node_modules/` (symlink to packaged) and
    // `preserveSymlinks: true` in the config keeps that pointer
    // authoritative even when the file being resolved from is a
    // symlink to somewhere else.
    cwd: stagingDir,
    extraEnv: {
      REVKIT_CONSUMER_ROOT: consumerRoot,
      REVKIT_ASTRO_CACHE_DIR: caches.astro,
      REVKIT_VITE_CACHE_DIR: caches.vite,
      // Disable astro telemetry — deterministic build; no network.
      ASTRO_TELEMETRY_DISABLED: "1",
      // Keep Node's own `require.resolve` on the SYMLINK
      // path (`<staging>/node_modules/...`) rather than the
      // physical nix-store target. Paired with vite's
      // `resolve.preserveSymlinks: true` in the consumer-mode
      // astro config so every layer — astro's route resolver,
      // vite's module ids, expressive-code, the mdx integration
      // — reports paths that live inside `--root <staging>`.
      // Without this, astro's `normalizeFilename` corrupts
      // `/nix/store/...` module ids by prepending `<staging>`
      // (it treats out-of-root abs paths as relative).
      NODE_PRESERVE_SYMLINKS: "1",
    },
    ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
  });

  // Realpath the packaged site dir for the caller — a nix-store
  // path is what the read-only test asserts.
  const packagedSiteDirReal = realpathSync(packagedSiteDir);
  return { distOutDir, stagingDir, packagedSiteDir: packagedSiteDirReal };
}
