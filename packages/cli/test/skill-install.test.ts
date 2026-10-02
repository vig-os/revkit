// Regression + acceptance test for `revkit skill install`
// (PR-56 review, blocker 3).
//
// The SKILL.md landed in `templates/skills/revkit/` before this
// change, and the install instruction it printed
// (`cp -r "$(nix flake prefetch --json github:vig-os/revkit#templates
//   | jq -r '.storePath')/skills/revkit" .claude/skills/revkit`)
// referenced a `#templates` fragment Nix does not recognise. This
// test asserts the CLI now ships a `revkit skill install` command
// that works from any cwd and idempotently writes the packaged
// SKILL.md into `.claude/skills/revkit/SKILL.md`.
//
// **RED on 1b66011e**: `revkit skill install` does not exist on the
// PR's base commit; `dispatch(["skill", "install"], ...)` returns
// exit code 2 with `unknown argument 'skill'`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { dispatch } from "../src/index.ts";
import { runSkillCommand, packagedSkillPath } from "../src/skill-cli.ts";
import { spawnGh } from "../src/gh-runner.ts";

const PACKAGED_SKILL_PATH = packagedSkillPath();

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(resolve(tmpdir(), "revkit-skill-test-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("revkit skill install", () => {
  test("packaged SKILL.md exists and starts with the yaml frontmatter", () => {
    expect(existsSync(PACKAGED_SKILL_PATH)).toBe(true);
    const src = readFileSync(PACKAGED_SKILL_PATH, "utf8");
    // A skill file MUST start with `---\nname: <slug>\n…` — a
    // packaging accident that dropped the frontmatter would render
    // the file inert on the consumer side.
    expect(src.startsWith("---\nname: revkit\n")).toBe(true);
    // The skill has to teach the whole loop; check for keyword
    // presence so a truncated packaging is caught.
    expect(src).toContain("publish");
    expect(src).toContain("threads");
    expect(src).toContain("await_answer");
  });

  test("writes .claude/skills/revkit/SKILL.md into cwd", () => {
    const outcome = runSkillCommand(["install"], { cwd: scratch });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("Installed revkit skill");
    const target = resolve(scratch, ".claude/skills/revkit/SKILL.md");
    expect(existsSync(target)).toBe(true);
    // Byte-for-byte with the packaged source.
    expect(readFileSync(target, "utf8")).toBe(readFileSync(PACKAGED_SKILL_PATH, "utf8"));
  });

  test("--dir <path> installs under a different root", () => {
    const alt = resolve(scratch, "consumer-repo");
    mkdirSync(alt, { recursive: true });
    const outcome = runSkillCommand(["install", "--dir", alt], { cwd: scratch });
    expect(outcome.exitCode).toBe(0);
    expect(existsSync(resolve(alt, ".claude/skills/revkit/SKILL.md"))).toBe(true);
    expect(existsSync(resolve(scratch, ".claude/skills/revkit/SKILL.md"))).toBe(false);
  });

  test("refuses to overwrite without --force", () => {
    // Install once.
    const first = runSkillCommand(["install"], { cwd: scratch });
    expect(first.exitCode).toBe(0);
    // Second install without --force refuses.
    const second = runSkillCommand(["install"], { cwd: scratch });
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("already exists");
  });

  test("--force overwrites AND saves a .backup-<ts> copy", () => {
    const target = resolve(scratch, ".claude/skills/revkit/SKILL.md");
    // Pre-populate with divergent content.
    mkdirSync(resolve(scratch, ".claude/skills/revkit"), { recursive: true });
    const oldContent = "# pre-existing skill\n";
    Bun.write(target, oldContent);
    // Wait a tick so the mtime differs (some FS have 1s resolution).
    const outcome = runSkillCommand(["install", "--force"], { cwd: scratch });
    expect(outcome.exitCode).toBe(0);
    // Live target is now the packaged content.
    expect(readFileSync(target, "utf8")).toBe(readFileSync(PACKAGED_SKILL_PATH, "utf8"));
    // A backup file sits next to it (name pattern only, exact
    // timestamp differs per run).
    const dir = resolve(scratch, ".claude/skills/revkit");
    const files = Bun.file; // no-op; use readdir instead.
    const list = require("node:fs").readdirSync(dir) as string[];
    const backups = list.filter((name: string) => name.startsWith("SKILL.md.backup-"));
    expect(backups.length).toBe(1);
    expect(readFileSync(resolve(dir, backups[0]!), "utf8")).toBe(oldContent);
  });

  test("--dry-run reports what WOULD happen without writing", () => {
    const outcome = runSkillCommand(["install", "--dry-run"], { cwd: scratch });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("Would write");
    expect(existsSync(resolve(scratch, ".claude/skills/revkit/SKILL.md"))).toBe(false);
  });

  test("`revkit skill install` reaches the handler via dispatch", async () => {
    const outcome = await dispatch(["skill", "install"], {
      cwd: scratch,
      gh: spawnGh,
      repoSlug: "vig-os/revkit",
    });
    expect(outcome.exitCode).toBe(0);
    expect(existsSync(resolve(scratch, ".claude/skills/revkit/SKILL.md"))).toBe(true);
  });

  test("unknown subcommand returns usage exit code", () => {
    const outcome = runSkillCommand(["nope"], { cwd: scratch });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("unknown subcommand");
  });

  test("`revkit skill` with no subcommand prints usage", () => {
    const outcome = runSkillCommand([], { cwd: scratch });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("Usage:");
  });
});
