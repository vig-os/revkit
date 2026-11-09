// `revkit skill install` — copy the packaged consumer skill into
// `.claude/skills/revkit/SKILL.md` and register `revkit mcp` in the caller's cwd.
//
// **Why a CLI command and not a documented `cp`**: the `cp -r "$(nix
// flake prefetch ...)"` line in the earlier install instructions
// referenced a nonexistent `#templates` fragment, and consumers had
// no reliable way to locate the shipped SKILL.md — the nix store
// path changes every version, so a hardcoded example broke on the
// first upgrade. A CLI subcommand papers over Nix, npm and
// standalone Bun installations equally: the shipped binary already
// knows where the packaged skill lives on its own filesystem.
//
// **Behaviour**:
//   - Writes `.claude/skills/revkit/SKILL.md` under `--dir <root>`
//     (default: cwd). The directory is created if missing.
//   - Refuses to overwrite an existing file unless `--force` is
//     passed. The prior file is written to `SKILL.md.backup-<ts>`
//     first, so an accidental overwrite still leaves the earlier
//     copy on disk.
//   - The source SKILL.md is located via `import.meta.url` — the
//     file ships under `templates/skills/revkit/` next to this
//     package's TS sources, so the same relative walk works in the
//     dev tree, in a Nix-built `bin/revkit`, and in a plain `bun
//     link` installation.
//
// **Not covered** (deliberately): a "skill update" path that merges
// local edits with a new upstream. The skill is a small, one-file
// contract; a consumer who edited it can diff by hand against the
// output of `revkit skill install --force --dry-run` — printed on
// stdout — and merge.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/** Path to the SKILL.md this build ships. The file lives at
 * `templates/skills/revkit/SKILL.md` in the source tree; `bun build`
 * copies it into the package's runtime layout, so a relative walk
 * from the caller's file works in every install shape. Exported so
 * a test can point at a scratch tree. */
export function packagedSkillPath(): string {
  // `import.meta.url` — a file:// URL. Walk two levels up
  // (`src/skill-cli.ts` → package root) then into `templates/`.
  const here = dirname(fileURLToPath(import.meta.url));
  // In the source tree: <repo>/packages/cli/src/skill-cli.ts →
  // <repo>/templates/skills/revkit/SKILL.md. Walk up 4.
  const repoRoot = resolve(here, "..", "..", "..");
  const p = resolve(repoRoot, "templates/skills/revkit/SKILL.md");
  return p;
}

export interface SkillInstallOptions {
  readonly cwd: string;
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

export interface SkillInstallResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Handle `revkit skill install`. Parses `--dir`, `--force`,
 * `--dry-run`. Writes the skill and project-local `.mcp.json` registration. */
export function runSkillCommand(
  args: readonly string[],
  env: { readonly cwd: string },
): SkillInstallResult {
  const [sub, ...rest] = args;
  if (sub === undefined) {
    return {
      stdout: "",
      stderr: usage(),
      exitCode: 2,
    };
  }
  if (sub === "install") return runSkillInstall(rest, env);
  return {
    stdout: "",
    stderr: `revkit skill: unknown subcommand '${sub}'\n${usage()}`,
    exitCode: 2,
  };
}

function usage(): string {
  return "Usage:\n  revkit skill install [--dir <root>] [--force] [--dry-run]\n";
}

function runSkillInstall(
  args: readonly string[],
  env: { readonly cwd: string },
): SkillInstallResult {
  let dir = env.cwd;
  let force = false;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dir") {
      const v = args[i + 1];
      if (v === undefined) {
        return { stdout: "", stderr: "revkit skill install: --dir needs a value\n", exitCode: 2 };
      }
      dir = resolve(env.cwd, v);
      i++;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else {
      return {
        stdout: "",
        stderr: `revkit skill install: unknown flag '${arg}'\n${usage()}`,
        exitCode: 2,
      };
    }
  }

  const src = packagedSkillPath();
  let source: string;
  try {
    source = readFileSync(src, "utf8");
  } catch {
    return {
      stdout: "",
      stderr: `revkit skill install: packaged SKILL.md not found at ${src}. Reinstall revkit.\n`,
      exitCode: 1,
    };
  }

  const targetDir = resolve(dir, ".claude/skills/revkit");
  const target = resolve(targetDir, "SKILL.md");

  const registrationPath = resolve(dir, ".mcp.json");
  const registration = { command: "revkit", args: ["mcp"] };
  let config: Record<string, unknown> = {};
  let servers: Record<string, unknown> = {};
  let priorRegistration: string | undefined;
  let replaceRegistration = false;
  try {
    if (existsSync(registrationPath)) {
      priorRegistration = readFileSync(registrationPath, "utf8");
      const parsed: unknown = JSON.parse(priorRegistration);
      if (!isObject(parsed) || (parsed.mcpServers !== undefined && !isObject(parsed.mcpServers))) {
        throw new Error("expected an object with an mcpServers object");
      }
      config = parsed;
      servers = (config.mcpServers ?? {}) as Record<string, unknown>;
      const existing = servers.revkit;
      if (existing !== undefined) {
        const matches = isObject(existing) && existing.command === registration.command &&
          JSON.stringify(existing.args) === JSON.stringify(registration.args) &&
          Object.keys(existing).every((key) => key === "command" || key === "args");
        replaceRegistration = !matches;
        if (replaceRegistration && !force) {
          return { stdout: "", stderr: `revkit skill install: ${registrationPath} revkit registration already exists. Pass --force to replace it with a backup.\n`, exitCode: 1 };
        }
      }
    }
  } catch (error) {
    return { stdout: "", stderr: `revkit skill install: cannot merge ${registrationPath}: ${(error as Error).message}\n`, exitCode: 1 };
  }
  const registrationSource = JSON.stringify({ ...config, mcpServers: { ...servers, revkit: registration } }, null, 2) + "\n";

  if (dryRun) {
    return {
      stdout: `Would write ${target} (${source.length} bytes) and merge ${registrationPath}.\n`,
      stderr: "",
      exitCode: 0,
    };
  }

  if (existsSync(target) && !force) {
    return {
      stdout: "",
      stderr:
        `revkit skill install: ${target} already exists. Pass --force to overwrite ` +
        "(the previous file is saved next to it with a `.backup-<ts>` suffix).\n",
      exitCode: 1,
    };
  }

  try {
    mkdirSync(targetDir, { recursive: true });
    if (existsSync(target)) {
      // Backup then overwrite (force mode).
      const backup = `${target}.backup-${Date.now()}`;
      const prior = readFileSync(target, "utf8");
      writeFileSync(backup, prior, "utf8");
    }
    if (replaceRegistration && priorRegistration !== undefined) {
      writeFileSync(`${registrationPath}.backup-${Date.now()}`, priorRegistration, "utf8");
    }
    writeFileSync(registrationPath, registrationSource, "utf8");
    writeFileSync(target, source, "utf8");
  } catch (error) {
    return {
      stdout: "",
      stderr: `revkit skill install: ${(error as Error).message}\n`,
      exitCode: 1,
    };
  }

  return {
    stdout: `Installed revkit skill: ${target}\nRegistered revkit mcp: ${registrationPath}\n`,
    stderr: "",
    exitCode: 0,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
