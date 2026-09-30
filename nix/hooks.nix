# Reusable pre-commit hook definitions for a consumer flake (ADR-0010,
# DESIGN-0001 §7).
#
# A downstream repo that consumes `revkit.lib.hooks` merges these into
# its own devkit `hooks` block:
#
#   hooks = revkit.lib.hooks.mkHooks {
#     revkit = revkit.packages.${system}.revkit;
#   } // {
#     # …the consumer's own hooks…
#   };
#
# The shape (`{ enable, entry, language, files, pass_filenames }`)
# mirrors the devkit's own hooks block in `flake.nix`, so a consumer's
# `hooks =` attrset stays homogeneous and `mkProjectShell` accepts the
# merged value without special-casing revkit's hooks.
#
# Every hook here calls the packaged `revkit` binary from the store —
# no PATH lookup — so a consumer that has revkit as a flake INPUT but
# NOT in its dev-shell PATH still gets the same hook coverage as revkit
# itself. `pass_filenames = false` because `revkit check` walks the
# workspace on its own (links resolve across files, vocab loads once);
# `--staged` would be too narrow, and the CLI has its own exclude list
# for node_modules/dist/.astro/.direnv (see file-discovery.ts).

{ lib }:

rec {
  # File-glob regex the `revkit-check` hook triggers on — every content
  # extension revkit's rules look at, plus the extensionless vendored-
  # code files (`NOTICE`, `LICENSE`, `UPSTREAM`) the ADR-0022 guard
  # reads. Case-insensitive so `.MD` / `.MDX` count. Exported (as
  # `contentFiles`) so the revkit repo's own `flake.nix` reads THIS
  # value into its local hook rather than keeping a parallel string
  # that could drift.
  contentFiles = "(?i)\\.(md|mdx|astro|tsx|jsx|json|ya?ml|vue|svelte|html|htm|[mc]?[jt]sx?)$|(?:^|/)(NOTICE|LICENSE|UPSTREAM)$";

  # Function form so a consumer flake can pass the packaged revkit CLI
  # from THIS flake's per-system `packages` output. Called with:
  #   { revkit = revkit.packages.${system}.revkit; }
  # returns the hook attrset (same shape as devkit's `hooks =`).
  mkHooks =
    {
      revkit,
      # REPLACEMENT file-glob regex. When `null` (the default), the
      # hook uses `contentFiles`; when a string, it REPLACES that
      # pattern (it does not extend it — a consumer who wants to add
      # a suffix without losing the base coverage must inline the
      # concatenation themselves). Rare; the default covers every
      # extension revkit's rules read.
      extraFiles ? null,
    }:
    let
      files = if extraFiles == null then contentFiles else extraFiles;
    in
    {
      # `revkit check` — the five authoring guards from ADR-0005 plus
      # the vendored-code contract from ADR-0022. Consumer repos get
      # the same enforcement bar the revkit repo itself uses on its
      # own docs.
      revkit-check = {
        enable = true;
        entry = "${revkit}/bin/revkit check";
        language = "system";
        inherit files;
        pass_filenames = false;
      };
    };
}
