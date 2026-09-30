// vendored-code rule tests (ADR-0022). One temp-dir per test builds a
// mini "repo" — a NOTICE at the root and zero-or-more
// packages/components/vendor/<pkg>/ subdirectories with LICENSE and
// UPSTREAM files — so each failure mode is exercised in isolation.
//
// Each test is written so that REMOVING the rule (or a specific
// branch of it) would flip the assertion. A test that only checked
// "did the rule return anything at all" would silently keep passing
// after the branch it targets was deleted.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkVendoredCode,
  detectSpdx,
  noticeEntries,
  parseUpstream,
} from "../src/rules/vendored-code.ts";

/** SHA that looks real: 40 lowercase hex chars. */
const REAL_SHA = "0123456789abcdef0123456789abcdef01234567";

const MIT_LICENSE = `MIT License

Copyright (c) 2020 Some Upstream Author

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS".
`;

const GPL_LICENSE = `                    GNU GENERAL PUBLIC LICENSE
                       Version 3, 29 June 2007

 Copyright (C) 2007 Free Software Foundation, Inc. <https://fsf.org/>
 Everyone is permitted to copy and distribute verbatim copies
 of this license document, but changing it is not allowed.
`;

const GOOD_UPSTREAM = `repo: https://github.com/hngngn/shadcn-solid
commit: ${REAL_SHA}
path: packages/cli/templates/button.tsx
`;

interface Layout {
  /** NOTICE contents, or null to omit the file. */
  readonly notice: string | null;
  /** vendor/<pkg>/ subdirectories to create. */
  readonly packages: readonly {
    readonly name: string;
    /** LICENSE contents, or null to omit the file. */
    readonly license: string | null;
    /** UPSTREAM contents, or null to omit the file. */
    readonly upstream: string | null;
  }[];
}

/** Build a fake repo layout in a fresh temp dir and return its root. */
async function makeRepo(layout: Layout): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "revkit-vendored-"));
  const vendorDir = join(root, "packages", "components", "vendor");
  await mkdir(vendorDir, { recursive: true });
  if (layout.notice !== null) {
    writeFileSync(join(root, "NOTICE"), layout.notice);
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
  }
  return root;
}

/** NOTICE with one bullet entry for `name`. */
function noticeListing(...names: readonly string[]): string {
  const bullets = names
    .map((n) => `- packages/components/vendor/${n} — https://example.org/${n} (SPDX: MIT)`)
    .join("\n");
  return `revkit\nCopyright 2026 gerchowl and contributors\n\nThird-party code:\n${bullets}\n`;
}

describe("vendored-code — silent-pass edges", () => {
  test("no vendor directory: rule is silent (a fork that deletes both opts out)", async () => {
    const root = mkdtempSync(join(tmpdir(), "revkit-vendored-"));
    // Deliberately do NOT create packages/components/vendor.
    expect(checkVendoredCode(root)).toEqual([]);
  });

  test("empty vendor directory (README only) + NOTICE with no entries: pass", async () => {
    const root = await makeRepo({
      notice: "revkit\nThird-party code: (none yet)\n",
      packages: [],
    });
    expect(checkVendoredCode(root)).toEqual([]);
  });

  test("passing case: LICENSE (MIT) + UPSTREAM + NOTICE entry", async () => {
    const root = await makeRepo({
      notice: noticeListing("shadcn-button"),
      packages: [
        { name: "shadcn-button", license: MIT_LICENSE, upstream: GOOD_UPSTREAM },
      ],
    });
    expect(checkVendoredCode(root)).toEqual([]);
  });
});

