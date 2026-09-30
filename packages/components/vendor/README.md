# Vendored code lives here (ADR-0022)

Under this directory, `@revkit/components` will vendor **copy-in source** — starting with the styled layer ported from
[shadcn-solid](https://shadcn-solid.com/) (ADR-0002). Nothing is vendored yet in M1 (#6); this README exists so the
directory ships with the package and the contract is written down before the first drop.

The `revkit check` **`vendored-code`** guard (ADR-0022) enforces every STRUCTURAL rule below. LICENSE **bytes** are
checked by **manual review only** until the SPDX-template matcher tracked in #33 lands. `.github/CODEOWNERS`
REQUESTS the maintainer's review on `packages/components/vendor/` and `NOTICE`, but the CODEOWNERS file becomes an
enforced gate only once branch protection on `dev` requires code-owner review (an org-config change outside this
repo). See "Why not text-matching?" below.

## Contract

Each vendored dependency lives in a **package-scoped subdirectory** — `packages/components/vendor/<pkg>/` — that
must contain:

1. The upstream source files, unmodified except where the port note in the file header explains why.
2. An upstream **`LICENSE`** file at the root of the subdirectory. The file must exist, be a real regular file
   (no symlinks), and be named exactly `LICENSE` (case matters — `LICENSE.md`, `License`, `license`, `COPYING`
   get a rename hint so macOS behaves like Linux CI). The **bytes** are checked by manual review (see "Why not
   text-matching?" below and #33). If the source is one of MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0 or ISC,
   copy the upstream `LICENSE` verbatim.
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
   - `license:` must be exactly one SPDX id from `{MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0, ISC}`. Compound
     expressions (`MIT AND GPL-3.0-only`, `MIT OR Apache-2.0`, anything with `WITH`, parentheses) are refused:
     split the drop, or pick the single SPDX id that governs the vendored source.

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
  silently drop upstream attribution; a symlinked package dir could point out of the tree at any time). The
  workspace walk in `packages/cli/src/file-discovery.ts` also refuses any symlink under
  `packages/components/vendor/`, so a nested symlink inside a package
  (e.g. `vendor/n/sub/x.ts -> /etc/passwd`) is also refused.

## Why not text-matching?

An earlier draft of this rule tried to match LICENSE **bytes** against SPDX-canonical templates. The problem is that
either extreme leaves a bypass:

- A whitespace-collapsing normaliser that strips copyright lines admits adversarial appends — Commons Clause after
  `END OF TERMS`, "Good, not Evil", replaced condition lines — because their normalised body still contains the
  canonical text.
- A stricter matcher that admits real upstream LICENSE variance (shadcn-solid's curly quotes and single-paragraph
  layout, re2's `//` per-line comment prefix, freebsd's compound `COPYRIGHT`) needs a full SPDX-template
  implementation (SPDX License Matching Guidelines v2.1 with `<<var>>` / `<<beginOptional>>` handling); that
  belongs behind a well-tested library, not a hand-rolled normaliser.

Rather than ship a heuristic that passes some cases and refuses others, this rule leaves the LICENSE bytes to
**manual review** until #33 (proper SPDX-template matcher behind a vetted library) lands. `.github/CODEOWNERS`
REQUESTS the maintainer's review on `packages/components/vendor/` and `NOTICE`; that becomes an ENFORCED gate
only once branch protection on `dev` requires code-owner review (an org-config change outside this repo).
Meanwhile the maintainer reviews a small, known-shaped surface (one LICENSE file + one UPSTREAM per drop, with
every structural check already green).

## Procedure — vendor a new upstream package

1. Copy the upstream source into `packages/components/vendor/<pkg>/` — subdirectory name = the flattened upstream
   package name.
2. Copy the upstream `LICENSE` file into `packages/components/vendor/<pkg>/LICENSE` **verbatim**.
3. Add `packages/components/vendor/<pkg>/UPSTREAM` with `repo:` / `commit:` / `path:` / `license:` as above.
4. Add one bullet entry to `NOTICE` at the repo root:

   ```text
   - packages/components/vendor/<pkg> — <upstream URL> (SPDX: <id>)
   ```

5. Run `revkit check` inside the dev shell. It should exit `0`. Any error names the specific file that is missing,
   the SPDX id that is not permitted, the UPSTREAM key that is malformed, or the NOTICE entry that is missing,
   phantom, or SPDX-mismatched.
6. Commit inside the dev shell so the pre-commit `revkit-check` hook runs the same guard against your staged
   changes.
7. Open the PR. CODEOWNERS auto-REQUESTS the maintainer; the LICENSE bytes are reviewed on the diff. That review
   is a REQUEST, not a merge block, until branch protection on `dev` requires code-owner review (an org-config
   change outside this repo) — and it stays REQUEST-ONLY until the SPDX-template matcher in #33 lands, so treat
   the reviewer's LICENSE-bytes sign-off as load-bearing when merging.

## Allowed licenses

Only **permissive licenses compatible with Apache-2.0** may be vendored: MIT, BSD-2-Clause, BSD-3-Clause, ISC,
Apache-2.0. Copyleft (GPL / LGPL / AGPL / MPL / EPL / SSPL) or anything unrecognised is refused at the UPSTREAM
`license:` level; the maintainer's manual LICENSE-bytes review (as requested by CODEOWNERS) catches anything that
slips past the SPDX id (a mis-declared LICENSE, for example) — see #33 for the automated follow-up.

## Not-a-dependency

Vendored code is **not** an npm dependency: consumers import it via the `@revkit/components` package barrel, never by
reaching into `vendor/` directly. When shadcn-solid ships a fix upstream, the port is re-taken in one commit that
updates the source and the `UPSTREAM` commit SHA; there is no lockfile bump to review.
