{
  description = "Project development environment (vigOS toolchain).";

  # Downstream repos consume the shared toolchain as a flake INPUT, so updating
  # the dev environment means bumping that input — it never overwrites your
  # files. To update: `nix flake update vigos`.
  inputs = {
    # The shared vigOS toolchain (single source of truth).
    # This scaffold deliberately FLOATS on the default branch so a fresh
    # project works before its first pin. Once you depend on stability
    # (especially the vigos.* home-manager module options), pin a release
    # tag instead and bump deliberately:
    #   vigos.url = "github:vig-os/devkit?ref=<tag>";
    # Policy: https://github.com/vig-os/devkit/blob/main/docs/NIX.md
    # "Home-manager modules - versioning & release policy".
    # Pinned in lockstep with DEVKIT_VERSION in .vig-os (MIGRATION.md,
    # "DEVKIT_VERSION and the pinned flake ref move in lockstep").
    vigos.url = "github:vig-os/devkit?ref=1.17.0";
    # Follow vigos's pinned nixpkgs + flake-utils so your tools match the
    # toolchain exactly (one resolved nixpkgs, no drift).
    nixpkgs.follows = "vigos/nixpkgs";
    flake-utils.follows = "vigos/flake-utils";
  };

  outputs =
    {
      self,
      vigos,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ vigos.overlays.default ];
          config.allowUnfree = true;
        };

        # ────────────────────────────────────────────────────────────────────
        # Your project tools go here. This block is YOURS: a dev-environment
        # update never overwrites it (scaffold-once / never-overwrite, the same
        # guarantee as justfile.project and docker-compose.project.yaml).
        #
        #   extraPackages = pkgs: [
        #     pkgs.postgresql_16
        #     pkgs.ffmpeg
        #   ];
        # ────────────────────────────────────────────────────────────────────
        extraPackages = pkgs: [
          # Bun: fast TS runtime/test runner/package manager for the review
          # toolchain (Astro/Vite builds, guard scripts).
          pkgs.bun
          # Cloudflare CLI for the hosted Worker (ADR-0008). Auth comes from
          # CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID, loaded per call by
          # `just cf` from ~/.config/revkit/cf.env (ADR-0014), never exported
          # into the shell.
          pkgs.wrangler
          # Deterministic font set for the Playwright visual-regression
          # baselines (ADR-0016). Bundling from the flake — reached through
          # REVKIT_TEST_FONTS_DIR in the shell hook below — means the same
          # /nix/store bytes render the pages on the NixOS dev host and the
          # Ubuntu CI runner, so screenshots do not depend on either host's
          # fontconfig. The font is loaded ONLY by the visual-regression
          # spec's Playwright fixture (site/tests/fixtures/visual.ts); it is
          # NOT injected into the site build, which stays on Starlight's
          # system-font stack.
          pkgs.dejavu_fonts
        ];

        # Playwright browsers from nixpkgs (ADR-0016/0018) — Chromium, Firefox
        # and WebKit rebuilt with Nix's own libraries, so the driver never
        # tries to fetch a manylinux tarball on a NixOS host. The consumer
        # shellHook exports PLAYWRIGHT_BROWSERS_PATH at this store path and
        # PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true so `@playwright/test`
        # runs from the store. `@playwright/test` in site/package.json is
        # pinned to the SAME version as `pkgs.playwright-driver.version` so
        # the driver protocol matches the browsers.
        playwrightBrowsers = pkgs.playwright-driver.browsers;

        # Devkit knobs read from .vig-os (#1224, #1432, #1431, #1282, #1633): the
        # flake-generated pre-commit hooks — the branch guard and the
        # commit-message validator — follow the workspace manifest, mirroring
        # the scaffolded .pre-commit-config.yaml renders (#1434). Managed
        # block; leave it.
        vigOsValue =
          key:
          let
            vigOsPath = self + "/.vig-os";
            declared = builtins.filter (l: nixpkgs.lib.hasPrefix "${key}=" l) (
              nixpkgs.lib.splitString "\n" (builtins.readFile vigOsPath)
            );
          in
          if !builtins.pathExists vigOsPath || declared == [ ] then
            ""
          else
            nixpkgs.lib.removePrefix "${key}=" (builtins.head declared);

        # A comma-separated manifest list -> a Nix list, or null when the key
        # is absent/blank (= "keep the devkit default"). Whitespace around
        # entries is trimmed and empty entries dropped, matching how
        # init-workspace.sh resolves the same keys; validation (charset,
        # non-empty) lives in mkProjectShell, which fails eval loudly on a bad
        # value.
        vigOsList =
          key:
          let
            entries = builtins.filter (t: t != "") (
              map (t: nixpkgs.lib.trim t) (nixpkgs.lib.splitString "," (vigOsValue key))
            );
          in
          if entries == [ ] then null else entries;

        # Workflow model (#1224): a `trunk` workspace drops the dev-branch
        # clause. `gitflow` (the default) and an absent/blank value are inert.
        workflow = if vigOsValue "DEVKIT_WORKFLOW" == "trunk" then "trunk" else "gitflow";

        # Branch-type set (#1432): DEVKIT_BRANCH_TYPES replaces the
        # issue-numbered alternation of the branch guard.
        branchTypes = vigOsList "DEVKIT_BRANCH_TYPES";

        # Approved commit types (#1431): DEVKIT_COMMIT_TYPES replaces the
        # validate-commit-msg `--types` list, so the local hook agrees with
        # CI's validate-commit-range (#1434).
        commitTypes = vigOsList "DEVKIT_COMMIT_TYPES";

        # Refs policy (#1282): DEVKIT_REFS_POLICY steers whether a commit needs
        # a `Refs: #N` line — chore-optional (default) | optional | required.
        # Absent/blank forwards null (= the default); an unknown literal fails
        # eval loudly in mkProjectShell (#1434).
        refsPolicy =
          let
            raw = nixpkgs.lib.trim (vigOsValue "DEVKIT_REFS_POLICY");
          in
          if raw == "" then null else raw;

        # Refs-optional types (#1633): DEVKIT_REFS_OPTIONAL_TYPES names the
        # commit types that may omit `Refs:` and WINS over DEVKIT_REFS_POLICY.
        # Absent/blank forwards null (= the policy decides); a value outside
        # the approved types fails eval loudly in mkProjectShell.
        refsOptionalTypes = vigOsList "DEVKIT_REFS_OPTIONAL_TYPES";

        # Semantic gates from the `guardrails` module, one prek hook per gate.
        # Each gate takes the staged filenames and exits non-zero on a
        # finding; escape a single line with `guardrails-ok`.
        codeFiles = "\\.(ts|tsx|js|mjs|cjs|astro)$";
        docFiles = "\\.(md|mdx)$";
        adrFiles = "^(docs/adr/|docs/FEATURE-MATRIX\\.md$|scripts/adr-index\\.sh$)";
        guardrailsHooks =
          gates: files:
          builtins.listToAttrs (
            map (gate: {
              name = "guardrails-${gate}";
              value = {
                enable = true;
                entry = "guardrails-${gate}";
                language = "system";
                inherit files;
              };
            }) gates
          );
      in
      {
        # The dev shell = the shared vigOS toolchain + your extras.
        # `direnv allow` (via .envrc) or `nix develop` enters it.
        devShells.default = vigos.lib.mkProjectShell (
          {
            inherit pkgs;
            extraPackages = extraPackages pkgs;

            # Consumer shellHook (mkProjectShell appends this after the module
            # fragments). Pins Playwright to the nix-built browsers and skips
            # the driver's host-package validation, which trips on NixOS's
            # non-FHS layout. Kept last so the "dev environment loaded" echo
            # from the default shellHook is preserved by re-emitting it.
            shellHook = ''
              export PLAYWRIGHT_BROWSERS_PATH="${playwrightBrowsers}"
              export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
              # Deterministic-font fixture path for the Playwright visual
              # regression suite (ADR-0016). The site build does not touch
              # these fonts; only tests/fixtures/visual.ts reads them and
              # injects them into the page under test.
              export REVKIT_TEST_FONTS_DIR="${pkgs.dejavu_fonts}/share/fonts/truetype"
              echo "devcontainer dev environment loaded (nix)"
            '';

            # Capability modules (mirrored in .vig-os DEVKIT_MODULES):
            #   node       - nodejs/npm for the Astro/Vite/TS toolchain
            #   guardrails - semantic gates (no-fake-impl, no-hardcoded,
            #                duplication, derived-docs, ...) on PATH
            modules = [
              "node"
              "guardrails"
            ];

            # Host-runner hooks (#1167): direnv CI runs on the bare host
            # runner, so let the flake GENERATE .pre-commit-config.yaml from
            # the shared base hook set, resolved entirely from the Nix store
            # (incl. pymarkdown, now a flake system hook, #1170) rather than
            # building the committed YAML remote pre-commit repo hook envs
            # per runner. Customize like the opt-in block below; the generated
            # config is a gitignored /nix/store symlink.
            #
            # The guardrails module only puts the gates on PATH — devkit 1.17.0
            # renders no hook entry for them — so they are wired here.
            hooks =
              guardrailsHooks [
                "no-fake-impl"
                "no-debug-leftovers"
                "no-commented-code"
                "no-hardcoded"
                "duplication"
              ] codeFiles
              // guardrailsHooks [ "derived-docs" ] docFiles
              // {
                # Every Accepted ADR must be cited in the feature matrix and
                # listed (as Accepted) in the ADR index.
                guardrails-adr-matrix = {
                  enable = true;
                  entry = "guardrails-adr-matrix docs/adr/README.md docs/FEATURE-MATRIX.md";
                  language = "system";
                  files = adrFiles;
                  pass_filenames = false;
                };
                # The ADR index is derived from the ADR files; re-check it
                # whenever any ADR changes, not only when README.md is staged.
                adr-index = {
                  enable = true;
                  entry = "guardrails-derived-docs docs/adr/README.md";
                  language = "system";
                  files = adrFiles;
                  pass_filenames = false;
                };
                # `revkit check` (M1 item 4, ADR-0005) runs the five
                # authoring guards. The hook always walks the whole
                # workspace (`--staged` would be too narrow — links
                # resolve across files, vocab loads once from
                # `vocab/terms.yaml`) and the CLI walks itself with the
                # same excludes, so `pass_filenames = false`. Also
                # opts in to `--online` when `gh auth status` succeeds
                # in the dev shell, else falls back to offline with a
                # visible warning — the workflow at
                # `.github/workflows/revkit-guards.yml` runs `--online`
                # unconditionally with `GITHUB_TOKEN`. `.(md|mdx|astro|
                # tsx|jsx|json|ya?ml|vue|svelte|html|htm)` (case-
                # insensitive) is the surface no-hand-rolled-ui and
                # component-registry look at.
                revkit-check = {
                  enable = true;
                  entry = "packages/cli/bin/revkit-check-hook.sh";
                  language = "system";
                  files = "(?i)\\.(md|mdx|astro|tsx|jsx|json|ya?ml|vue|svelte|html|htm|[mc]?[jt]sx?)$";
                  pass_filenames = false;
                };
                # gitleaks (ADR-0014 + ADR-0005 acceptance): scan staged
                # changes for tokens, keys and cookies. `git --staged`
                # is the current-generation subcommand (`gitleaks protect`
                # is deprecated). `--redact` keeps a false-positive on a
                # public value from being leaked twice; `-v` names the
                # file each finding came from.
                gitleaks = {
                  enable = true;
                  entry = "gitleaks git --staged --redact -v";
                  language = "system";
                  pass_filenames = false;
                };
              };

            # Opt-in: let the flake GENERATE .pre-commit-config.yaml from the
            # shared base hook set instead of hand-managing the scaffolded
            # YAML — toggle base hooks, add per-hook/global excludes, or add
            # fully custom hooks; hook updates then flow with `nix flake
            # update vigos`, and your customization lives HERE (preserved).
            # Contract + migration steps:
            # https://github.com/vig-os/devkit/blob/main/docs/MIGRATION.md ("Customizing
            # pre-commit hooks from the project flake"). Uncomment to opt in, then
            # delete .pre-commit-config.yaml (the generated config refuses to
            # overwrite an existing file). The generated store symlink is ignored
            # automatically on (re)scaffold (#1092); add durable root ignores you
            # own to .gitignore.project.
            #
            #   hooks = {
            #     typos.enable = false;                    # toggle a base hook
            #     detect-private-keys.excludes = [ "worker/src/index\\.ts" ];
            #     my-data-check = {                        # fully custom hook
            #       enable = true;
            #       entry = "./scripts/check-dat.sh";
            #       files = "\\.dat$";
            #       language = "system";
            #     };
            #   };
            #   hooksExcludes = [ "^data/stopping/" "\\.dat$" ]; # global excludes
          }
          # Forwarded only when the resolved devkit accepts it (#1249): the vigos
          # input floats to main, which may predate the argument; older builders
          # then fall back to their gitflow default instead of failing eval.
          // nixpkgs.lib.optionalAttrs (builtins.functionArgs vigos.lib.mkProjectShell ? workflow) {
            # Branch guard follows the workspace workflow model (#1224).
            inherit workflow;
          }
          // nixpkgs.lib.optionalAttrs (builtins.functionArgs vigos.lib.mkProjectShell ? branchTypes) {
            # Branch guard follows the workspace branch-type set (#1432).
            inherit branchTypes;
          }
          // nixpkgs.lib.optionalAttrs (builtins.functionArgs vigos.lib.mkProjectShell ? commitTypes) {
            # validate-commit-msg follows the workspace commit-type set (#1431).
            inherit commitTypes;
          }
          // nixpkgs.lib.optionalAttrs (builtins.functionArgs vigos.lib.mkProjectShell ? refsPolicy) {
            # validate-commit-msg follows the workspace Refs policy (#1282).
            inherit refsPolicy;
          }
          // nixpkgs.lib.optionalAttrs (builtins.functionArgs vigos.lib.mkProjectShell ? refsOptionalTypes) {
            # validate-commit-msg follows the workspace exempt set (#1633).
            inherit refsOptionalTypes;
          }
        );

        # Opt-in local dev services (#795): a daemonless process-compose stack
        # (Postgres, SeaweedFS/S3, Redis, …) with service versions from the
        # pinned vigos nixpkgs — no Docker/Podman daemon, no extra flake
        # inputs. Uncomment, then `nix run .#services` (or enable the
        # `services` recipe in justfile.project); service state lands in
        # ./data — add it to .gitignore.
        #
        #   packages.services = vigos.lib.mkProjectServices {
        #     inherit pkgs;
        #     modules = [ { services.postgres."db".enable = true; } ];
        #   };

        # Future (upstream, opt-in): vigos may expose modular language shells —
        # e.g. `vigos.devShells.${system}.{cpp,geant4,dataAnalysis}` — that you
        # select without changing this scaffold. Out of scope today.
      }
    );
}