describe("vendored-code — failure modes", () => {
  test("missing LICENSE is reported", async () => {
    const root = await makeRepo({
      notice: noticeListing("pkg-a"),
      packages: [{ name: "pkg-a", license: null, upstream: GOOD_UPSTREAM }],
    });
    const diagnostics = checkVendoredCode(root);
    // Exactly one diagnostic, aimed at the missing LICENSE (removing
    // the LICENSE branch would drop this finding).
    const licenseFindings = diagnostics.filter((d) =>
      d.message.includes("missing upstream LICENSE"),
    );
    expect(licenseFindings.length).toBe(1);
    expect(licenseFindings[0]?.rule).toBe("vendored-code");
    expect(licenseFindings[0]?.file).toBe("packages/components/vendor/pkg-a/");
  });

  test("unknown/copyleft license (GPL) is refused", async () => {
    const root = await makeRepo({
      notice: noticeListing("pkg-b"),
      packages: [{ name: "pkg-b", license: GPL_LICENSE, upstream: GOOD_UPSTREAM }],
    });
    const diagnostics = checkVendoredCode(root);
    const licenseFindings = diagnostics.filter((d) =>
      d.file === "packages/components/vendor/pkg-b/LICENSE",
    );
    expect(licenseFindings.length).toBe(1);
    // GPL matches no allowed pattern, so it reports as unrecognised
    // (not "GPL is refused"). Removing the SPDX allowlist would keep
    // a random text through and drop this finding.
    expect(licenseFindings[0]?.message).toContain("unrecognised license");
  });

  test("explicit-but-forbidden SPDX header (GPL-3.0) is refused", async () => {
    const root = await makeRepo({
      notice: noticeListing("pkg-c"),
      packages: [
        {
          name: "pkg-c",
          license: "SPDX-License-Identifier: GPL-3.0-only\n",
          upstream: GOOD_UPSTREAM,
        },
      ],
    });
    const diagnostics = checkVendoredCode(root);
    const licenseFindings = diagnostics.filter((d) =>
      d.file === "packages/components/vendor/pkg-c/LICENSE",
    );
    expect(licenseFindings.length).toBe(1);
    expect(licenseFindings[0]?.message).toContain("GPL-3.0-only");
    expect(licenseFindings[0]?.message).toContain("not permitted");
  });

  test("missing UPSTREAM is reported", async () => {
    const root = await makeRepo({
      notice: noticeListing("pkg-d"),
      packages: [{ name: "pkg-d", license: MIT_LICENSE, upstream: null }],
    });
    const diagnostics = checkVendoredCode(root);
    const upstreamFindings = diagnostics.filter((d) =>
      d.message.includes("missing UPSTREAM"),
    );
    expect(upstreamFindings.length).toBe(1);
    expect(upstreamFindings[0]?.file).toBe("packages/components/vendor/pkg-d/");
  });

  test("UPSTREAM missing required key(s) is reported", async () => {
    const root = await makeRepo({
      notice: noticeListing("pkg-e"),
      packages: [
        {
          name: "pkg-e",
          license: MIT_LICENSE,
          upstream: `repo: https://github.com/x/y\ncommit: ${REAL_SHA}\n`,
        },
      ],
    });
    const diagnostics = checkVendoredCode(root);
    const upstreamFindings = diagnostics.filter((d) =>
      d.file === "packages/components/vendor/pkg-e/UPSTREAM",
    );
    expect(upstreamFindings.length).toBe(1);
    expect(upstreamFindings[0]?.message).toContain("missing required key(s): path");
  });

  test("UPSTREAM with a short commit SHA is refused", async () => {
    const root = await makeRepo({
      notice: noticeListing("pkg-f"),
      packages: [
        {
          name: "pkg-f",
          license: MIT_LICENSE,
          upstream: `repo: https://github.com/x/y\ncommit: deadbeef\npath: src\n`,
        },
      ],
    });
    const diagnostics = checkVendoredCode(root);
    const shaFindings = diagnostics.filter((d) =>
      d.message.includes("full 40-char git SHA"),
    );
    expect(shaFindings.length).toBe(1);
    expect(shaFindings[0]?.message).toContain("deadbeef");
  });

  test("UPSTREAM with a non-URL repo is refused", async () => {
    const root = await makeRepo({
      notice: noticeListing("pkg-g"),
      packages: [
        {
          name: "pkg-g",
          license: MIT_LICENSE,
          upstream: `repo: git@github.com:x/y.git\ncommit: ${REAL_SHA}\npath: src\n`,
        },
      ],
    });
    const diagnostics = checkVendoredCode(root);
    const repoFindings = diagnostics.filter((d) =>
      d.message.includes("must be an http(s):// URL"),
    );
    expect(repoFindings.length).toBe(1);
  });

  test("package not listed in NOTICE is reported", async () => {
    const root = await makeRepo({
      // NOTICE exists but has no bullet entry for pkg-h.
      notice: "revkit\nThird-party code:\n(no packages listed)\n",
      packages: [
        { name: "pkg-h", license: MIT_LICENSE, upstream: GOOD_UPSTREAM },
      ],
    });
    const diagnostics = checkVendoredCode(root);
    const noticeFindings = diagnostics.filter((d) =>
      d.message.includes("not listed in NOTICE"),
    );
    expect(noticeFindings.length).toBe(1);
    expect(noticeFindings[0]?.file).toBe("NOTICE");
    expect(noticeFindings[0]?.message).toContain("pkg-h");
  });

  test("NOTICE lists a package that does not exist is reported", async () => {
    const root = await makeRepo({
      // Real pkg-real exists; NOTICE also mentions ghost-pkg which does not.
      notice: noticeListing("pkg-real", "ghost-pkg"),
      packages: [
        { name: "pkg-real", license: MIT_LICENSE, upstream: GOOD_UPSTREAM },
      ],
    });
    const diagnostics = checkVendoredCode(root);
    const phantomFindings = diagnostics.filter((d) =>
      d.message.includes("but no such directory exists"),
    );
    expect(phantomFindings.length).toBe(1);
    expect(phantomFindings[0]?.message).toContain("ghost-pkg");
    // And the real one has no findings.
    const realFindings = diagnostics.filter((d) =>
      d.file.includes("pkg-real"),
    );
    expect(realFindings).toEqual([]);
  });

  test("NOTICE missing but vendor packages exist is reported", async () => {
    const root = await makeRepo({
      notice: null,
      packages: [
        { name: "pkg-i", license: MIT_LICENSE, upstream: GOOD_UPSTREAM },
      ],
    });
    const diagnostics = checkVendoredCode(root);
    const noticeFindings = diagnostics.filter((d) =>
      d.file === "NOTICE" && d.message.includes("NOTICE is missing"),
    );
    expect(noticeFindings.length).toBe(1);
  });
});

