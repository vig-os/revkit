import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_ACCOUNT, DEV_BUCKET, DEV_WORKER, generateDevConfig, readBaseConfig, validateDevState } from "./cf-dev-config.ts";
import type { DevState } from "./cf-dev-config.ts";

const repo = join(import.meta.dir, "..");
const workerDir = join(repo, "packages/worker");
const statePath = process.env.REVKIT_CF_DEV_CONFIG || join(process.env.HOME!, ".config/revkit/dev.json");
const devConfigPath = join(workerDir, "wrangler.dev.jsonc");
const credentials = [process.env.CLOUDFLARE_API_TOKEN, process.env.AWS_ACCESS_KEY_ID, process.env.AWS_SECRET_ACCESS_KEY,
  process.env.CLOUDFLARE_API_KEY].filter((value): value is string => Boolean(value));
const redact = (text: string, secrets = credentials): string =>
  secrets.slice().sort((a, b) => b.length - a.length).reduce((out, secret) => out.replaceAll(secret, "[REDACTED]"), text);

// Wrangler writes debug logs even on successful calls. A .log symlink sends them
// to /dev/null rather than leaving credential-bearing diagnostics on disk.
const logDir = mkdtempSync(join(tmpdir(), "revkit-cf-log-"));
const logPath = join(logDir, "wrangler.log");
symlinkSync("/dev/null", logPath);
process.on("exit", () => rmSync(logDir, { recursive: true, force: true }));

