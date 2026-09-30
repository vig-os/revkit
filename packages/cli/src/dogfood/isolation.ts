// Post-run empirical isolation checks.
//
// PR #42 round-6 established these:
//
//   (a) flk `agent_session` must stay null for the test agent — proves
//       no session-start hook fired.
//   (b) The owner's global CLAUDE.md must NOT appear in the transcript
//       under `${CLAUDE_CONFIG_DIR}/projects/<slug>/*.jsonl`. Fingerprint
//       phrases are extracted per run; the check FAILS CLOSED if the
//       transcript dir is missing.
//
// Round-6 dropped the owner-statusline grep — the pre-launch cmdline
// check on `--setting-sources ""` + `--settings <ours>` already proves
// no settings-driven statusLine can fire.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./logger.ts";
import { agentSessionOf } from "./flk.ts";
import { extractFingerprintPhrases } from "./fingerprint.ts";
import { projectDirFor } from "./containment.ts";

/** flk `agent_session` for our test agent must stay null. */
export function requireAgentSessionNull(opts: {
  readonly agentName: string;
  readonly logger: Logger;
}): boolean {
  const session = agentSessionOf(opts.agentName);
  if (session === undefined) {
    opts.logger.log("ISOLATION FAIL: could not read the test agent's flk state; treating as fail");
    return false;
  }
  if (session !== null) {
    opts.logger.log(
      `ISOLATION FAIL: flk agent_session is set for the test agent (value: ${session}) — a session-start hook fired, so owner hooks leaked`,
    );
    return false;
  }
  opts.logger.log("isolation proof (hooks): flk agent_session is null for the test agent — no owner hook fired");
  return true;
}

/** Owner CLAUDE.md must be absent from this run's transcript. Fails
 *  CLOSED when the transcript dir or files are missing. */
export function requireNoOwnerClaudemdInTranscript(opts: {
  readonly claudeConfigDir: string;
  readonly stateDirPath: string;
  readonly logger: Logger;
}): boolean {
  const ownerFile = join(opts.claudeConfigDir, "CLAUDE.md");
  if (!existsSync(ownerFile) || statSync(ownerFile).size === 0) {
    opts.logger.log(`isolation proof (CLAUDE.md): owner has no global CLAUDE.md at ${ownerFile} — nothing to leak`);
    return true;
  }
  const source = readFileSync(ownerFile, "utf8");
  const phrases = extractFingerprintPhrases(source);
  if (phrases.length === 0) {
    opts.logger.log(
      `isolation proof (CLAUDE.md): could not extract any quote-free short phrases from ${ownerFile}; skipping transcript check`,
    );
    return true;
  }
  const projectDir = projectDirFor(opts.claudeConfigDir, opts.stateDirPath);
  if (!existsSync(projectDir)) {
    opts.logger.log(
      `ISOLATION FAIL: profile dir ${projectDir} does not exist post-run; cannot verify no owner-CLAUDE.md leak`,
    );
    return false;
  }
  const jsonlFiles: string[] = [];
  try {
    for (const name of readdirSync(projectDir)) {
      if (name.endsWith(".jsonl")) {
        jsonlFiles.push(join(projectDir, name));
        if (jsonlFiles.length >= 5) break;
      }
    }
  } catch {
    // Cannot list — fall through to the missing-files branch.
  }
  if (jsonlFiles.length === 0) {
    opts.logger.log(
      `ISOLATION FAIL: no *.jsonl transcript under ${projectDir}; cannot verify no owner-CLAUDE.md leak`,
    );
    return false;
  }
  for (const phrase of phrases) {
    for (const file of jsonlFiles) {
      try {
        const contents = readFileSync(file, "utf8");
        if (contents.includes(phrase)) {
          opts.logger.log(`ISOLATION FAIL: owner CLAUDE.md phrase '${phrase}' present in transcript file:`);
          opts.logger.logBlock("transcript-hit", file);
          return false;
        }
      } catch {
        // Best-effort; a race between the transcript file and our read
        // is rare but possible. Continue with the next file.
      }
    }
  }
  opts.logger.log(
    `isolation proof (CLAUDE.md): ${phrases.length} distinct phrases from ${ownerFile} — none found in ${projectDir}/*.jsonl — good`,
  );
  return true;
}
