// Injectable git runner. Split from gh-runner because git has different
// exit semantics (fatal errors on stderr, non-zero exit for missing
// paths) and because tests want to fake git without also faking gh.

/** Result of one `git` invocation, mirroring the gh shape. */
export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Callable that runs `git <args>` inside `cwd`. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>;

/** Real git runner backed by `Bun.spawn`. */
export const spawnGit: GitRunner = async (args, cwd) => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
};