describe("vendored-code — parser helpers", () => {
  test("detectSpdx: SPDX header wins over text detection", () => {
    // Text says MIT, header says Apache-2.0 — header wins.
    const text = `SPDX-License-Identifier: Apache-2.0\n\n${MIT_LICENSE}`;
    expect(detectSpdx(text)).toBe("Apache-2.0");
  });

  test("detectSpdx: recognises Apache-2.0 body text without a header", () => {
    const body = `                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/`;
    expect(detectSpdx(body)).toBe("Apache-2.0");
  });

  test("detectSpdx: returns null on empty / unknown text", () => {
    expect(detectSpdx("")).toBe(null);
    expect(detectSpdx("some random legal-sounding paragraph")).toBe(null);
  });

  test("parseUpstream: strips comments and blank lines, lower-cases keys", () => {
    const parsed = parseUpstream(
      `# a comment\n\nRepo: https://github.com/x/y\nCommit: ${REAL_SHA}\nPath: src\n`,
    );
    expect(parsed.missing).toEqual([]);
    expect(parsed.badCommit).toBe(null);
    expect(parsed.badRepo).toBe(null);
  });

  test("noticeEntries: bullet with the path is picked up; prose mention is not", () => {
    const text = [
      "prose that mentions packages/components/vendor/ in passing",
      "- packages/components/vendor/actual-pkg — https://x (SPDX: MIT)",
      "another line about packages/components/vendor/README.md as a path",
    ].join("\n");
    const names = noticeEntries(text);
    expect(names.has("actual-pkg")).toBe(true);
    // The regex is line-anchored to `- packages/components/...`, so
    // the prose mentions above must not be captured. This is the
    // reason the rule can co-exist with the vendor README's own
    // prose description of the layout.
    expect(names.has("README")).toBe(false);
    expect(names.has("README.md")).toBe(false);
    expect(names.size).toBe(1);
  });

  test("noticeEntries: repeated calls do not leak regex state", () => {
    const text = "- packages/components/vendor/x — https://x (SPDX: MIT)\n";
    expect(noticeEntries(text).size).toBe(1);
    // A stateful `g` regex would return 0 on the second call.
    expect(noticeEntries(text).size).toBe(1);
  });
});
