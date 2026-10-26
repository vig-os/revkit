// Review this contract when the Nix Wrangler version changes. Its installed CLI
// source is checked by a test; only this full, specific error permits bootstrap.
export const WRANGLER_CONTRACT_VERSION = "4.93.0";
export function missingWorkerMessage(name: string): string {
  return `Worker "${name}" not found.\n\nIf this is a new Worker, run \`wrangler deploy\` first to create it.\nOtherwise, check that the Worker name is correct and you're logged into the right account.`;
}
export function isMissingWorker(output: string, name: string): boolean {
  const lines = output.split("\n").map((line) => line.trim()).join("\n");
  return lines.includes(missingWorkerMessage(name));
}
