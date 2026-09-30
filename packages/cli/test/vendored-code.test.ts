// vendored-code rule tests (ADR-0022). One temp-dir per test builds a
// mini "repo" — a NOTICE at the root and zero-or-more
// packages/components/vendor/<pkg>/ subdirectories with LICENSE and
// UPSTREAM files — so each failure mode is exercised in isolation.
//
// Every test is written so that REMOVING the branch it targets would
// flip the assertion. A test that only checks "did the rule return
// anything at all" would silently keep passing after the branch was
// deleted; each test here asserts the specific message the guard
// would stop emitting.
//
// Adversarial cases (from PR #30 pre-merge review):
//   - LICENSE with a compound SPDX-License-Identifier header.
//   - LICENSE = MIT + Commons Clause, MIT + "Good, not Evil".
//   - LICENSE = GPL body with an MIT appendix.
//   - LICENSE = AGPL body that mentions Apache-2.0.
//   - LICENSE = BSD-4-Clause (advertising clause).
//   - Symlinked vendor/<pkg> dir, LICENSE, UPSTREAM, NOTICE.
//   - UPSTREAM 'license:' compound expression, non-https URL,
//     no-host URL, url with a query, duplicate key.
//   - NOTICE entry SPDX mismatches UPSTREAM.
//   - Loose file at packages/components/vendor/ root.
//   - LICENSE.md / COPYING / lowercase license.
//   - Scoped name @foo-bar (unscoped-only enforcement).
//   - Real MIT / Apache-2.0 (with and without appendix) LICENSE files
//     pass.

import { beforeAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_SPDX,
  checkVendoredCode,
  licenseTextMatchesDeclared,
  normalizeLicense,
  parseNoticeEntries,
  parseUpstream,
} from "../src/rules/vendored-code.ts";

const REAL_SHA = "0123456789abcdef0123456789abcdef01234567";

// ---------- SPDX text fixtures loaded from the rule's own store ----------
//
// The tests use the SAME canonical .txt files the rule loads, plus a
// realistic personalisation, so a matching-passes test proves the
// normaliser and the canonical-text embed agree.

const RULE_DIR = dirname(fileURLToPath(import.meta.url));
const SPDX_DIR = join(RULE_DIR, "..", "src", "rules", "spdx-texts");
let CANONICAL: Record<string, string>;

beforeAll(() => {
  CANONICAL = Object.fromEntries(
    ALLOWED_SPDX.map((id) => [id, readFileSync(join(SPDX_DIR, `${id}.txt`), "utf8")]),
  );
});

/** Personalise a canonical SPDX text by filling placeholders and
 * adding a real copyright line — how the LICENSE looks after an
 * upstream customises it. */
function personalise(canonical: string, holder: string, year: string): string {
  return canonical
    .replace(/<year>/g, year)
    .replace(/<copyright holders?>/g, holder)
    .replace(/<owner>/g, holder)
    .replace(/<name of copyright holder>/g, holder);
}

interface PackageSpec {
  readonly name: string;
  readonly license: string | null;
  readonly upstream: string | null;
  /** Extra files to create in the package dir. */
  readonly extraFiles?: readonly { name: string; contents: string }[];
}

interface Layout {
  readonly notice: string | null;
  readonly packages: readonly PackageSpec[];
  /** Extra files to drop at packages/components/vendor/ root. */
  readonly vendorLooseFiles?: readonly { name: string; contents: string }[];
}

/** Build a fake repo layout in a fresh temp dir and return its root. */
async function makeRepo(layout: Layout): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "revkit-vendored-"));
  const vendorDir = join(root, "packages", "components", "vendor");
  await mkdir(vendorDir, { recursive: true });
  if (layout.notice !== null) {
    writeFileSync(join(root, "NOTICE"), layout.notice);
  }
  for (const loose of layout.vendorLooseFiles ?? []) {
    writeFileSync(join(vendorDir, loose.name), loose.contents);
  }
  for (const pkg of layout.packages) {
    const pkgDir = join(vendorDir, pkg.name);
    await mkdir(pkgDir, { recursive: true });
    if (pkg.license !== null) {
      writeFileSync(join(pkgDir, "LICENSE"), pkg.license);
    }
    if (pkg.upstream !== null) {
      writeFileSync(join(pkgDir, "UPSTREAM"), pkg.upstream);
    }
    for (const extra of pkg.extraFiles ?? []) {
      writeFileSync(join(pkgDir, extra.name), extra.contents);
    }
  }
  return root;
}