async function relay(stream: ReadableStream<Uint8Array>, output: NodeJS.WriteStream, secrets: string[]): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const end = pending.lastIndexOf("\n");
    if (end >= 0) { output.write(redact(pending.slice(0, end + 1), secrets)); pending = pending.slice(end + 1); }
    if (done) { output.write(redact(pending, secrets)); break; }
  }
}
async function wrangler(args: string[], config?: string, options: { capture?: boolean; secret?: string; allowMissingWorker?: boolean } = {}): Promise<string> {
  const secrets = options.secret ? [...credentials, options.secret] : credentials;
  const child = Bun.spawn(["wrangler", ...args, ...(config ? ["--config", config] : [])], {
    cwd: config ? workerDir : repo,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: logPath,
      WRANGLER_LOG: "log", NO_COLOR: "1", CLOUDFLARE_ENV: "" },
    stdin: options.secret ? new Blob([options.secret + "\n"]) : "inherit", stdout: "pipe", stderr: "pipe",
  });
  const forwardSignal = (signal: NodeJS.Signals) => child.kill(signal);
  const onInterrupt = () => forwardSignal("SIGINT");
  const onTerminate = () => forwardSignal("SIGTERM");
  process.once("SIGINT", onInterrupt); process.once("SIGTERM", onTerminate);
  let captured = "";
  let capturedError = "";
  await Promise.all([
    options.capture ? new Response(child.stdout).text().then((text) => { captured = text; }) : relay(child.stdout, process.stdout, secrets),
    options.allowMissingWorker ? new Response(child.stderr).text().then((text) => { capturedError = text; }) : relay(child.stderr, process.stderr, secrets),
  ]);
  const code = await child.exited;
  process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onTerminate);
  if (code !== 0) {
    if (options.allowMissingWorker && capturedError.includes(`Worker "${DEV_WORKER}" not found.`)) {
      // A fresh Worker must inherit the security settings before secrets are put.
      await wrangler(["deploy"], config);
      return "[]";
    }
    if (capturedError) process.stderr.write(redact(capturedError, secrets));
    if (options.capture) process.stderr.write(redact(captured, secrets));
    throw new Error(`cf: Wrangler failed (exit ${code})`);
  }
  if (capturedError) process.stderr.write(redact(capturedError, secrets));
  return captured;
}
function readState(): DevState {
  if (!existsSync(statePath)) throw new Error("cf-dev: missing dev.json; run just cf-dev-init");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as DevState;
  validateDevState(state);
  return state;
}
async function init(rotate: boolean): Promise<void> {
  const base = readBaseConfig(join(workerDir, "wrangler.jsonc"));
  const existing = existsSync(statePath) ? readState() : undefined;
  const databases = async () => JSON.parse(await wrangler(["d1", "list", "--json"], undefined, { capture: true })) as { name: string; uuid: string }[];
  let database = (await databases()).find((item) => item.name === DEV_WORKER);
  if (!database) {
    if (existing) throw new Error("cf-dev-init: recorded D1 is absent; refusing to recreate existing dev resources");
    await wrangler(["d1", "create", DEV_WORKER, "--update-config=false"]);
    database = (await databases()).find((item) => item.name === DEV_WORKER);
    if (!database) throw new Error("cf-dev-init: created D1 not found");
  }
  if (existing && database.uuid !== existing.d1.database_id) throw new Error("cf-dev-init: recorded D1 id differs from remote; refusing to replace it");
  const buckets = await wrangler(["r2", "bucket", "list"], undefined, { capture: true });
  if (!buckets.split("\n").some((line) => /^name:\s*revkit-previews-dev\s*$/.test(line.trim()))) {
    if (existing) throw new Error("cf-dev-init: recorded R2 is absent; refusing to recreate existing dev resources");
    await wrangler(["r2", "bucket", "create", DEV_BUCKET]);
  }
  const state: DevState = existing ?? {
    account_id: DEV_ACCOUNT, worker_name: DEV_WORKER,
    d1: { database_name: DEV_WORKER, database_id: database.uuid }, r2: { previews_bucket: DEV_BUCKET },
  };
  generateDevConfig(base, state, devConfigPath);
  if (!existing) {
    mkdirSync(join(statePath, ".."), { recursive: true });
    writeFileSync(statePath + ".tmp", JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    renameSync(statePath + ".tmp", statePath);
  }
  const migrations = await wrangler(["d1", "migrations", "list", DEV_WORKER, "--remote"], devConfigPath, { capture: true });
  if (migrations.includes("No migrations to apply!")) process.stdout.write("cf-dev-init: migrations already applied; skipping\n");
  else if (migrations.includes("Migrations to be applied:")) await wrangler(["d1", "migrations", "apply", DEV_WORKER, "--remote"], devConfigPath);
  else throw new Error("cf-dev-init: unrecognized migration listing; refusing to apply");
  const secrets = JSON.parse(await wrangler(["secret", "list", "--format", "json"], devConfigPath, { capture: true, allowMissingWorker: true })) as { name: string }[];
  if (!rotate && secrets.some((secret) => secret.name === "INVITE_TOKEN_HMAC_KEY")) {
    process.stdout.write("cf-dev-init: INVITE_TOKEN_HMAC_KEY already exists; skipping (secret put overwrites; use --rotate explicitly)\n");
  } else {
    await wrangler(["secret", "put", "INVITE_TOKEN_HMAC_KEY"], devConfigPath, { secret: randomBytes(32).toString("hex") });
  }
  process.stdout.write("cf-dev-init: dev resources ready\n");
}
async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error("cf: missing local Cloudflare API token; use scripts/cf-credentials.sh");
  if (mode === "cf") { await wrangler(args); return; }
  if (process.env.CLOUDFLARE_ACCOUNT_ID !== DEV_ACCOUNT) throw new Error("cf-dev: credentials must select the authorized dev account");
  if (mode === "init") {
    if (args.length > 1 || (args.length === 1 && args[0] !== "--rotate")) throw new Error("usage: just cf-dev-init [--rotate]");
    await init(args[0] === "--rotate"); return;
  }
  if (mode !== "dev") throw new Error("cf: unknown recipe mode");
  // All calls use this config; overrides would bypass its account/security checks.
  if (args.some((arg) => /^--(?:config|cwd|env|env-file|name|account-id)(?:=|$)/.test(arg) || /^-[ce]/.test(arg))) {
    throw new Error("cf-dev: Wrangler target overrides are forbidden; use the generated dev config");
  }
  generateDevConfig(readBaseConfig(join(workerDir, "wrangler.jsonc")), readState(), devConfigPath);
  await wrangler(args, devConfigPath);
}
try { await main(); } catch (error) {
  // JSON/file errors can include source text. Only our own static errors are safe.
  const message = error instanceof Error && error.message.startsWith("cf") ? error.message : "cf: command failed; check local configuration";
  process.stderr.write(redact(message) + "\n"); process.exitCode = 1;
}
