# Reproducible Nix build of the `revkit` CLI (ADR-0010, D1, M5).
#
# The CLI runs on Bun (see DESIGN-0001 §7 stack) and imports from three
# workspace packages at runtime: `@revkit/cli` itself, `@revkit/review-core`
# (schemas, redaction, event types), and — via a handful of relative
# imports from the rule/loader modules — `site/src/content/{schemas,
# loaders,utils}` (vocab, plots). To ship the CLI without a runtime bundler
# the built package therefore keeps the source of those three packages and
# the vendored `node_modules`, wrapped as a single `bin/revkit` entry.
#
# Reproducibility split:
#
# 1. `nodeModules` is a FIXED-OUTPUT derivation. Its inputs are ONLY
#    `bun.lock` and the four `package.json`s that participate in the
#    workspace (root + cli + review-core + components + site). The
#    lockfile + those manifests are what `bun install --frozen-lockfile`
#    reads, so any source-only change leaves this derivation cached and
#    the deps hash stable across PRs. Network is allowed inside the
#    FOD sandbox (bun downloads from the npm registry), and the output
#    is the resulting `node_modules/` tree (root + per-workspace).
#
# 2. `revkit` is a normal derivation. It copies the CLI/review-core/site
#    sources into `$out/libexec/revkit/`, symlinks the vendored
#    `node_modules` from the FOD into place at every workspace path,
#    and wraps `bun` as `bin/revkit`.
#
# Determinism knobs on the FOD:
#   - `--ignore-scripts` disables lifecycle hooks. Bun otherwise runs the
#     `postinstall` scripts of packages such as `esbuild` on install,
#     which fetch platform-specific binaries at unpredictable times and
#     make the output hash system-dependent.
#   - `--production` skips devDependencies (we do not need TypeScript,
#     Playwright, @types/*, biome, etc. at CLI runtime).
#   - `--frozen-lockfile` refuses to mutate `bun.lock` if drift is
#     detected; the build aborts loudly instead of silently updating.
#   - `HOME=$TMPDIR` and `BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache` keep
#     bun's per-user caches inside the build sandbox.
#
# Version pinning: the CLI's semver comes from `packages/cli/package.json`
# — the single source of truth per ADR-0021, mirrored by
# `packages/cli/src/index.ts`'s `VERSION` constant. The Nix package
# `version` attribute is derived the same way so `nix build`, `bun run`
# and `revkit --version` cannot disagree.
#
# Per-system deps hash: bun installs platform-native binaries
# (`esbuild-linux-x64` vs `esbuild-darwin-arm64`, `sharp`, `rolldown`,
# `lightningcss`, ...), so the FOD output differs by system. This module
# takes `nodeModulesHashes = { <system> = "sha256-…"; }` and picks the
# entry for the current system; a system with no entry evaluates to
# `lib.fakeHash` so the first build on that system reports the correct
# hash in its rejection message ("got: sha256-…"), which then goes back
# into `nodeModulesHashes` under that system's key. CI captures each
# system's hash by running `nix build .#revkit` on a matching runner and
# reading the failure log.

{
  lib,
  stdenvNoCC,
  system,
  bun,
  cacert,
  makeWrapper,
  # Source root: the revkit repo (from flake.nix, `./.`).
  src,
  # Per-system hashes. A missing system falls back to `lib.fakeHash` so
  # the first build reports the correct hash in its rejection message.
  nodeModulesHashes ? { },
}:

