import { closeSync, openSync, readSync, writeSync } from "node:fs";

// Unknown verbs are mutations until explicitly reviewed. Prefixes include every
// command word, so e.g. bucket domain remove never inherits bucket list's safety.
const safeCommands = [
  ["whoami"], ["dev"], ["d1", "list"], ["d1", "info"], ["d1", "create"],
  ["d1", "migrations", "list"], ["d1", "time-travel", "info"],
  ["r2", "bucket", "list"], ["r2", "bucket", "info"], ["r2", "bucket", "create"],
  ["r2", "object", "get"], ["secret", "list"], ["versions", "list"], ["deployments", "list"],
];
const destructive = (args: string[]) => !safeCommands.some((words) => words.every((word, i) => args[i] === word)) &&
  !(args[0] === "deploy" && args.length === 2 && args[1] === "--dry-run");
const confirmationRequired = () => new Error("cf: destructive command requires --yes-really and an own TTY confirmation");
export function confirmArguments(input: string[]): string[] {
  if (input.filter((arg) => arg === "--yes-really").length > 1) throw new Error("cf: repeated --yes-really");
  const requested = input.includes("--yes-really");
  const args = input.filter((arg) => arg !== "--yes-really");
  if (!destructive(args)) {
    if (requested) throw new Error("cf: --yes-really is only for destructive commands");
    return args;
  }
  if (!requested || !process.stdin.isTTY) throw confirmationRequired();
  let tty: number;
  try { tty = openSync("/dev/tty", "r+"); } catch { throw confirmationRequired(); }
  try {
    // Ask on our own terminal, independent of Wrangler's piped output and stdin.
    writeSync(tty, "cf: Wrangler will perform a destructive operation. Type DELETE to confirm: ");
    let answer = "";
    const char = Buffer.alloc(1);
    while (readSync(tty, char, 0, 1, null) === 1 && char[0] !== 10) {
      answer += char.toString();
      if (answer.length > 32) throw new Error("cf: destructive command cancelled");
    }
    if (answer.replace(/\r$/, "") !== "DELETE") throw new Error("cf: destructive command cancelled");
  } finally { closeSync(tty); }
  return args;
}
