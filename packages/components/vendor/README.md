# Vendored code lives here (ADR-0022)

Under this directory, `@revkit/components` will vendor **copy-in source** — starting with the styled layer ported from
[shadcn-solid](https://shadcn-solid.com/) (ADR-0002). Nothing is vendored yet in M1 (#6); this README exists so the
directory ships with the package and the contract is written down before the first drop.

## Contract

Each vendored dependency lives in a **package-scoped subdirectory** — `packages/components/vendor/<pkg>/` — that
must contain:

1. The upstream source files, unmodified except where the port note in the file header explains why.
2. The upstream `LICENSE` file, at the root of the subdirectory.
3. A `PROVENANCE.md` (or a top comment in a single-file drop) recording:
   - upstream repo URL,
   - upstream commit SHA the drop was taken from,
   - date of the drop,
   - the list of files brought over and any local modifications.

Every subdirectory is then **listed in the repo-root `NOTICE`** (the header refers to `packages/components/vendor/`),
so the license notice ships with any built distribution.

## Allowed licenses

Only **permissive licenses compatible with Apache-2.0** may be vendored: MIT, BSD-2-Clause, BSD-3-Clause, ISC,
Apache-2.0. GPL / LGPL / AGPL / copyleft licenses are refused. `revkit check` will grow a hook that enforces this once
the first vendored drop lands.

## Not-a-dependency

Vendored code is **not** an npm dependency: consumers import it via the `@revkit/components` package barrel, never by
reaching into `vendor/` directly. When shadcn-solid ships a fix upstream, the port is re-taken in one commit that
updates the source and the `PROVENANCE.md`; there is no lockfile bump to review.
