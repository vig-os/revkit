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
// Scope: STRUCTURAL checks. This rule deliberately does not compare
// LICENSE bytes against SPDX-canonical templates — see the header
// comment in `rules/vendored-code.ts` and the "Why not text-matching?"
// section in `packages/components/vendor/README.md`. The LICENSE
// bytes are gated by CODEOWNERS.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkVendoredCode,
  parseNoticeEntries,
  parseUpstream,
} from "../src/rules/vendored-code.ts";
import { walkForCheckables } from "../src/file-discovery.ts";
import { runCheck, toCheckFiles } from "../src/check.ts";

const REAL_SHA = "0123456789abcdef0123456789abcdef01234567";

/** Placeholder LICENSE bytes. This rule does not read them; the
 * content just has to exist as a real (non-symlinked) file. */
const PLACEHOLDER_LICENSE =
  "Upstream LICENSE bytes — reviewed by CODEOWNERS.\n";

interface PackageSpec {
  readonly name: string;
  readonly license: string | null;
  readonly upstream: string | null;
  /** Extra files to create in the package dir. */
  readonly extraFiles?: readonly { name: string; contents: string }[];
  /** Nested subdirs (with their own files) — for the nested-symlink
   * test. */
  readonly nestedDirs?: readonly { path: string; symlinkTo?: string }[];
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
    for (const nested of pkg.nestedDirs ?? []) {
      const nestedAbs = join(pkgDir, nested.path);
      await mkdir(join(nestedAbs, ".."), { recursive: true });
      if (nested.symlinkTo !== undefined) {
        symlinkSync(nested.symlinkTo, nestedAbs);
      } else {
        writeFileSync(nestedAbs, "// stub\n");
      }
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
// Silent-pass edges + happy path
// -----------------------------------------------------------------------------

describe("vendored-code — silent-pass edges + happy path", () => {
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

  test("happy path: LICENSE present + valid UPSTREAM + matching NOTICE entry → zero findings", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "pkg-happy", spdx: "MIT" }),
      packages: [
        { name: "pkg-happy", license: PLACEHOLDER_LICENSE, upstream: upstreamFor("MIT") },
      ],
    });
    expect(checkVendoredCode(root)).toEqual([]);
  });

  test("happy path for every allowed SPDX id (Apache-2.0 / BSD-2 / BSD-3 / ISC / MIT)", async () => {
    for (const spdx of ["Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT"]) {
      const name = `pkg-${spdx.replace(/[^A-Za-z0-9]/g, "").toLowerCase()}`;
      const root = await makeRepo({
        notice: noticeListing({ name, spdx }),
        packages: [
          { name, license: PLACEHOLDER_LICENSE, upstream: upstreamFor(spdx) },
        ],
      });
      expect(checkVendoredCode(root)).toEqual([]);
    }
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
          license: PLACEHOLDER_LICENSE,
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
          license: PLACEHOLDER_LICENSE,
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
          license: PLACEHOLDER_LICENSE,
          upstream: `repo: http://github.com/x/y\ncommit: ${REAL_SHA}\npath: src\nlicense: MIT\n`,
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.message.includes("must use https://"))).toBe(true);
  });

  test("UPSTREAM URL with a query string is refused", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "u-query", spdx: "MIT" }),
      packages: [
        {
          name: "u-query",
          license: PLACEHOLDER_LICENSE,
          upstream: `repo: https://github.com/x/y?ref=main\ncommit: ${REAL_SHA}\npath: src\nlicense: MIT\n`,
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.message.includes("must not carry a query or fragment"))).toBe(true);
  });

  test("UPSTREAM URL with a fragment is refused", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "u-frag", spdx: "MIT" }),
      packages: [
        {
          name: "u-frag",
          license: PLACEHOLDER_LICENSE,
          upstream: `repo: https://github.com/x/y#readme\ncommit: ${REAL_SHA}\npath: src\nlicense: MIT\n`,
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.message.includes("must not carry a query or fragment"))).toBe(true);
  });

  test("UPSTREAM URL without a host is refused", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "u-nohost", spdx: "MIT" }),
      packages: [
        {
          name: "u-nohost",
          license: PLACEHOLDER_LICENSE,
          // file:// parses as a URL but its protocol is not https.
          upstream: `repo: file:///no/host\ncommit: ${REAL_SHA}\npath: src\nlicense: MIT\n`,
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.message.includes("must use https://"))).toBe(true);
  });

  test("UPSTREAM 'repo:' that is not a URL at all is refused", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "u-badurl", spdx: "MIT" }),
      packages: [
        {
          name: "u-badurl",
          license: PLACEHOLDER_LICENSE,
          upstream: `repo: not-a-url\ncommit: ${REAL_SHA}\npath: src\nlicense: MIT\n`,
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.message.includes("not a valid URL"))).toBe(true);
  });

  test("UPSTREAM duplicate key is refused", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "u-dupe", spdx: "MIT" }),
      packages: [
        {
          name: "u-dupe",
          license: PLACEHOLDER_LICENSE,
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
          license: PLACEHOLDER_LICENSE,
          upstream: `repo: https://github.com/x/y\ncommit: deadbeef\npath: src\nlicense: MIT\n`,
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.message.includes("must be a full 40-char git SHA"))).toBe(true);
  });

  test("UPSTREAM with an unparsable line (no colon) is refused", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "u-nocolon", spdx: "MIT" }),
      packages: [
        {
          name: "u-nocolon",
          license: PLACEHOLDER_LICENSE,
          upstream: `no colon here\nrepo: https://github.com/x/y\ncommit: ${REAL_SHA}\npath: src\nlicense: MIT\n`,
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.message.includes("is not 'key: value'"))).toBe(true);
  });

  test("UPSTREAM forbidden SPDX id (GPL-3.0-only) is refused", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "u-gpl", spdx: "MIT" }),
      packages: [
        {
          name: "u-gpl",
          license: PLACEHOLDER_LICENSE,
          upstream: `repo: https://github.com/x/y\ncommit: ${REAL_SHA}\npath: src\nlicense: GPL-3.0-only\n`,
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.message.includes("'GPL-3.0-only' is not permitted"))).toBe(true);
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
    writeFileSync(join(targetDir, "LICENSE"), PLACEHOLDER_LICENSE);
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
        { name: "linked-lic", license: null, upstream: upstreamFor("MIT") },
      ],
    });
    const targetLicense = join(mkdtempSync(join(tmpdir(), "revkit-target-")), "MIT.txt");
    writeFileSync(targetLicense, PLACEHOLDER_LICENSE);
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
        { name: "linked-up", license: PLACEHOLDER_LICENSE, upstream: null },
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
    const root = await makeRepo({ notice: null, packages: [] });
    const targetNotice = join(mkdtempSync(join(tmpdir(), "revkit-target-")), "n.txt");
    writeFileSync(targetNotice, "hi\n");
    symlinkSync(targetNotice, join(root, "NOTICE"));
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.file === "NOTICE" && d.message.includes("symlink"))).toBe(true);
  });

  test("nested symlink inside a package (vendor/<pkg>/sub/x.ts -> /etc/passwd) is refused by the workspace walk (end-to-end)", async () => {
    // The vendored-code rule inspects only the package dir root; the
    // symlink refusal for anything DEEPER lives in file-discovery's
    // walkForCheckables + SYMLINK_REFUSED_PREFIXES. Running the two
    // together simulates the pre-commit / CI path.
    const root = await makeRepo({
      notice: noticeListing({ name: "nested", spdx: "MIT" }),
      packages: [
        {
          name: "nested",
          license: PLACEHOLDER_LICENSE,
          upstream: upstreamFor("MIT"),
        },
      ],
    });
    // A subdir with a symlinked file inside.
    const pkgDir = join(root, "packages", "components", "vendor", "nested");
    await mkdir(join(pkgDir, "sub"), { recursive: true });
    symlinkSync("/etc/passwd", join(pkgDir, "sub", "x.ts"));

    // The workspace walk surfaces the symlink under the refused
    // prefix as a DiscoveredSymlink, which the check orchestrator
    // then reports with the `no-hand-rolled-ui` rule id (that's the
    // shared symlink-refusal message).
    const { files, symlinks } = walkForCheckables(root);
    const nestedRel = "packages/components/vendor/nested/sub/x.ts";
    expect(symlinks.some((s) => s.posixPath === nestedRel)).toBe(true);
    expect(files.some((f) => f.endsWith("/sub/x.ts"))).toBe(false);

    // Full-pipeline: runCheck emits a diagnostic for the nested
    // symlink, and the whole invocation returns a non-zero exit.
    const output = await runCheck(
      root,
      toCheckFiles(files, root),
      symlinks,
      {
        online: false,
        repoSlug: "vig-os/revkit",
        gh: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      },
    );
    expect(output.exitCode).toBe(1);
    expect(output.lines.some((line) => line.includes(nestedRel) && line.includes("symlink"))).toBe(true);
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
          extraFiles: [{ name: "LICENSE.md", contents: PLACEHOLDER_LICENSE }],
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
          extraFiles: [{ name: "COPYING", contents: PLACEHOLDER_LICENSE }],
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
          extraFiles: [{ name: "license", contents: PLACEHOLDER_LICENSE }],
        },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.message.includes("a 'license' exists"))).toBe(true);
  });

  test("missing LICENSE with no sibling candidates: bare message, no hint", async () => {
    const root = await makeRepo({
      notice: noticeListing({ name: "nolic", spdx: "MIT" }),
      packages: [{ name: "nolic", license: null, upstream: upstreamFor("MIT") }],
    });
    const findings = checkVendoredCode(root);
    const licenseFinding = findings.find((d) => d.file === "packages/components/vendor/nolic/" && d.message.startsWith("missing upstream LICENSE file"));
    expect(licenseFinding).toBeDefined();
    expect(licenseFinding?.message).not.toContain("exists; rename it");
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
        { name: "pkg-h", license: PLACEHOLDER_LICENSE, upstream: upstreamFor("MIT") },
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
        { name: "pkg-real", license: PLACEHOLDER_LICENSE, upstream: upstreamFor("MIT") },
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
        { name: "mismatch", license: PLACEHOLDER_LICENSE, upstream: upstreamFor("MIT") },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.file === "NOTICE" && d.message.includes("declares SPDX 'Apache-2.0' but UPSTREAM says 'MIT'"))).toBe(true);
  });

  test("NOTICE missing but vendor packages exist is reported", async () => {
    const root = await makeRepo({
      notice: null,
      packages: [
        { name: "pkg-i", license: PLACEHOLDER_LICENSE, upstream: upstreamFor("MIT") },
      ],
    });
    const findings = checkVendoredCode(root);
    expect(findings.some((d) => d.file === "NOTICE" && d.message.includes("NOTICE is missing"))).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Parser helpers (unit-tested directly)
// -----------------------------------------------------------------------------

describe("vendored-code — parser helpers", () => {
  test("parseUpstream: happy path parses", () => {
    const r = parseUpstream(`# comment\n\nrepo: https://github.com/x/y\ncommit: ${REAL_SHA}\npath: src\nlicense: MIT\n`);
    expect(r.problems).toEqual([]);
    expect(r.license).toBe("MIT");
  });

  test("parseUpstream: unparsable line is reported", () => {
    const r = parseUpstream(`this line has no colon\nrepo: https://x.example/y\ncommit: ${REAL_SHA}\npath: src\nlicense: MIT\n`);
    expect(r.problems.some((p) => p.message.includes("is not 'key: value'"))).toBe(true);
  });

  test("parseUpstream: empty path is allowed, empty repo is not", () => {
    const goodPath = parseUpstream(`repo: https://x.example/y\ncommit: ${REAL_SHA}\npath: \nlicense: MIT\n`);
    expect(goodPath.problems).toEqual([]);
    const emptyRepo = parseUpstream(`repo: \ncommit: ${REAL_SHA}\npath: src\nlicense: MIT\n`);
    expect(emptyRepo.problems.some((p) => p.message.includes("'repo:' has an empty value"))).toBe(true);
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
    expect(parseNoticeEntries(text).size).toBe(0);
  });
});