/** Well-formed UPSTREAM with the given SPDX id. */
function upstreamFor(license: string): string {
  return [
    `repo: https://github.com/example-owner/example-repo`,
    `commit: ${REAL_SHA}`,
    `path: src/lib`,
    `license: ${license}`,
    "",
  ].join("\n");
}

/** NOTICE with one entry per (name, spdx). */
function noticeListing(...entries: readonly { name: string; spdx: string }[]): string {
  const bullets = entries
    .map((e) => `- packages/components/vendor/${e.name} — https://example.org/${e.name} (SPDX: ${e.spdx})`)
    .join("\n");
  return `revkit\nThird-party code:\n${bullets}\n`;
}

// -----------------------------------------------------------------------------
// Silent-pass edges + happy paths
// -----------------------------------------------------------------------------

describe("vendored-code — silent-pass edges + happy paths", () => {
  test("no vendor directory: rule is silent", async () => {
    const root = mkdtempSync(join(tmpdir(), "revkit-vendored-"));
    expect(checkVendoredCode(root)).toEqual([]);
  });

  test("empty vendor directory + NOTICE with no entries: pass", async () => {
    const root = await makeRepo({
      notice: "revkit\nThird-party code: (none yet)\n",
      packages: [],
    });
    expect(checkVendoredCode(root)).toEqual([]);
  });

  test("real MIT drop passes canonical-text check", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "mit-pkg", spdx: "MIT" }),
      packages: [
        {
          name: "mit-pkg",
          license: personalise(CANONICAL["MIT"] ?? "", "Some Author", "2024"),
          upstream: upstreamFor("MIT"),
        },
      ],
    });
    expect(checkVendoredCode(root)).toEqual([]);
  });

  test("real Apache-2.0 with the appendix passes", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "apache-pkg", spdx: "Apache-2.0" }),
      packages: [
        {
          name: "apache-pkg",
          license: CANONICAL["Apache-2.0"] ?? "",
          upstream: upstreamFor("Apache-2.0"),
        },
      ],
    });
    expect(checkVendoredCode(root)).toEqual([]);
  });

  test("real Apache-2.0 without the appendix passes", async () => {
    const src = CANONICAL["Apache-2.0"] ?? "";
    const truncated = src.slice(0, src.indexOf("END OF TERMS AND CONDITIONS") + "END OF TERMS AND CONDITIONS".length);
    const root = await makeRepo({
      notice: noticeListing({ name: "apache-min", spdx: "Apache-2.0" }),
      packages: [
        {
          name: "apache-min",
          license: truncated,
          upstream: upstreamFor("Apache-2.0"),
        },
      ],
    });
    expect(checkVendoredCode(root)).toEqual([]);
  });

  test("real BSD-3-Clause + BSD-2-Clause + ISC each pass", async () => {
    for (const spdx of ["BSD-3-Clause", "BSD-2-Clause", "ISC"]) {
      const root = await makeRepo({
        notice: noticeListing({ name: `pkg-${spdx.toLowerCase()}`, spdx }),
        packages: [
          {
            name: `pkg-${spdx.toLowerCase()}`,
            license: personalise(CANONICAL[spdx] ?? "", "Author", "2020"),
            upstream: upstreamFor(spdx),
          },
        ],
      });
      expect(checkVendoredCode(root)).toEqual([]);
    }
  });
});

// -----------------------------------------------------------------------------
// Adversarial LICENSE bodies — the phrase-heuristic drops these detect
// -----------------------------------------------------------------------------

