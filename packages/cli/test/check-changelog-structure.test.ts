// The changelog-validate pre-commit gate (#228): structure only, never content, so it passes
// on release branches where the freeze leaves `## Unreleased` empty.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain ESM script, no type declarations
import { findRepeatedHeadings } from "../../../scripts/check-changelog-structure.mjs";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/check-changelog-structure.mjs");
const repoChangelog = resolve(dirname(script), "../CHANGELOG.md");

const EMPTY_UNRELEASED = "## Unreleased\n\n### Added\n\n### Changed\n\n### Fixed\n\n";
const FROZEN_RELEASE = "## [0.1.0] - TBD\n\n### Added\n\n- A thing\n\n### Fixed\n\n- Another\n";
const header = "# Changelog\n\nAll notable changes.\n\n";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "revkit-changelog-"));
  dirs.push(dir);
  const file = join(dir, "CHANGELOG.md");
  writeFileSync(file, text);
  const proc = Bun.spawnSync(["node", script, file]);
  return { code: proc.exitCode, err: proc.stderr.toString() };
}

describe("check-changelog-structure", () => {
  test("a repeated heading in Unreleased fails and names the section and lines", () => {
    const r = run(`${header}## Unreleased\n\n### Fixed\n\n- one\n\n### Added\n\n- two\n\n### Fixed\n\n- three\n`);
    expect(r.code).toBe(1);
    expect(r.err).toContain('"## Unreleased" repeats "### Fixed" (lines 7, 15)');
  });

  test("a repeated heading in a version section fails", () => {
    const r = run(`${header}${EMPTY_UNRELEASED}${FROZEN_RELEASE}\n### Added\n\n- dup\n`);
    expect(r.code).toBe(1);
    expect(r.err).toContain('"## [0.1.0] - TBD" repeats "### Added"');
  });

  test("the frozen release-branch shape passes (empty Unreleased + populated TBD section)", () => {
    expect(run(`${header}${EMPTY_UNRELEASED}${FROZEN_RELEASE}`)).toEqual({ code: 0, err: "" });
  });

  test("an empty Unreleased on its own passes", () => {
    expect(run(`${header}${EMPTY_UNRELEASED}`)).toEqual({ code: 0, err: "" });
  });

  test("the same heading in different sections is not a repeat", () => {
    expect(findRepeatedHeadings(`## [0.2.0] - TBD\n\n### Fixed\n\n## [0.1.0] - 2020-01-01\n\n### Fixed\n`)).toEqual([]);
  });

  test("headings inside a fenced code block are ignored", () => {
    expect(findRepeatedHeadings("## Unreleased\n\n### Fixed\n\n```md\n### Fixed\n```\n")).toEqual([]);
  });

  test("a missing file is a hard failure, not a pass", () => {
    const proc = Bun.spawnSync(["node", script, "/nonexistent/CHANGELOG.md"]);
    expect(proc.exitCode).not.toBe(0);
  });

  test("this repository's CHANGELOG passes", () => {
    expect(Bun.spawnSync(["node", script, repoChangelog]).exitCode).toBe(0);
  });
});
