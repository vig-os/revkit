// Unit tests for the CSP inline-script hash loader (`csp-hashes.ts`).
//
// The loader reads `<dir>/.revkit/csp-hashes.json` and either returns
// the parsed hex hashes or a `loaded: false` reason. The daemon
// fail-closes when the loader returns `loaded: false`; these tests
// pin the shape and the fail-closed behaviours (missing / malformed
// artefact).

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CSP_HASHES_ARTEFACT_PATH, loadCspHashes } from "../../src/serve/csp-hashes.ts";

/** Scratch dist directory that plays the role of `site/dist`. */
function makeDist(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "revkit-csp-hashes-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Write an artefact at the well-known path under `dir`. */
function writeArtefact(dir: string, content: string): void {
  const p = join(dir, CSP_HASHES_ARTEFACT_PATH);
  mkdirSync(join(dir, ".revkit"), { recursive: true });
  writeFileSync(p, content, "utf8");
}

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

describe("loadCspHashes — happy path", () => {
  test("reads a well-formed artefact and returns sorted, deduped hashes", () => {
    const { dir, cleanup } = makeDist();
    try {
      writeArtefact(
        dir,
        JSON.stringify({ version: 1, algorithm: "sha256", hashes: [H2, H1, H1] }),
      );
      const result = loadCspHashes(dir);
      expect(result.loaded).toBe(true);
      if (!result.loaded) throw new Error("unreachable");
      expect(result.hashes).toEqual([H1, H2]);
      expect(result.artefactPath.endsWith(CSP_HASHES_ARTEFACT_PATH)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("empty hashes array is a valid artefact — CSP still ships, just with no inline allowance", () => {
    const { dir, cleanup } = makeDist();
    try {
      writeArtefact(dir, JSON.stringify({ version: 1, algorithm: "sha256", hashes: [] }));
      const result = loadCspHashes(dir);
      expect(result.loaded).toBe(true);
      if (!result.loaded) throw new Error("unreachable");
      expect(result.hashes).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("loadCspHashes — fail-closed", () => {
  test("missing artefact returns loaded=false with an ENOENT-shaped reason", () => {
    const { dir, cleanup } = makeDist();
    try {
      const result = loadCspHashes(dir);
      expect(result.loaded).toBe(false);
      if (result.loaded) throw new Error("unreachable");
      expect(result.reason).toMatch(/missing/i);
    } finally {
      cleanup();
    }
  });

  test("invalid JSON returns loaded=false with a parse-error reason", () => {
    const { dir, cleanup } = makeDist();
    try {
      writeArtefact(dir, "not json {");
      const result = loadCspHashes(dir);
      expect(result.loaded).toBe(false);
      if (result.loaded) throw new Error("unreachable");
      expect(result.reason).toMatch(/invalid json/i);
    } finally {
      cleanup();
    }
  });

  test("schema mismatch (bad hex) refuses without partial acceptance", () => {
    const { dir, cleanup } = makeDist();
    try {
      writeArtefact(
        dir,
        // 63 chars — one short of a valid SHA-256 hex digest.
        JSON.stringify({ version: 1, algorithm: "sha256", hashes: ["a".repeat(63)] }),
      );
      const result = loadCspHashes(dir);
      expect(result.loaded).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("wrong version refuses (a future v2 file must not silently downgrade)", () => {
    const { dir, cleanup } = makeDist();
    try {
      writeArtefact(dir, JSON.stringify({ version: 2, algorithm: "sha256", hashes: [] }));
      const result = loadCspHashes(dir);
      expect(result.loaded).toBe(false);
    } finally {
      cleanup();
    }
  });
});
