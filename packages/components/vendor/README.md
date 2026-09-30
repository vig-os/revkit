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
2. An upstream **`LICENSE`** file at the root of the subdirectory. Its license must be one of MIT, BSD-2-Clause,
   BSD-3-Clause, Apache-2.0 or ISC (permissive, Apache-2.0-compatible). Detection prefers an
   `SPDX-License-Identifier:` header; failing that, the license text itself is pattern-matched. An unknown or
   copyleft license (GPL / LGPL / AGPL / MPL / EPL / SSPL) is refused.
3. An **`UPSTREAM`** provenance file at the root of the subdirectory, recording where the drop came from. Simple
   `key: value` grammar, one per line; blank lines and `#` comments ignored:

   ```text
   repo: https://github.com/hngngn/shadcn-solid
   commit: <full 40-char git SHA>
   path: packages/cli/templates/button
   ```

   - `repo:` must be an `http(s)://` URL a reviewer can follow.
   - `commit:` must be the **full** 40-char SHA; short SHAs move over time.
   - `path:` is the upstream subpath the drop was taken from; may be empty when the whole upstream repo is
     vendored, but the key must still be present.

Every subdirectory is then **listed in the repo-root `NOTICE`** as a bullet entry at the start of a line:

```text
- packages/components/vendor/<pkg> — <upstream URL> (SPDX: <id>)
```

The `vendored-code` guard reads only entries in that bullet form, so the README can freely mention the vendor path
in prose without confusing the parser.

## Procedure — vendor a new upstream package

1. Copy the upstream source into `packages/components/vendor/<pkg>/` — subdirectory name = the upstream package
   name.
2. Copy the upstream `LICENSE` file into `packages/components/vendor/<pkg>/LICENSE` **verbatim** (no reformatting;
   the SPDX detector and text-fallback matcher both look at the original bytes).
3. Add `packages/components/vendor/<pkg>/UPSTREAM` with `repo:` / `commit:` / `path:` as above.
4. Add one bullet entry to `NOTICE` at the repo root:

   ```text
   - packages/components/vendor/<pkg> — <upstream URL> (SPDX: <id>)
   ```

5. Run `revkit check` inside the dev shell. It should exit `0`. Any error names the specific file that is missing,
   the license that is not permitted, or the NOTICE entry that is missing or phantom.
6. Commit inside the dev shell so the pre-commit `revkit-check` hook runs the same guard against your staged
   changes.

## Allowed licenses

Only **permissive licenses compatible with Apache-2.0** may be vendored: MIT, BSD-2-Clause, BSD-3-Clause, ISC,
Apache-2.0. Copyleft (GPL / LGPL / AGPL / MPL / EPL / SSPL) or anything unrecognised is refused by the guard.

## Not-a-dependency

Vendored code is **not** an npm dependency: consumers import it via the `@revkit/components` package barrel, never by
reaching into `vendor/` directly. When shadcn-solid ships a fix upstream, the port is re-taken in one commit that
updates the source and the `UPSTREAM` commit SHA; there is no lockfile bump to review.
