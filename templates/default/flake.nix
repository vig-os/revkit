{
  description = "A minimal revkit docs repo (scaffolded by `nix flake init -t github:vig-os/revkit`).";

  # The one revkit input this repo needs, PINNED to a release tag (ADR-0021:
  # consumers pin a tag; a branch moves under you). The scaffold ships the
  # latest tag at the time it was cut; bump it deliberately with
  # `nix flake update revkit` after editing `?ref=`. To pin an exact commit
  # instead (e.g. to test an unreleased fix):
  #
  #   revkit.url = "github:vig-os/revkit/<full-commit-sha>";
  #
  # `revkit --version` prints `X.Y.Z (<rev>)`. A release candidate
  # (`X.Y.Z-rcN`) reports the base `X.Y.Z` plus its rev; a final reports `X.Y.Z`.
  inputs = {
    revkit.url = "github:vig-os/revkit?ref=0.1.0-rc1";
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
