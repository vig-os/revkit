# Vendored code lives here (ADR-0022)

Under this directory, `@revkit/components` will vendor **copy-in source** — starting with the styled layer ported from
[shadcn-solid](https://shadcn-solid.com/) (ADR-0002). Nothing is vendored yet in M1 (#6); this README exists so the
directory ships with the package and the contract is written down before the first drop.

The `revkit check` **`vendored-code`** guard (ADR-0022) enforces every rule below. Run it inside the dev shell
(`revkit check`) — the pre-commit hook and the CI workflow both invoke the same code path.

## Contract

Each vendored dependency lives in a **package-scoped subdirectory** — `packages/components/vendor/<pkg>/` — that
must contain:

1. The upstream source files, unmodified except where the port note in the file header explains why.
2. An upstream **`LICENSE`** file at the root of the subdirectory. The file must be named exactly `LICENSE` (case
   matters — `LICENSE.md`, `License`, `license`, `COPYING` are refused so macOS behaves like Linux CI). Its bytes
   must match the SPDX-canonical text of the license declared in `UPSTREAM`, after copyright/year normalisation.
   The allowlist is MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0 and ISC. Extra clauses (Commons Clause, "Good, not
   Evil", the BSD-4 advertising clause) and body mismatches (a GPL body with an MIT header, an AGPL that mentions
   Apache-2.0, ...) fail the canonical-text check.
3. An **`UPSTREAM`** provenance file at the root of the subdirectory. Simple `key: value` grammar, one per line;
   blank lines and `#` comments ignored; duplicate keys refused:

   ```text
   repo: https://github.com/hngngn/shadcn-solid
   commit: <full 40-char git SHA>
   path: packages/cli/templates/button
   license: MIT
   ```

   - `repo:` must be an `https://` URL with a host, no query or fragment.
   - `commit:` must be the **full** 40-char SHA; short SHAs are rejected.
   - `path:` is the upstream subpath the drop was taken from. May be empty when the whole upstream repo is
     vendored; the key must still be present.
   - `license:` must be exactly one SPDX id from the allowlist above. Compound expressions (`MIT AND GPL-3.0-only`,
     `MIT OR Apache-2.0`, anything with `WITH`, parentheses) are refused: split the drop, or pick the single SPDX
     id that governs the vendored source.

Every subdirectory is then **listed in the repo-root `NOTICE`** as a bullet entry at the start of a line, and the
entry's SPDX id must equal `UPSTREAM`'s `license:`:

```text
- packages/components/vendor/<pkg> — <upstream URL> (SPDX: <id>)
```

The `vendored-code` guard reads only entries in that bullet form, so the README can freely mention the vendor path
in prose without confusing the parser.

## Layout rules

- **Package dir name:** unscoped, `[A-Za-z0-9][A-Za-z0-9._-]*`. An npm-scoped upstream (e.g. `@hngngn/solid`) is
  flattened in the vendor tree (e.g. `hngngn__solid` or `hngngn-solid`) so paths stay single-segment.
- **`packages/components/vendor/` root:** only `README.md` may live loose here; everything else is a subdirectory.
- **Symlinks:** refused everywhere in the vendor tree (a symlinked LICENSE could point at revkit's own LICENSE and
  silently drop upstream attribution; a symlinked package dir could point out of the tree at any time).

## Procedure — vendor a new upstream package

1. Copy the upstream source into `packages/components/vendor/<pkg>/` — subdirectory name = the flattened upstream
   package name.
2. Copy the upstream `LICENSE` file into `packages/components/vendor/<pkg>/LICENSE` **verbatim** (the canonical-text
   comparison ignores whitespace and punctuation but not the license body — any drift makes it a mismatch).
3. Add `packages/components/vendor/<pkg>/UPSTREAM` with `repo:` / `commit:` / `path:` / `license:` as above.
4. Add one bullet entry to `NOTICE` at the repo root:

   ```text
   - packages/components/vendor/<pkg> — <upstream URL> (SPDX: <id>)
   ```

5. Run `revkit check` inside the dev shell. It should exit `0`. Any error names the specific file that is missing,
   the license that is not permitted, the UPSTREAM key that is malformed, or the NOTICE entry that is missing,
   phantom, or SPDX-mismatched.
6. Commit inside the dev shell so the pre-commit `revkit-check` hook runs the same guard against your staged
   changes.

## Allowed licenses

Only **permissive licenses compatible with Apache-2.0** may be vendored: MIT, BSD-2-Clause, BSD-3-Clause, ISC,
Apache-2.0. Copyleft (GPL / LGPL / AGPL / MPL / EPL / SSPL) or anything unrecognised is refused by the guard.

The canonical LICENSE text the guard compares against comes from the
[SPDX license-list-data](https://github.com/spdx/license-list-data) project (CC0-1.0); NOTICE credits it as a data
source.

## Not-a-dependency

Vendored code is **not** an npm dependency: consumers import it via the `@revkit/components` package barrel, never by
reaching into `vendor/` directly. When shadcn-solid ships a fix upstream, the port is re-taken in one commit that
updates the source and the `UPSTREAM` commit SHA; there is no lockfile bump to review.
