import { closeSync, openSync, readSync, writeSync } from "node:fs";

const destructive = (args: string[]) => args.includes("delete") || args.includes("rollback") ||
  args.some((arg, index) => arg === "restore" && args[index - 1] === "time-travel");
const confirmationRequired = () => new Error("cf: destructive command requires --yes-really and an own TTY confirmation");
export function confirmArguments(input: string[]): string[] {
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