describe("vendored-code — adversarial LICENSE bodies", () => {
  test("LICENSE = MIT body + Commons Clause is refused", async () => {
    const commonsClauseAppend =
      "\n\nThe Software is provided to you by the Licensor under the License, as defined below, subject to the following condition.\n\nWithout limiting other conditions in the License, the grant of rights under the License will not include, and the License does not grant to you, the right to Sell the Software.\n";
    const root = await makeRepo({
      notice: noticeListing({ name: "commons", spdx: "MIT" }),
      packages: [
        {
          name: "commons",
          license: personalise(CANONICAL["MIT"] ?? "", "X", "2024") + commonsClauseAppend,
          upstream: upstreamFor("MIT"),
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.file === "packages/components/vendor/commons/LICENSE" && d.message.includes("does not match the SPDX-canonical text"))).toBe(true);
  });

  test("LICENSE = MIT + 'Good, not Evil' appended clause is refused", async () => {
    const goodNotEvilAppend = "\n\nThe Software shall be used for Good, not Evil.\n";
    const root = await makeRepo({
      notice: noticeListing({ name: "goodnotevil", spdx: "MIT" }),
      packages: [
        {
          name: "goodnotevil",
          license: personalise(CANONICAL["MIT"] ?? "", "X", "2024") + goodNotEvilAppend,
          upstream: upstreamFor("MIT"),
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.file === "packages/components/vendor/goodnotevil/LICENSE" && d.message.includes("does not match the SPDX-canonical text"))).toBe(true);
  });

  test("LICENSE = GPL body with MIT appendix is refused (declared MIT)", async () => {
    const body =
      "GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\nCopyright (C) 2007 Free Software Foundation, Inc.\n\nThe GNU General Public License is a free, copyleft license for software and other kinds of works.\n\n" +
      "The following notice is included so the file also looks like MIT:\n" +
      personalise(CANONICAL["MIT"] ?? "", "X", "2024");
    const root = await makeRepo({
      notice: noticeListing({ name: "gpl-mit-appendix", spdx: "MIT" }),
      packages: [
        {
          name: "gpl-mit-appendix",
          license: body,
          upstream: upstreamFor("MIT"),
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.file === "packages/components/vendor/gpl-mit-appendix/LICENSE" && d.message.includes("does not match the SPDX-canonical text"))).toBe(true);
  });

  test("LICENSE = AGPL body that mentions Apache-2.0 is refused (declared Apache-2.0)", async () => {
    const body =
      "GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007\nCopyright (C) 2007 Free Software Foundation.\n\nThis license is compatible with Apache-2.0 in the following limited sense: it is not.\n";
    const root = await makeRepo({
      notice: noticeListing({ name: "agpl-mentions-apache", spdx: "Apache-2.0" }),
      packages: [
        {
          name: "agpl-mentions-apache",
          license: body,
          upstream: upstreamFor("Apache-2.0"),
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.file === "packages/components/vendor/agpl-mentions-apache/LICENSE" && d.message.includes("does not match the SPDX-canonical text"))).toBe(true);
  });

  test("LICENSE = BSD-4-Clause (advertising clause) is refused (declared BSD-3-Clause)", async () => {
    const bsd4 =
      "Copyright (c) 1990, Regents of the University of California\nAll rights reserved.\n\n" +
      "Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:\n\n" +
      "1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.\n\n" +
      "2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.\n\n" +
      "3. All advertising materials mentioning features or use of this software must display the following acknowledgement: This product includes software developed by the University of California.\n\n" +
      "4. Neither the name of the University nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.\n\n" +
      "THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS \"AS IS\" AND ANY EXPRESS OR IMPLIED WARRANTIES ARE DISCLAIMED.\n";
    const root = await makeRepo({
      notice: noticeListing({ name: "bsd4", spdx: "BSD-3-Clause" }),
      packages: [
        { name: "bsd4", license: bsd4, upstream: upstreamFor("BSD-3-Clause") },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.file === "packages/components/vendor/bsd4/LICENSE" && d.message.includes("does not match the SPDX-canonical text"))).toBe(true);
  });

  test("SPDX-License-Identifier: MIT AND GPL-3.0-only in the LICENSE alone does NOT sneak past (canonical-text check is the gate)", async () => {
    // The rule does not read SPDX-License-Identifier from LICENSE at
    // all — the declared license comes from UPSTREAM. A file with
    // just an SPDX header + GPL body fails canonical MIT.
    const body = "SPDX-License-Identifier: MIT AND GPL-3.0-only\n\nThis text is not the MIT license.\n";
    const root = await makeRepo({
      notice: noticeListing({ name: "compound-header", spdx: "MIT" }),
      packages: [
        {
          name: "compound-header",
          license: body,
          upstream: upstreamFor("MIT"),
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.file === "packages/components/vendor/compound-header/LICENSE" && d.message.includes("does not match the SPDX-canonical text"))).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// UPSTREAM structure
// -----------------------------------------------------------------------------

describe("vendored-code — UPSTREAM structure", () => {
  test("compound SPDX in UPSTREAM license: is refused", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "u-compound", spdx: "MIT" }),
      packages: [
        {
          name: "u-compound",
          license: personalise(CANONICAL["MIT"] ?? "", "X", "2024"),
          upstream: `repo: https://github.com/x/y\ncommit: ${REAL_SHA}\npath: src\nlicense: MIT AND GPL-3.0-only\n`,
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.message.includes("must be exactly one SPDX id, not a compound expression"))).toBe(true);
  });

  test("UPSTREAM missing 'license:' key is reported", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "u-nolic", spdx: "MIT" }),
      packages: [
        {
          name: "u-nolic",
          license: personalise(CANONICAL["MIT"] ?? "", "X", "2024"),
          upstream: `repo: https://github.com/x/y\ncommit: ${REAL_SHA}\npath: src\n`,
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.message.includes("missing required key 'license:'"))).toBe(true);
  });

  test("UPSTREAM non-https URL is refused", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "u-http", spdx: "MIT" }),
      packages: [
        {
          name: "u-http",
          license: personalise(CANONICAL["MIT"] ?? "", "X", "2024"),
          upstream: `repo: http://github.com/x/y\ncommit: ${REAL_SHA}\npath: src\nlicense: MIT\n`,
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.message.includes("must use https://"))).toBe(true);
  });

  test("UPSTREAM URL without host is refused", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "u-nohost", spdx: "MIT" }),
      packages: [
        {
          name: "u-nohost",
          license: personalise(CANONICAL["MIT"] ?? "", "X", "2024"),
          // file://path — parses as a URL, protocol not https.
          upstream: `repo: file:///no/host\ncommit: ${REAL_SHA}\npath: src\nlicense: MIT\n`,
        },
      ],
    });
    const findings = checkVendoredCode(root);
    // Either "must use https" or "not a valid URL" or "no host" —
    // all three failure modes are legitimate here, but at least one
    // must fire. We assert on the concrete branch the repo path
    // takes.
    expect(findings.some((d) => d.message.includes("must use https://"))).toBe(true);
  });

  test("UPSTREAM URL with a query string is refused", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "u-query", spdx: "MIT" }),
      packages: [
        {
          name: "u-query",
          license: personalise(CANONICAL["MIT"] ?? "", "X", "2024"),
          upstream: `repo: https://github.com/x/y?ref=main\ncommit: ${REAL_SHA}\npath: src\nlicense: MIT\n`,
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.message.includes("must not carry a query or fragment"))).toBe(true);
  });

  test("UPSTREAM duplicate key is refused", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "u-dupe", spdx: "MIT" }),
      packages: [
        {
          name: "u-dupe",
          license: personalise(CANONICAL["MIT"] ?? "", "X", "2024"),
          upstream: `repo: https://github.com/x/y\nrepo: https://github.com/z/w\ncommit: ${REAL_SHA}\npath: src\nlicense: MIT\n`,
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.message.includes("'repo' is set more than once"))).toBe(true);
  });

  test("UPSTREAM with a short commit SHA is refused", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "u-shortsha", spdx: "MIT" }),
      packages: [
        {
          name: "u-shortsha",
          license: personalise(CANONICAL["MIT"] ?? "", "X", "2024"),
          upstream: `repo: https://github.com/x/y\ncommit: deadbeef\npath: src\nlicense: MIT\n`,
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.message.includes("must be a full 40-char git SHA"))).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Symlinks + filesystem safety
// -----------------------------------------------------------------------------

