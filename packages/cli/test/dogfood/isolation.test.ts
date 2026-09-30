// PR-#58 round-2 review nits — the isolation check:
//   1. FAILs CLOSED when zero fingerprint phrases can be extracted
//      from the owner's CLAUDE.md (previously silently green).
//   2. Scans EVERY *.jsonl transcript file (previously capped at 5).
//
// Both properties are load-bearing: an empty fingerprint set would
// disable the leak detector; a cap at 5 files would let a leak in the
// 6th shard through.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireNoOwnerClaudemdInTranscript } from "../../src/dogfood/isolation.ts";
import { projectDirFor } from "../../src/dogfood/containment.ts";

interface CapturedLogger {
  readonly lines: string[];
  log: (m: string) => void;
  logBlock: (prefix: string, body: string) => void;
  file: () => undefined;
}

function makeCapturedLogger(): CapturedLogger {
  const lines: string[] = [];
  return {
    lines,
    log: (m: string) => {
      lines.push(m);
    },
    logBlock: (prefix: string, body: string) => {
      for (const line of body.split("\n")) lines.push(`${prefix}: ${line}`);
    },
    file: () => undefined,
  };
}

let sandbox: string;
let claudeConfigDir: string;
let stateDirPath: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "revkit-isolation-test-"));
  claudeConfigDir = join(sandbox, "claude");
  stateDirPath = join(sandbox, "state-dir-revkit-dogfood-abc");
  mkdirSync(claudeConfigDir, { recursive: true });
  mkdirSync(join(claudeConfigDir, "projects"), { recursive: true });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("requireNoOwnerClaudemdInTranscript — fail-closed cases", () => {
  test("FAILs when owner CLAUDE.md has zero extractable fingerprint phrases", () => {
    // A CLAUDE.md that's all headings + quoted lines — every candidate
    // line has a hostile char in the first 60 chars or is a heading.
    writeFileSync(
      join(claudeConfigDir, "CLAUDE.md"),
      [
        "# heading only",
        "# another heading",
        'this line has "quotes" in the first sixty chars so it is rejected fully',
      ].join("\n"),
    );
    const projectDir = projectDirFor(claudeConfigDir, stateDirPath);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "a.jsonl"), '{"role":"user","content":"hi"}\n');
    const logger = makeCapturedLogger();
    const ok = requireNoOwnerClaudemdInTranscript({
      claudeConfigDir,
      stateDirPath,
      logger,
    });
    expect(ok).toBe(false);
    expect(logger.lines.some((l) => l.includes("ISOLATION FAIL") && l.includes("could not extract"))).toBe(true);
  });

  test("scans EVERY *.jsonl file — a leak in the 6th shard is caught", () => {
    // Owner CLAUDE.md line that extracts to a 60-char clean phrase.
    const line = "unique dogfood isolation phrase alpha bravo charlie delta echo";
    expect(line.length).toBeGreaterThanOrEqual(60);
    const fingerprint = line.slice(0, 60);
    writeFileSync(join(claudeConfigDir, "CLAUDE.md"), `${line}\n`);
    const projectDir = projectDirFor(claudeConfigDir, stateDirPath);
    mkdirSync(projectDir, { recursive: true });
    // 5 clean shards + a 6th that contains the fingerprint phrase.
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(projectDir, `shard${i}.jsonl`), '{"role":"user","content":"clean"}\n');
    }
    writeFileSync(join(projectDir, "shard5.jsonl"), `{"role":"system","content":"${fingerprint}"}\n`);
    const logger = makeCapturedLogger();
    const ok = requireNoOwnerClaudemdInTranscript({
      claudeConfigDir,
      stateDirPath,
      logger,
    });
    expect(ok).toBe(false);
    expect(logger.lines.some((l) => l.includes("ISOLATION FAIL") && l.includes(fingerprint))).toBe(true);
  });
});

describe("requireNoOwnerClaudemdInTranscript — happy path", () => {
  test("passes when the phrase is not present in any transcript", () => {
    writeFileSync(
      join(claudeConfigDir, "CLAUDE.md"),
      "A phrase that is thirty plus characters long and safe to grep.\n",
    );
    const projectDir = projectDirFor(claudeConfigDir, stateDirPath);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "a.jsonl"), '{"role":"user","content":"unrelated"}\n');
    writeFileSync(join(projectDir, "b.jsonl"), '{"role":"assistant","content":"reply"}\n');
    const logger = makeCapturedLogger();
    const ok = requireNoOwnerClaudemdInTranscript({
      claudeConfigDir,
      stateDirPath,
      logger,
    });
    expect(ok).toBe(true);
  });
});
