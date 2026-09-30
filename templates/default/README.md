# revkit docs

A minimal revkit docs repo. Scaffolded by:

```bash
nix flake init -t github:vig-os/revkit
```

## Two commands (M5 part 1)

```bash
direnv allow       # or: nix develop
revkit check       # run the ADR-0005 authoring guards on this tree
nix build          # runs `revkit check` inside a docs derivation
```

`revkit serve` (the local review daemon that mounts the rail on rendered pages) is **M5 part 2** — see
[revkit's DESIGN-0002 §5](https://github.com/vig-os/revkit/blob/main/docs/designs/DESIGN-0002-devkit-review-module.md#5-gap-between-m5-part-1-and-full-d1-acceptance).
It needs a `revkit build` step (not yet shipped) that renders this `docs/` tree through revkit's packaged
Astro/Starlight site. Until then the daemon works but has no rendered content to serve.

See [revkit][revkit] for the architecture (DESIGN-0001, ADR-0001…0025).

[revkit]: https://github.com/vig-os/revkit

## Layout

| Path | Purpose |
|---|---|
| `docs/` | MDX docs. Only [registered components][adr-0002] are allowed; new needs go through `revkit escalate`. |
| `vocab/terms.yaml` | The one place a term is defined ([ADR-0005 C2][adr-0005]). |
| `flake.nix` | Consumes `revkit.packages.<system>.revkit`. |
| `.gitignore` | Ignores `.revkit/` (daemon state — never committed). |

## What `revkit check` enforces (ADR-0005)

1. **component-registry:** MDX imports only from `@revkit/components` or Starlight.
2. **no-hand-rolled-ui:** no bare `<div>` / `<script>` / raw CSS in content.
3. **vocabulary:** every `<Term id>` resolves to `vocab/terms.yaml`.
4. **links:** cross-doc links point at files that exist.
5. **plot-structure:** plots are `spec.vl.json` + a sibling data file (never inline).

Plus the vendored-code contract from ADR-0022.

[adr-0002]: https://github.com/vig-os/revkit/blob/main/docs/adr/0002-solid-islands-component-registry.md
[adr-0005]: https://github.com/vig-os/revkit/blob/main/docs/adr/0005-authoring-guards-revkit-check.md