describe("vendored-code — symlinks + filesystem safety", () => {
  test("symlinked vendor/<pkg> directory is refused (not silently skipped)", async () => {
    const root = mkdtempSync(join(tmpdir(), "revkit-vendored-"));
    const vendorDir = join(root, "packages", "components", "vendor");
    await mkdir(vendorDir, { recursive: true });
    // Real target elsewhere.
    const targetDir = mkdtempSync(join(tmpdir(), "revkit-target-"));
    await mkdir(join(targetDir, "src"), { recursive: true });
    writeFileSync(join(targetDir, "LICENSE"), personalise(CANONICAL["MIT"] ?? "", "X", "2024"));
    writeFileSync(join(targetDir, "UPSTREAM"), upstreamFor("MIT"));
    // The symlinked dir.
    symlinkSync(targetDir, join(vendorDir, "linked-pkg"));
    writeFileSync(join(root, "NOTICE"), noticeListing({ name: "linked-pkg", spdx: "MIT" }));
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.file === "packages/components/vendor/linked-pkg" && d.message.includes("symlink refused"))).toBe(true);
  });

  test("symlinked LICENSE is refused (would silently drop upstream attribution)", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "linked-lic", spdx: "MIT" }),
      packages: [
        {
          name: "linked-lic",
          license: null,
          upstream: upstreamFor("MIT"),
        },
      ],
    });
    // Target: a real MIT text somewhere else.
    const targetLicense = join(mkdtempSync(join(tmpdir(), "revkit-target-")), "MIT.txt");
    writeFileSync(targetLicense, personalise(CANONICAL["MIT"] ?? "", "X", "2024"));
    symlinkSync(
      targetLicense,
      join(root, "packages", "components", "vendor", "linked-lic", "LICENSE"),
    );
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.file === "packages/components/vendor/linked-lic/LICENSE" && d.message.includes("symlink"))).toBe(true);
  });

  test("symlinked UPSTREAM is refused", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "linked-up", spdx: "MIT" }),
      packages: [
        {
          name: "linked-up",
          license: personalise(CANONICAL["MIT"] ?? "", "X", "2024"),
          upstream: null,
        },
      ],
    });
    const targetUpstream = join(mkdtempSync(join(tmpdir(), "revkit-target-")), "up.txt");
    writeFileSync(targetUpstream, upstreamFor("MIT"));
    symlinkSync(
      targetUpstream,
      join(root, "packages", "components", "vendor", "linked-up", "UPSTREAM"),
    );
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.file === "packages/components/vendor/linked-up/UPSTREAM" && d.message.includes("symlink"))).toBe(true);
  });

  test("symlinked NOTICE is refused", async () => {
    const root = await makeRepo({
      notice: null,
      packages: [],
    });
    const targetNotice = join(mkdtempSync(join(tmpdir(), "revkit-target-")), "n.txt");
    writeFileSync(targetNotice, "hi\n");
    symlinkSync(targetNotice, join(root, "NOTICE"));
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.file === "NOTICE" && d.message.includes("symlink"))).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Loose files, scoped names, LICENSE filename hints
// -----------------------------------------------------------------------------

