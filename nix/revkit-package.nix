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
    (src + "/site/tsconfig.json")
    (src + "/site/astro.config.mjs")
    (src + "/site/scripts")
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
      # `--linker=hoisted` produces a classic flat `node_modules/` tree
      # (npm-style) instead of bun's default isolated `node_modules/.bun/`
      # layout — the isolated store's slot-map ordering is
      # NON-DETERMINISTIC on macOS across runs (arm64 CI captured two
      # different NAR hashes for the same lockfile), while hoisted is
      # a plain-file tree whose NAR content is stable.
      bun install \
        --frozen-lockfile \
        --production \
        --ignore-scripts \
        --linker=hoisted
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      # Hoisted layout produces one classic flat `node_modules/` tree at
      # the workspace root; per-workspace `packages/*/node_modules/` are
      # created only when a dep cannot hoist. We copy every tree the FOD
      # produced under the same relative paths — the runtime derivation
      # then symlinks each entry into $out (per-entry, not whole-tree,
      # so relative `@revkit/*` links inside the FOD's own
      # `node_modules/@revkit/` can be re-created against $out's source).
      if [ -d node_modules ]; then
        cp -r node_modules $out/node_modules
      fi
      # Per-workspace `node_modules` — hoisted rarely creates them, but
      # when a dep pins a conflicting version bun does. Kept for parity;
      # a no-op with the current lockfile.
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

    # Overlay the vendored node_modules from the FOD. Hoisted layout:
    #   $FOD/node_modules/*                   (~431 MiB, ~500 entries)
    #   $FOD/node_modules/@revkit/{cli,components,review-core,site}
    #                                         (relative symlinks pointing
    #                                          at ../../packages/* and
    #                                          ../../site — resolved
    #                                          against the FOD's own
    #                                          absent workspace source,
    #                                          so they dangle IN THE FOD
    #                                          and must be re-created
    #                                          against $out's source)
    #
    # A whole-tree `ln -s $FOD/node_modules $out/.../node_modules` breaks
    # workspace resolution — a relative symlink resolves against its
    # PHYSICAL directory, not the alias that leads to it, so a follow
    # from $out ends up in $FOD/packages/* (dangling). Per-entry
    # symlinks keep 500 tiny store-references (a `dr-xr-xr-x` entry
    # per dep) while the four `@revkit/*` links are re-created fresh so
    # they resolve within $out.
    #
    # Sizes as measured locally (x86_64-linux, bun 1.3.13):
    #   $out itself           5.8 MiB   (source + per-entry symlinks)
    #   $out closure       501.5 MiB   (adds the FOD ~431 MiB + bun ~68 MiB)
    # A `cp -r` of the FOD's node_modules into $out would DUPLICATE the
    # entire dep tree — $out ~440 MiB, closure ~940 MiB. Per-entry
    # symlinks keep the FOD as the ONE copy of the ~500 deps; the
    # closure is dominated by the FOD path, not by $out.
    if [ -d ${nodeModules}/node_modules ]; then
      mkdir -p $out/libexec/revkit/node_modules
      for entry in ${nodeModules}/node_modules/*; do
        base=$(basename "$entry")
        # `@revkit` is handled below with fresh relative symlinks into
        # $out's workspace source; any OTHER `@scope` directory needs
        # its per-package entries symlinked so the scope directory is
        # a real directory in $out (npm resolvers walk into it).
        if [ "$base" = "@revkit" ]; then
          continue
        fi
        if [ -d "$entry" ] && [ "''${base:0:1}" = "@" ]; then
          mkdir -p "$out/libexec/revkit/node_modules/$base"
          for scoped in "$entry"/*; do
            ln -s "$scoped" "$out/libexec/revkit/node_modules/$base/$(basename "$scoped")"
          done
        else
          ln -s "$entry" "$out/libexec/revkit/node_modules/$base"
        fi
      done
      # `.bin` — shell glob above skips dotfiles, so a plain `*`
      # loop does NOT symlink `node_modules/.bin/`. That is where
      # hoisted bun install puts the `astro` binary, which the
      # `revkit build` subcommand (M5 part 2, issue #57) invokes
      # by ABSOLUTE PATH. Symlink the whole `.bin` directory —
      # its inner entries are relative symlinks like
      # `../astro/bin/astro.mjs` that resolve against the FOD's
      # physical `.bin/` (they stay inside the FOD, no dangling
      # references into $out), so a single top-level symlink is
      # correct here.
      if [ -d ${nodeModules}/node_modules/.bin ]; then
        ln -s ${nodeModules}/node_modules/.bin $out/libexec/revkit/node_modules/.bin
      fi
      # Fresh `@revkit/*` relative symlinks that resolve inside $out:
      # `../../packages/<name>` from `.../node_modules/@revkit/<name>`
      # → `$out/libexec/revkit/packages/<name>` (present).
      mkdir -p "$out/libexec/revkit/node_modules/@revkit"
      ln -s ../../packages/cli \
        $out/libexec/revkit/node_modules/@revkit/cli
      ln -s ../../packages/components \
        $out/libexec/revkit/node_modules/@revkit/components
      ln -s ../../packages/review-core \
        $out/libexec/revkit/node_modules/@revkit/review-core
      ln -s ../../site $out/libexec/revkit/node_modules/@revkit/site
    fi

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
