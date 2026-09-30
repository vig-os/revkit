// Injectable `gh` runner — the seam every command that would call the
// GitHub CLI goes through, so unit tests exercise argument construction
// without a network call and without shelling out (DESIGN-0001 §4
// escalation; ADR-0005).
//
// The default runner uses `Bun.spawn` so failures surface as stderr in
// the diagnostic message. Tests inject a fake that records the argv and
// returns a canned response.

/** Result of one `gh` invocation. `stdout` is UTF-8 text (issue JSON, an
 * issue number, whatever the command prints); `exitCode` follows gh's own
 * convention (0 = success, 1 = command-level failure, 4 = auth). */
export interface GhResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** A callable that runs `gh <args>` and returns the streams. Rules and
 * commands accept this so a test can hand them a pure fake and check what
 * would have been sent. */
export type GhRunner = (args: readonly string[]) => Promise<GhResult>;

/** Real `gh` runner backed by `Bun.spawn`. Kept out of unit tests so no
 * check accidentally hits GitHub. */
export const spawnGh: GhRunner = async (args) => {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
};