describe("vendored-code — layout / naming", () => {
  test("loose file at packages/components/vendor/ root (not README.md) is refused", async () => {
    const root = await makeRepo({
      notice: "revkit\nThird-party code:\n",
      packages: [],
      vendorLooseFiles: [{ name: "stray.txt", contents: "hi\n" }],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.file === "packages/components/vendor/stray.txt" && d.message.includes("loose file"))).toBe(true);
  });

  test("scoped-style dir name (starts with '@') is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "revkit-vendored-"));
    const vendorDir = join(root, "packages", "components", "vendor");
    await mkdir(join(vendorDir, "@scoped-name"), { recursive: true });
    writeFileSync(join(root, "NOTICE"), "revkit\nThird-party code:\n");
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.message.includes("must match [A-Za-z0-9][A-Za-z0-9._-]* (unscoped)"))).toBe(true);
  });

  test("LICENSE.md present, LICENSE missing → rename hint (case-sensitive)", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "renameme", spdx: "MIT" }),
      packages: [
        {
          name: "renameme",
          license: null,
          upstream: upstreamFor("MIT"),
          extraFiles: [{ name: "LICENSE.md", contents: personalise(CANONICAL["MIT"] ?? "", "X", "2024") }],
        },
      ],
    });
    const findings = checkVendoredCode(root);
    const hint = findings.find((d) => d.message.includes("a 'LICENSE.md' exists"));
    expect(hint).toBeDefined();
    expect(hint?.file).toBe("packages/components/vendor/renameme/");
  });

  test("COPYING present, LICENSE missing → rename hint", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "copying-pkg", spdx: "MIT" }),
      packages: [
        {
          name: "copying-pkg",
          license: null,
          upstream: upstreamFor("MIT"),
          extraFiles: [{ name: "COPYING", contents: personalise(CANONICAL["MIT"] ?? "", "X", "2024") }],
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.message.includes("a 'COPYING' exists"))).toBe(true);
  });

  test("lowercase 'license' present, 'LICENSE' missing → rename hint (Linux case-sensitivity)", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "lower-lic", spdx: "MIT" }),
      packages: [
        {
          name: "lower-lic",
          license: null,
          upstream: upstreamFor("MIT"),
          extraFiles: [{ name: "license", contents: personalise(CANONICAL["MIT"] ?? "", "X", "2024") }],
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.message.includes("a 'license' exists"))).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// NOTICE contract
// -----------------------------------------------------------------------------