let
  # CLI package.json is the version source of truth (ADR-0021 SemVer via
  # the devkit release train; `packages/cli/src/index.ts` reads the same
  # value into its `VERSION` constant, and the Nix `version` picks it
  # up here so all three agree).
  cliManifest = builtins.fromJSON (builtins.readFile "${src}/packages/cli/package.json");
  inherit (cliManifest) version;

  # Hash for the CURRENT system (from `system` builder arg). A missing
  # entry evaluates to `lib.fakeHash` so the first build fails loudly
  # with the real hash to paste back into `nodeModulesHashes`.
  nodeModulesHash = nodeModulesHashes.${system} or lib.fakeHash;

  # Manifest-only source for the FOD: bun install reads bun.lock and
  # every workspace package.json, and nothing else. Everything under a
  # workspace path OTHER than package.json is filtered out so that
  # source changes (edits to packages/cli/src/*, docs, plots, vocab)
  # never invalidate this derivation's fixed-output hash.
  manifestOnlySrc = lib.fileset.toSource {
    root = src;
    fileset = lib.fileset.unions [
      (src + "/bun.lock")
      (src + "/package.json")
      (src + "/packages/cli/package.json")
      (src + "/packages/review-core/package.json")
      (src + "/packages/components/package.json")
      (src + "/site/package.json")
    ];
  };

  # Runtime source for the CLI: everything the packaged CLI needs to
  # execute `revkit --help`, `revkit check` and `revkit serve`.
  #
  # Included:
  #   - Workspace manifests + lockfile (bun install laid out the
  #     symlinks against these paths; we keep them for parity).
  #   - packages/cli — the CLI itself.
  #   - packages/review-core — imported as `@revkit/review-core`.
  #   - packages/components — @revkit/site depends on it at type-check
  #     time; harmless at runtime, kept so the workspace resolves.
  #   - `site/src/` in full: `check-dist` imports `site/src/lib/render-plot`
  #     and `site/src/lib/css-url-scan`; the `vocabulary` and
  #     `plot-structure` rules import `site/src/content/{schemas,loaders,
  #     utils}`. Shipping all of `site/src` is simpler than a fine-grained
  #     allowlist and keeps future CLI additions from silently breaking
  #     the package boundary.
  #
  # Deliberately excluded (kept out of $out, cuts closure size AND
  # prevents a locally-installed node_modules tree from landing in the
  # store, where it would collide with the FOD's vendored node_modules
  # at copy time — resulting in `packages/cli/node_modules/node_modules/`
  # doubled paths with dangling relative symlinks):
  #   - `node_modules/` directories at any depth (files under them, not
  #     just files literally named "node_modules"). `runtimeIncludes`
  #     enumerates every runtime-required subpath; every other node_modules
  #     tree the FOD writes lands directly under $out, not through the
  #     source copy.
  #   - site/dist, site/test-results, site/tests, playwright.config.ts,
  #     site/public/*, site/scripts/*
  #   - .astro, .direnv, .git, .github
  #
  # `lib.fileset.fileFilter`'s predicate only sees the file attrs, not
  # its path, so we cannot ask it "is this under a `node_modules/`?"
  # Instead, we build the runtime fileset then SUBTRACT each of the
  # workspace's `node_modules/` trees with `lib.fileset.difference`.
  # `maybeMissing` folds absent paths into an empty set, so a fresh
  # checkout (no `bun install` run yet) works too.
  runtimeIncludes = lib.fileset.unions [
    (src + "/bun.lock")
    (src + "/package.json")
    (src + "/packages/cli")
    (src + "/packages/review-core")
    (src + "/packages/components")
    (src + "/site/package.json")
    (src + "/site/src")
  ];
  runtimeExcludes = lib.fileset.unions [
    (lib.fileset.maybeMissing (src + "/packages/cli/node_modules"))
    (lib.fileset.maybeMissing (src + "/packages/review-core/node_modules"))
    (lib.fileset.maybeMissing (src + "/packages/components/node_modules"))
    (lib.fileset.maybeMissing (src + "/site/node_modules"))
  ];
  runtimeSrc = lib.fileset.toSource {
    root = src;
    fileset = lib.fileset.difference runtimeIncludes runtimeExcludes;
  };

  # Fixed-output derivation: the vendored node_modules tree.
  nodeModules = stdenvNoCC.mkDerivation {
    pname = "revkit-node-modules";
    inherit version;
    src = manifestOnlySrc;

    nativeBuildInputs = [
      bun
      cacert # bun needs a CA bundle to reach the npm registry
    ];

    dontConfigure = true;
    dontFixup = true;

    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      export BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache
      # `--production` drops devDependencies; `--ignore-scripts` avoids
      # non-deterministic lifecycle hooks; `--frozen-lockfile` fails
      # loudly on any drift between bun.lock and the manifests.
      bun install \
        --frozen-lockfile \
        --production \
        --ignore-scripts
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      # The root node_modules tree carries every hoisted dep and bun's
      # isolated linker workspace (node_modules/.bun/*). Copying an
      # ~400 MiB tree with `cp -r` runs the fixup phase over every path
      # and doubles the closure size. Rsync with `--links` preserves
      # bun's internal relative symlinks byte-for-byte; from the runtime
      # derivation we then symlink this whole subtree into $out so the
      # final package is O(#workspace-node-modules-entries), not
      # O(dep-file-count).
      if [ -d node_modules ]; then
        cp -r node_modules $out/node_modules
      fi
      # Per-workspace node_modules directories: bun creates one under
      # each workspace whose deps are not fully hoisted, plus the
      # relative `@revkit/*` workspace symlinks (e.g.
      # `packages/cli/node_modules/@revkit/review-core -> ../../../review-core`).
      # These symlinks must resolve against the FINAL package's source
      # tree, so the runtime derivation copies these small directories
      # into place (~200 KiB combined).
      for pkg in packages/cli packages/review-core packages/components site; do
        if [ -d "$pkg/node_modules" ]; then
          mkdir -p "$out/$pkg"
          cp -r "$pkg/node_modules" "$out/$pkg/node_modules"
        fi
      done
      runHook postInstall
    '';

    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = nodeModulesHash;
  };
