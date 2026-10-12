import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { DEV_BUCKET, DEV_WORKER } from "./cf-dev-config.ts";

type Flag = "switch" | "file" | "port" | "format";
interface Command {
  words: string[];
  arguments: ((value: string) => boolean)[];
  flags: Record<string, Flag>;
}
const database = (value: string) => value === DEV_WORKER || value === "DB";
const bucket = (value: string) => value === DEV_BUCKET;
const object = (value: string) => value.startsWith(DEV_BUCKET + "/") && value.length > DEV_BUCKET.length + 1;
// Enumerate the dev workflow, including safe local inspection. No abbreviation,
// camel-case alias or implicit global Wrangler flag is accepted.
const commands: Command[] = [
  { words: ["whoami"], arguments: [], flags: {} },
  { words: ["deploy"], arguments: [], flags: { "--dry-run": "switch" } },
  { words: ["dev"], arguments: [], flags: { "--remote": "switch", "--port": "port" } },
  { words: ["d1", "list"], arguments: [], flags: { "--json": "switch" } },
  { words: ["d1", "info"], arguments: [database], flags: { "--json": "switch" } },
  { words: ["d1", "migrations", "list"], arguments: [database], flags: { "--remote": "switch" } },
  { words: ["d1", "migrations", "apply"], arguments: [database], flags: { "--remote": "switch" } },
  { words: ["d1", "execute"], arguments: [database], flags: { "--remote": "switch", "--file": "file", "--json": "switch" } },
  { words: ["r2", "bucket", "list"], arguments: [], flags: {} },
  { words: ["r2", "bucket", "info"], arguments: [bucket], flags: { "--json": "switch" } },
  { words: ["r2", "object", "get"], arguments: [object], flags: { "--file": "file", "--remote": "switch" } },
  { words: ["r2", "object", "put"], arguments: [object], flags: { "--file": "file", "--remote": "switch" } },
  { words: ["secret", "list"], arguments: [], flags: { "--format": "format" } },
  { words: ["versions", "list"], arguments: [], flags: {} },
  { words: ["deployments", "list"], arguments: [], flags: {} },
];
const refused = () => new Error("cf-dev: command or argument not allowed by the dev workflow; see docs/cloudflare-dev.md");
function inside(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !rel.startsWith(sep));
}
export function fileArgument(repo: string, value: string): string {
  const path = resolve(repo, value);
  let ancestor = path;
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw refused();
    ancestor = parent;
  }
  const resolved = resolve(realpathSync(ancestor), relative(ancestor, path));
  const credentials = resolve(process.env.HOME!, ".config/revkit");
  if (!inside(path, repo) || !inside(resolved, realpathSync(repo)) || inside(path, credentials) ||
      inside(resolved, existsSync(credentials) ? realpathSync(credentials) : credentials)) throw refused();
  return path;
}
export function devArguments(args: string[], repo: string): string[] {
  if (args.includes("--")) throw refused();
  const command = commands.find((candidate) => candidate.words.every((word, i) => args[i] === word));
  if (!command) throw refused();
  const result = [...command.words];
  let positional = 0;
  const seen = new Set<string>();
  for (let i = command.words.length; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) {
      if (!command.arguments[positional]?.(arg)) throw refused();
      result.push(arg); positional++; continue;
    }
    const equals = arg.indexOf("=");
    const name = equals < 0 ? arg : arg.slice(0, equals);
    const flag = Object.hasOwn(command.flags, name) ? command.flags[name] : undefined;
    if (!flag || seen.has(name)) throw refused();
    seen.add(name);
    if (flag === "switch") {
      if (equals >= 0) throw refused();
      result.push(name); continue;
    }
    const value = equals < 0 ? args[++i] : arg.slice(equals + 1);
    if (!value || value.startsWith("-")) throw refused();
    if (flag === "port" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) throw refused();
    if (flag === "format" && value !== "json" && value !== "pretty") throw refused();
    result.push(name, flag === "file" ? fileArgument(repo, value) : value);
  }
  if (positional !== command.arguments.length) throw refused();
  return result;
}
