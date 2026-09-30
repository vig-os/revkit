# revkit docs

A minimal revkit docs repo. Scaffolded by:

```bash
nix flake init -t github:vig-os/revkit
```

## Three commands

```bash
direnv allow       # or: nix develop
revkit check       # run the ADR-0005 authoring guards on this tree
revkit build       # render `docs/` through revkit's packaged Astro/Starlight
revkit serve       # boot the local review daemon on 127.0.0.1
```

`revkit build` (M5 part 2, [#57][57]) copies your docs into a writable
staging tree under `.revkit/build/`, renders them with revkit's packaged
site, and writes the built HTML to `.revkit/dist/`. Astro and Vite caches
land under `.revkit/cache/` — nothing is written into the nix store.
The command runs `revkit check` first and `revkit check-dist` after
(ADR-0012 output-gate), so the served output is fit for a reviewer.

`revkit serve` picks up `.revkit/dist/` by default. If it does not
exist, `revkit build` runs automatically (pass `--no-auto-build`
to refuse instead). The daemon binds to 127.0.0.1, prints a
single-use launch URL, and mounts the rail on every rendered page
(ADR-0006, ADR-0007, ADR-0013).

`nix build` runs `revkit check` inside a sandboxed docs derivation —
a second, stricter pass that CI can gate on.

[57]: https://github.com/vig-os/revkit/issues/57

See [revkit][revkit] for the architecture (DESIGN-0001, ADR-0001…0025).

[revkit]: https://github.com/vig-os/revkit

## Layout

| Path | Purpose |
|---|---|
| `docs/` | MDX docs. Only [registered components][adr-0002] are allowed; new needs go through `revkit escalate`. |
| `vocab/terms.yaml` | The one place a term is defined ([ADR-0005 C2][adr-0005]). |
| `flake.nix` | Consumes `revkit.packages.<system>.revkit`. |
| `.gitignore` | Ignores `.revkit/` (daemon state, build staging, dist — never committed). |

## What `revkit check` enforces (ADR-0005)

1. **component-registry:** MDX imports only from `@revkit/components` or Starlight.
2. **no-hand-rolled-ui:** no bare `<div>` / `<script>` / raw CSS in content.
3. **vocabulary:** every `<Term id>` resolves to `vocab/terms.yaml`.
4. **links:** cross-doc links point at files that exist.
5. **plot-structure:** plots are `spec.vl.json` + a sibling data file (never inline).

Plus the vendored-code contract from ADR-0022.

[adr-0002]: https://github.com/vig-os/revkit/blob/main/docs/adr/0002-solid-islands-component-registry.md
[adr-0005]: https://github.com/vig-os/revkit/blob/main/docs/adr/0005-authoring-guards-revkit-check.md
