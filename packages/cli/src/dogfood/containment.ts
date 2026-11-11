// Containment check for the per-run profile-dir cleanup step.
//
// Claude Code writes a transcript and memory dir to
// `${CLAUDE_CONFIG_DIR}/projects/<slug>/` for every session, where <slug>
// is the session's cwd path with every `/` replaced by `-`. So a
// STATE_DIR of `/run/user/1004/revkit-dogfood-XYZ` maps to a project dir
// named `-run-user-1004-revkit-dogfood-XYZ`.
//
// PR #42 round-5 established the containment rule: at teardown, the
// harness may only `rm -rf` a profile dir when ALL of these hold:
//   1. resolved absolute path is under `${CLAUDE_CONFIG_DIR}/projects/`
//   2. the path contains the literal `revkit-dogfood` marker
//   3. the path ends with THIS run's STATE_DIR basename
//
// Older leftover dirs from prior runs are LEFT ALONE — deletion is a
// coordinator decision, not a background sweep.

/** Slugify a STATE_DIR into the project-dir name claude uses. */
export function projectDirSlug(stateDir: string): string {
  return stateDir.replaceAll("/", "-");
}

/** Compute the project dir path for a run. */
export function projectDirFor(claudeConfigDir: string, stateDir: string): string {
  return `${claudeConfigDir}/projects/${projectDirSlug(stateDir)}`;
}

/** Return true when it is SAFE to `rm -rf` `candidate`. Never trust a path
 *  that fails any leg of the check — deletion outside the profile root, or
 *  of a dir whose basename doesn't match THIS run, is a bug.
 *
 *  `candidate` is the exact path we intend to remove; `projectsRoot` is
 *  `${CLAUDE_CONFIG_DIR}/projects`; `runBaseName` is the last path segment
 *  of the current STATE_DIR (e.g. `revkit-dogfood-XYZ`). */
export function isSafeToRemoveProfileDir(
  candidate: string,
  projectsRoot: string,
  runBaseName: string,
): boolean {
  const rootWithSlash = projectsRoot.endsWith("/") ? projectsRoot : `${projectsRoot}/`;
  if (!candidate.startsWith(rootWithSlash)) return false;
  if (!candidate.includes("revkit-dogfood")) return false;
  if (!candidate.endsWith(runBaseName)) return false;
  return true;
}