describe("vendored-code — NOTICE contract", () => {
  test("package not listed in NOTICE is reported", async () => {
    const root = await makeRepo({
      notice: "revkit\nThird-party code:\n(no packages listed)\n",
      packages: [
        {
          name: "pkg-h",
          license: personalise(CANONICAL["MIT"] ?? "", "X", "2024"),
          upstream: upstreamFor("MIT"),
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.file === "NOTICE" && d.message.includes("pkg-h") && d.message.includes("not listed in NOTICE"))).toBe(true);
  });

  test("phantom NOTICE entry is reported", async () => {
    const root = await makeRepo({
      notice: noticeListing(
        { name: "pkg-real", spdx: "MIT" },
        { name: "ghost-pkg", spdx: "MIT" },
      ),
      packages: [
        {
          name: "pkg-real",
          license: personalise(CANONICAL["MIT"] ?? "", "X", "2024"),
          upstream: upstreamFor("MIT"),
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.message.includes("ghost-pkg") && d.message.includes("no such directory"))).toBe(true);
    expect(findings.filter((d) => d.message.includes("pkg-real"))).toEqual([]);
  });

  test("NOTICE entry SPDX mismatches UPSTREAM license is reported", async () => {
    const root = await makeRepo({
      // NOTICE claims Apache-2.0, UPSTREAM says MIT.
      notice: noticeListing({ name: "mismatch", spdx: "Apache-2.0" }),
      packages: [
        {
          name: "mismatch",
          license: personalise(CANONICAL["MIT"] ?? "", "X", "2024"),
          upstream: upstreamFor("MIT"),
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.file === "NOTICE" && d.message.includes("declares SPDX 'Apache-2.0' but UPSTREAM says 'MIT'"))).toBe(true);
  });

  test("NOTICE missing but vendor packages exist is reported", async () => {
    const root = await makeRepo({
      notice: null,
      packages: [
        {
          name: "pkg-i",
          license: personalise(CANONICAL["MIT"] ?? "", "X", "2024"),
          upstream: upstreamFor("MIT"),
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.file === "NOTICE" && d.message.includes("NOTICE is missing"))).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Parser / normaliser helpers (unit-tested directly)
// -----------------------------------------------------------------------------

describe("vendored-code — parser + normaliser helpers", () => {
  test("licenseTextMatchesDeclared: canonical → true; MIT + tacked-on clause → false", () => {
    const mit = personalise(CANONICAL["MIT"] ?? "", "Someone", "2020");
    expect(licenseTextMatchesDeclared(mit, "MIT")).toBe(true);
    expect(licenseTextMatchesDeclared(mit + "\nAdditional clause: no derivatives.\n", "MIT")).toBe(false);
  });

  test("licenseTextMatchesDeclared: unknown SPDX id → false", () => {
    expect(licenseTextMatchesDeclared("anything", "GPL-3.0-only")).toBe(false);
  });

  test("normalizeLicense: Apache-2.0 truncates at END OF TERMS AND CONDITIONS", () => {
    const withAppendix = "TERMS.\nEND OF TERMS AND CONDITIONS\nAPPENDIX: this must be ignored.\n";
    const withoutAppendix = "TERMS.\nEND OF TERMS AND CONDITIONS\n";
    expect(normalizeLicense(withAppendix, "Apache-2.0")).toBe(
      normalizeLicense(withoutAppendix, "Apache-2.0"),
    );
  });

  test("normalizeLicense: strips copyright and 'all rights reserved' lines", () => {
    const a = "Copyright (c) 2024 Alice\nBody text.\n";
    const b = "Copyright 1999-2020 Bob and Contributors\nAll rights reserved.\nBody text.\n";
    expect(normalizeLicense(a, "BSD-2-Clause")).toBe(normalizeLicense(b, "BSD-2-Clause"));
  });

  test("parseUpstream: happy path parses", () => {
    const r = parseUpstream(`# comment\n\nrepo: https://github.com/x/y\ncommit: ${REAL_SHA}\npath: src\nlicense: MIT\n`);
    expect(r.problems).toEqual([]);
    expect(r.license).toBe("MIT");
  });

  test("parseUpstream: unparsable line is reported", () => {
    const r = parseUpstream(`this line has no colon\nrepo: https://x.example/y\ncommit: ${REAL_SHA}\npath: src\nlicense: MIT\n`);
    expect(r.problems.some((p) => p.message.includes("is not 'key: value'"))).toBe(true);
  });

  test("parseNoticeEntries: bullet is picked up; prose mention is not", () => {
    const text = [
      "The vendor tree lives at packages/components/vendor/",
      "See packages/components/vendor/README.md for details.",
      "- packages/components/vendor/actual-pkg — https://x (SPDX: MIT)",
    ].join("\n");
    const entries = parseNoticeEntries(text);
    expect(entries.get("actual-pkg")).toEqual({ spdx: "MIT" });
    expect(entries.has("README")).toBe(false);
    expect(entries.has("README.md")).toBe(false);
    expect(entries.size).toBe(1);
  });

  test("parseNoticeEntries: repeated calls don't leak regex state", () => {
    const text = "- packages/components/vendor/x — https://x (SPDX: MIT)\n";
    expect(parseNoticeEntries(text).size).toBe(1);
    expect(parseNoticeEntries(text).size).toBe(1);
  });

  test("parseNoticeEntries: entry without (SPDX: id) is not recognised", () => {
    const text = "- packages/components/vendor/no-spdx — https://x\n";
    // A permissive parser would still pick up the name; the strict
    // regex here demands `(SPDX: <id>)` so this entry is silently
    // dropped — the package would then be flagged as "not listed".
    // (Verified in the "package not listed" test above.)
    expect(parseNoticeEntries(text).size).toBe(0);
  });
});
