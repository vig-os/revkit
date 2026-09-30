{
  description = "A minimal revkit docs repo (scaffolded by `nix flake init -t github:vig-os/revkit`).";

  # The one revkit input this repo needs. Pin to a tag once revkit has a
  # release; the scaffold ships the floating default so a fresh checkout
  # works without extra flags. Bump deliberately.
  #
  # Until revkit's next release ships M5 (`packages.revkit`,
  # `templates.default`, `lib.hooks`) to `main`, the floating default
  # branch (`main`) has no `packages` output and evaluation fails with
  # `attribute 'packages' missing`. Point at `dev` in the meantime:
  #
  #   revkit.url = "github:vig-os/revkit/dev";
  #
  # After the release, `github:vig-os/revkit` alone (or a pinned tag)
  # works.
  inputs = {
    revkit.url = "github:vig-os/revkit/dev";
    # Follow revkit's pinned nixpkgs + flake-utils so the CLI's runtime
    # (Bun, deps) matches the version revkit was built with — no drift.
    nixpkgs.follows = "revkit/nixpkgs";
    flake-utils.follows = "revkit/flake-utils";
  };

  outputs =
    {
      self,
      revkit,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        revkitPkg = revkit.packages.${system}.revkit;
      in
      {
        # Enter the shell with `direnv allow` (via .envrc) or `nix develop`.
        # `revkit` lands on PATH so the three commands from the README work.
        devShells.default = pkgs.mkShell {
          packages = [ revkitPkg ];
        };

        # `nix build` runs the ADR-0005 authoring guards over the docs tree
        # and produces a store path holding the checked docs. Fails the
        # build (and CI) on any finding.
        packages.default = pkgs.stdenvNoCC.mkDerivation {
          pname = "revkit-docs";
          version = "0.0.0";
          src = ./.;
          nativeBuildInputs = [ revkitPkg ];
          dontConfigure = true;
          dontFixup = true;
          buildPhase = ''
            runHook preBuild
            revkit check
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cp -r docs $out/
            [ -d vocab ] && cp -r vocab $out/ || true
            runHook postInstall
          '';
        };

        # `nix run` executes the CLI without a checkout. Nix builds the
        # revkit input, then invokes the wrapper.
        apps.revkit = revkit.apps.${system}.revkit;
      }
    );
}