in
stdenvNoCC.mkDerivation {
  pname = "revkit";
  inherit version;
  src = runtimeSrc;

  nativeBuildInputs = [ makeWrapper ];
  buildInputs = [ bun ];

  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    # Land the CLI + review-core + used site source under libexec.
    mkdir -p $out/libexec/revkit $out/bin
    cp -r . $out/libexec/revkit/

    # Overlay the vendored node_modules from the FOD:
    #   - Root `node_modules/` — carries every dep and bun's isolated
    #     linker `.bun/` store. No relative workspace links live here
    #     (the four `@revkit/*` symlinks are all under per-workspace
    #     node_modules); the whole tree is safe to SYMLINK into the
    #     store, keeping the closure ~200 MiB rather than ~640 MiB
    #     (source + duplicated deps).
    #   - Per-workspace `node_modules/` — small (~200 KiB combined) and
    #     carries relative `@revkit/*` symlinks (e.g.
    #     `packages/cli/node_modules/@revkit/review-core -> ../../../review-core`)
    #     that MUST resolve against $out's source tree, not the FOD's.
    #     Copied so a naive follow of those links lands in $out.
    if [ -d ${nodeModules}/node_modules ]; then
      ln -s ${nodeModules}/node_modules $out/libexec/revkit/node_modules
    fi
    for pkg in packages/cli packages/review-core packages/components site; do
      if [ -d "${nodeModules}/$pkg/node_modules" ]; then
        mkdir -p "$out/libexec/revkit/$pkg"
        cp -r "${nodeModules}/$pkg/node_modules" "$out/libexec/revkit/$pkg/node_modules"
      fi
    done

    # Wrapper script: `bun` executes the CLI entry point directly (bun
    # runs .js that imports .ts, no transpile step needed). Keep the
    # user's CWD intact — `revkit check` and `revkit serve` walk from
    # CWD, not from the package dir.
    makeWrapper ${bun}/bin/bun $out/bin/revkit \
      --add-flags "$out/libexec/revkit/packages/cli/bin/revkit.js"

    runHook postInstall
  '';

  meta = {
    description = "revkit CLI — HTML-first review surface for the agentic era";
    homepage = "https://github.com/vig-os/revkit";
    license = lib.licenses.asl20;
    mainProgram = "revkit";
    platforms = lib.platforms.unix;
  };

  # Expose the node_modules FOD as a passthru so a consumer flake or a
  # test can build only the deps for cache-warm scenarios.
  passthru = {
    inherit nodeModules;
  };
}
