// Set up the per-run isolated state directory.
//
// PR #42 established the invariants this module preserves:
//   1. STATE_DIR lives OUTSIDE the git worktree, under `$XDG_RUNTIME_DIR`
//      (tmpfs, per-user) or `/tmp` if unset. Never inside the repo.
//   2. A `package.json` with `"name": "revkit"` roots the daemon there
//      (see `packages/cli/src/repo-root.ts:findRepoRootByPackageJson`).
//   3. `site/dist` is copied in (no symlinks — the anchor confinement
//      rejects symlinks; see `packages/cli/src/serve/confined-path.ts`).
//   4. `docs/` is copied in for the same reason.
//   5. `mcp-config.json` uses ABSOLUTE paths to `revkit mcp` because the
//      pane's cwd is STATE_DIR, not the worktree.
//   6. `settings.json` is the isolated per-run file: no hooks, no
//      statusLine, no env, no plugins, `instructionFiles: "managed-only"`,
//      `permissions.defaultMode: "dontAsk"` + a 3-entry allow list.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StateDir } from "./types.ts";

/** Body of the isolated per-run settings.json. Kept as a constant so the
 *  test suite can pin its shape — a regression that adds a hook or env
 *  block here fails the shape test. */
export const ISOLATED_SETTINGS_JSON: string = JSON.stringify(
  {
    $note:
      "Isolated per-run settings for the revkit dogfood test session. Loaded via --settings; --setting-sources '' blocks user/project/local settings from also loading. See packages/cli/src/dogfood/state.ts.",
    hooks: {},
    env: {},
    instructionFiles: "managed-only",
    permissions: {
      defaultMode: "dontAsk",
      allow: ["mcp__revkit__threads", "mcp__revkit__reply", "mcp__revkit__resolve"],
    },
  },
  null,
  2,
);

/** Materialise the state dir. Uses rsync for the two directory copies —
 *  it's already required by the harness, and mimicking `--delete` in
 *  Node would just add code without adding value. */
export function setupStateDir(opts: {
  readonly repoRoot: string;
  readonly bunBin: string;
}): StateDir {
  const base = process.env.XDG_RUNTIME_DIR ?? "/tmp";
  const stateDirPath = mkdtempSync(join(base, "revkit-dogfood-"));
  // 1. package.json with `name: "revkit"` — the daemon roots here.
  writeFileSync(
    join(stateDirPath, "package.json"),
    `${JSON.stringify({ name: "revkit", private: true, type: "module" })}\n`,
  );
  // 2. site-dist copy.
  const siteDist = join(stateDirPath, "site-dist");
  mkdirSync(siteDist, { recursive: true });
  rsyncCopy(join(opts.repoRoot, "site/dist") + "/", `${siteDist}/`);
  // 3. docs copy.
  rsyncCopy(join(opts.repoRoot, "docs") + "/", join(stateDirPath, "docs") + "/");
  // 4. mcp-config with an absolute path.
  const mcpConfigPath = join(stateDirPath, "mcp-config.json");
  writeFileSync(
    mcpConfigPath,
    `${JSON.stringify(
      {
        mcpServers: {
          revkit: {
            command: opts.bunBin,
            args: [join(opts.repoRoot, "packages/cli/bin/revkit.js"), "mcp"],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  // 5. isolated settings.json.
  const settingsPath = join(stateDirPath, "settings.json");
  writeFileSync(settingsPath, `${ISOLATED_SETTINGS_JSON}\n`);
  return {
    path: stateDirPath,
    mcpConfigPath,
    settingsPath,
    siteDist,
  };
}

/** rsync -a --delete <src> <dst>. Throws on failure. */
function rsyncCopy(src: string, dst: string): void {
  const result = spawnSync("rsync", ["-a", "--delete", src, dst], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString?.() ?? "<no stderr>";
    throw new Error(`rsync -a --delete ${src} ${dst} failed: exit ${result.status}: ${stderr}`);
  }
}
