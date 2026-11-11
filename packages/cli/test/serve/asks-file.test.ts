// Unit tests for `asks-file.ts` — per-ask JSON files under
// `.revkit/asks/<id>.json`. The daemon integration tests cover the
// mode + shape end-to-end; this file pins the small contract
// (atomic write, mode 0600 file / 0700 dir, refuses invalid ids,
// removes on cancel).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askFileSchema, type AskFile } from "@revkit/review-core";
import {
  askFilePath,
  asksDir,
  ensureAsksDir,
  listAskFiles,
  readAskFile,
  removeAskFile,
  writeAskFile,
} from "../../src/serve/asks-file.ts";

let tempRoot: string | undefined;
afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

const goodSpec: AskFile = {
  schemaVersion: 1,
  kind: "text",
  title: "Anything to add?",
  multiline: true,
};

function seedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "revkit-asks-file-"));
  tempRoot = root;
  return root;
}

describe("asks-file — happy path", () => {
  test("writeAskFile writes the spec at mode 0600 and returns the path", () => {
    const root = seedRoot();
    const path = writeAskFile(root, "ask-1", goodSpec);
    expect(path).toBe(askFilePath(root, "ask-1"));
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    // Directory mode.
    const dirMode = statSync(asksDir(root)).mode & 0o777;
    expect(dirMode).toBe(0o700);
    // File contents round-trip through askFileSchema.
    const parsed = askFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(parsed.kind).toBe("text");
  });

  test("readAskFile returns undefined for a missing file", () => {
    const root = seedRoot();
    ensureAsksDir(root);
    expect(readAskFile(root, "does-not-exist")).toBeUndefined();
  });

  test("readAskFile parses a valid file back", () => {
    const root = seedRoot();
    writeAskFile(root, "ask-2", goodSpec);
    expect(readAskFile(root, "ask-2")).toEqual(goodSpec);
  });

  test("removeAskFile is idempotent", () => {
    const root = seedRoot();
    writeAskFile(root, "ask-3", goodSpec);
    removeAskFile(root, "ask-3");
    expect(existsSync(askFilePath(root, "ask-3"))).toBe(false);
    // Second call: no error.
    removeAskFile(root, "ask-3");
  });

  test("listAskFiles returns basenames without the .json suffix, sorted", () => {
    const root = seedRoot();
    writeAskFile(root, "aaa", goodSpec);
    writeAskFile(root, "zzz", goodSpec);
    writeAskFile(root, "mmm", goodSpec);
    expect(listAskFiles(root)).toEqual(["aaa", "mmm", "zzz"]);
  });

  test("listAskFiles skips entries whose basename fails idSchema", () => {
    const root = seedRoot();
    ensureAsksDir(root);
    // Plant a stray file with an invalid id.
    writeFileSync(join(asksDir(root), "bad name.json"), "{}");
    // Plant one with the right shape.
    writeAskFile(root, "ok-1", goodSpec);
    expect(listAskFiles(root)).toEqual(["ok-1"]);
  });
});

describe("asks-file — rejections", () => {
  test("writeAskFile refuses an id that fails idSchema", () => {
    const root = seedRoot();
    expect(() => writeAskFile(root, "has space", goodSpec)).toThrow(/invalid id/);
  });

  test("writeAskFile refuses an EXISTING file (asks are one-shot per id)", () => {
    const root = seedRoot();
    writeAskFile(root, "ask-4", goodSpec);
    // A second write with the same id would let a subtle recreate
    // race land, so we require the caller to route through the
    // validator first. The `wx` flag surfaces this as an error.
    expect(() => writeAskFile(root, "ask-4", goodSpec)).toThrow();
  });

  test("writeAskFile refuses a spec that fails askFileSchema", () => {
    const root = seedRoot();
    // Missing schemaVersion → strict rejection.
    expect(() =>
      writeAskFile(root, "ask-5", { kind: "text", title: "" } as unknown as AskFile),
    ).toThrow();
  });
});
