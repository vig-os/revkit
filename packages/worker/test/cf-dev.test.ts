import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dir, "../../..");
const account = "1ecb6c28f07ad10630be568fcf73a347";
const dev = {
  account_id: account, worker_name: "revkit-review-dev",
  d1: { database_name: "revkit-review-dev", database_id: "40db8b68-108d-4198-bcfa-9d3f0718f731" },
  r2: { previews_bucket: "revkit-previews-dev" },
};
const token = "fake-cf-token-for-output-test";
const r2Key = "fake-r2-access-key";
const r2Secret = "fake-r2-secret-key";
const missingWorker = [
  'Worker "revkit-review-dev" not found.', "",
  "If this is a new Worker, run `wrangler deploy` first to create it.",
  "Otherwise, check that the Worker name is correct and you're logged into the right account.",
].join("\n");
let root: string;
let env: Record<string, string | undefined>;
const configPath = () => join(root, "packages/worker/wrangler.jsonc");
const calls = () => existsSync(join(root, "calls.jsonl"))
  ? readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) : [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "revkit-cf-test-"));
  mkdirSync(join(root, "packages/worker"), { recursive: true });
  mkdirSync(join(root, "bin"));
  cpSync(join(repo, "justfile"), join(root, "justfile"));
  cpSync(join(repo, "justfile.project"), join(root, "justfile.project"));
  cpSync(join(repo, "scripts"), join(root, "scripts"), { recursive: true });
  cpSync(join(repo, "packages/worker/wrangler.jsonc"), configPath());
  writeFileSync(join(root, "dev.json"), JSON.stringify(dev));
  writeFileSync(join(root, "cf.env"), `CLOUDFLARE_ACCOUNT_ID=${account}\nCLOUDFLARE_API_TOKEN=${token}\nAWS_ACCESS_KEY_ID=${r2Key}\nAWS_SECRET_ACCESS_KEY=${r2Secret}\n`, { mode: 0o600 });
  writeFileSync(join(root, "bin/wrangler"), `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.CF_TEST_CALLS, JSON.stringify(args) + "\\n");
if (process.env.WRANGLER_SEND_METRICS !== "false") process.exit(11);
if (!process.env.WRANGLER_LOG_PATH.endsWith(".log")) process.exit(12);
const command = args.filter((a, i) => a !== "--config" && args[i - 1] !== "--config");
if (process.env.CF_TEST_READ_STDIN) await Bun.stdin.text();
if (process.env.CF_TEST_ECHO) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  process.stdout.write(token.slice(0, 7));
  await Bun.sleep(5);
  console.log(token.slice(7));
  console.error(process.env.AWS_ACCESS_KEY_ID, process.env.AWS_SECRET_ACCESS_KEY);
  console.log("literal", command.at(-1));
  process.exit(Number(process.env.CF_TEST_EXIT || 0));
}
if (command[0] === "d1" && command[1] === "list") console.log(JSON.stringify(process.env.CF_TEST_ABSENT && !(await Bun.file(process.env.HOME + "/created").exists()) ? [] : [{name: "revkit-review-dev", uuid: "${dev.d1.database_id}"}]));
else if (command[0] === "d1" && command[1] === "create") {
  appendFileSync(process.env.HOME + "/created", "yes"); console.log("created");
}
else if (command[0] === "r2" && command[2] === "list") console.log(process.env.CF_TEST_ABSENT ? "Listing buckets..." : "name: revkit-previews-dev\\ncreation_date: today");
else if (command[0] === "d1" && command[1] === "migrations") console.log(process.env.CF_TEST_PENDING ? "Migrations to be applied:\\n0004_test.sql" : "✅ No migrations to apply!");
else if (command[0] === "secret" && command[1] === "list") {
  if (process.env.CF_TEST_MISSING_WORKER) { console.error(${JSON.stringify(missingWorker)}); process.exit(1); }
  if (process.env.CF_TEST_AUTH_FAILURE) { console.error("Authentication error"); process.exit(1); }
  console.log(JSON.stringify(process.env.CF_TEST_ABSENT ? [] : [{name: "INVITE_TOKEN_HMAC_KEY", type: "secret_text"}]));
}
else if (command[0] === "secret" && command[1] === "put") {
  const secret = (await Bun.stdin.text()).trim();
  if (!/^[a-f0-9]{64}$/.test(secret) || args.some((a) => a.includes(secret))) process.exit(7);
  console.log(secret); console.error(secret);
}
else console.log("ok");
`);
  chmodSync(join(root, "bin/wrangler"), 0o700);
  // Never let a test inherit real credential sources or an age identity.
  env = { ...process.env, HOME: root, REVKIT_CF_ENV: join(root, "cf.env"), REVKIT_CF_SOPS: "", SOPS_AGE_KEY_FILE: "",
    CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "", AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "",
    PATH: `${join(root, "bin")}:${process.env.PATH}`, REVKIT_CF_DEV_CONFIG: join(root, "dev.json"), CF_TEST_CALLS: join(root, "calls.jsonl") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function run(...args: string[]) {
  // Collect output and exit together through the child-process close callback.
  // Nothing is supplied on stdin for these non-interactive fixture commands.
  return new Promise<{ code: number; output: string }>((resolve, reject) => {
    const child = execFile("just", args, { cwd: root, env }, (error, stdout, stderr) => {
      let code = 0;
      if (error) {
        if (typeof error.code !== "number") { reject(error); return; }
        code = error.code;
      }
      resolve({ code, output: stdout + stderr });
    });
    child.stdin?.end();
  });
}

function sourceConfig() { return JSON.parse(readFileSync(configPath(), "utf8").replace(/^\s*\/\/.*$/gm, "")); }

test("dev config changes only identifiers and preserves every inherited setting", async () => {
  expect((await run("cf-dev", "d1", "migrations", "list", "revkit-review-dev", "--remote")).code).toBe(0);
  const config = JSON.parse(readFileSync(join(root, "packages/worker/wrangler.dev.jsonc"), "utf8").replace(/^\/\/.*$/gm, ""));
  const expected = sourceConfig();
  expected.name = dev.worker_name; expected.account_id = account;
  Object.assign(expected.d1_databases[0], dev.d1);
  expected.r2_buckets[0].bucket_name = dev.r2.previews_bucket;
  expect(config).toEqual(expected);
  expect(config.workers_dev).toBe(false); expect(config.compatibility_flags).toEqual([]);
  expect(config).not.toHaveProperty("routes"); expect(config).not.toHaveProperty("route");
  expect(calls()[0]).toContain("--config");
});

for (const [key, value] of [["workers_dev", true], ["routes", []], ["route", "example.invalid/*"], ["compatibility_flags", ["nodejs_compat"]]] as const) {
  test(`rejects unsafe tracked ${key} before any Wrangler call`, async () => {
    writeFileSync(configPath(), JSON.stringify({ ...sourceConfig(), [key]: value }));
    const result = await run("cf-dev", "deploy");
    expect(result.code).not.toBe(0); expect(result.output).toContain("security"); expect(calls()).toEqual([]);
  });
}

test("missing dev state fails clearly before Wrangler", async () => {
  rmSync(join(root, "dev.json"));
  const result = await run("cf-dev", "deploy");
  expect(result.code).not.toBe(0); expect(result.output).toContain("cf-dev-init"); expect(calls()).toEqual([]);
});

test("rejects other accounts and resource names in dev state and credential account", async () => {
  expect((await run("cf-dev", "whoami")).code).toBe(0);
  rmSync(join(root, "calls.jsonl"));
  for (const state of [{ ...dev, account_id: "0".repeat(32) }, { ...dev, worker_name: "production" }]) {
    writeFileSync(join(root, "dev.json"), JSON.stringify(state));
    expect((await run("cf-dev", "deploy")).code).not.toBe(0);
  }
  writeFileSync(join(root, "dev.json"), JSON.stringify(dev));
  writeFileSync(join(root, "cf.env"), `CLOUDFLARE_ACCOUNT_ID=${"0".repeat(32)}\nCLOUDFLARE_API_TOKEN=${token}\n`);
  expect((await run("cf-dev-init")).code).not.toBe(0); expect(calls()).toEqual([]);
});

test("dev config cannot be bypassed with Wrangler target overrides", async () => {
  expect((await run("cf-dev", "whoami")).code).toBe(0);
  rmSync(join(root, "calls.jsonl"));
  for (const flag of ["--config=other.json", "-c", "--env", "--name", "--cwd", "--env-file", "--account-id"]) {
    expect((await run("cf-dev", "deploy", flag, "production")).code).not.toBe(0);
  }
  expect(calls()).toEqual([]);
});

test("init preserves existing ids and secrets and applies nothing on repeated calls", async () => {
  const before = readFileSync(join(root, "dev.json"), "utf8");
  for (let i = 0; i < 2; i++) expect((await run("cf-dev-init")).code).toBe(0);
  expect(readFileSync(join(root, "dev.json"), "utf8")).toBe(before);
  expect(calls().some((args) => args.includes("create") || args.includes("put") || args.includes("apply"))).toBe(false);
});

test("init recovers existing resources without local state and applies pending migrations", async () => {
  rmSync(join(root, "dev.json")); env.CF_TEST_PENDING = "1";
  expect((await run("cf-dev-init")).code).toBe(0);
  expect(JSON.parse(readFileSync(join(root, "dev.json"), "utf8"))).toEqual(dev);
  expect(calls().some((args) => args.includes("create") || args.includes("put"))).toBe(false);
  expect(calls().some((args) => args.includes("apply") && args.includes("--remote"))).toBe(true);
});

test("init rotate generates a secret on stdin and redacts it on both output streams", async () => {
  const result = await run("cf-dev-init", "--rotate");
  expect(result.code).toBe(0); expect(result.output).toContain("[REDACTED]");
  expect(result.output).not.toMatch(/\b[a-f0-9]{64}\b/);
  expect(calls().filter((args) => args.includes("put"))).toHaveLength(1);
});

test("dev-deploy deploys the current worker through the generated config", async () => {
  expect((await run("cf-dev-deploy")).code).toBe(0);
  expect(calls()).toHaveLength(1); expect(calls()[0]).toContain("deploy");
  expect(calls()[0]).toContain(join(root, "packages/worker/wrangler.dev.jsonc"));
});

for (const recipe of ["cf", "cf-dev", "cf-dev-deploy"]) {
  test(`${recipe} redacts credentials, including split output, and preserves failure`, async () => {
    env.CF_TEST_ECHO = "1"; env.CF_TEST_EXIT = "9";
    const result = await run(recipe, ...(recipe === "cf-dev-deploy" ? [] : ["whoami"]));
    expect(result.code).not.toBe(0); expect(result.output).toContain("[REDACTED]");
    for (const secret of [token, r2Key, r2Secret]) expect(result.output).not.toContain(secret);
    expect(calls()).toHaveLength(1);
  });
}

test("cf-dev shares the plaintext mode-600 credential check", async () => {
  chmodSync(join(root, "cf.env"), 0o644);
  const result = await run("cf-dev", "whoami");
  expect(result.code).not.toBe(0); expect(result.output).toContain("600"); expect(calls()).toEqual([]);
});

test("sops takes precedence, decrypts per call, and never falls back after failure", async () => {
  env.REVKIT_CF_SOPS = join(root, "encrypted.env.sops");
  writeFileSync(env.REVKIT_CF_SOPS, "fake encrypted fixture");
  writeFileSync(join(root, "cf.env"), "must not source plaintext");
  writeFileSync(join(root, "bin/sops"), `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == exec-env ]]
[[ -L "$2" && "$(readlink "$2")" == "$REVKIT_CF_SOPS" ]]
printf 'decrypt\\n' >> "$HOME/sops-calls"
[[ -z "\${CF_TEST_SOPS_FAIL:-}" ]] || exit 8
export CLOUDFLARE_ACCOUNT_ID=${account} CLOUDFLARE_API_TOKEN=${token} AWS_ACCESS_KEY_ID=${r2Key} AWS_SECRET_ACCESS_KEY=${r2Secret}
exec bash -c "$3"
`);
  chmodSync(join(root, "bin/sops"), 0o700); env.CF_TEST_ECHO = "1";
  for (let i = 0; i < 2; i++) {
    const result = await run("cf", "whoami", "literal $(touch should-not-exist)");
    expect(result.code).toBe(0); expect(result.output).toContain("[REDACTED]");
    expect(result.output).toContain("literal $(touch should-not-exist)"); expect(result.output).not.toContain(token);
  }
  expect(existsSync(join(root, "should-not-exist"))).toBe(false);
  expect(readFileSync(join(root, "sops-calls"), "utf8").trim().split("\n")).toHaveLength(2);
  env.CF_TEST_SOPS_FAIL = "1";
  expect((await run("cf", "whoami")).code).not.toBe(0); expect(calls()).toHaveLength(2);
});


test("fresh init creates absent D1/R2 and deploys a missing Worker before piping the secret", async () => {
  rmSync(join(root, "dev.json")); env.CF_TEST_ABSENT = "1"; env.CF_TEST_MISSING_WORKER = "1";
  const result = await run("cf-dev-init");
  expect(result.code).toBe(0); expect(result.output).not.toMatch(/\b[a-f0-9]{64}\b/);
  expect(JSON.parse(readFileSync(join(root, "dev.json"), "utf8"))).toEqual(dev);
  expect(calls().filter((args) => args.includes("create"))).toHaveLength(2);
  const deploy = calls().findIndex((args) => args.includes("deploy"));
  expect(deploy).toBeGreaterThan(-1);
  expect(calls().findIndex((args) => args.includes("put"))).toBeGreaterThan(deploy);
});

test("init never treats an authentication error as an absent Worker", async () => {
  expect((await run("cf-dev-init")).code).toBe(0);
  rmSync(join(root, "calls.jsonl")); env.CF_TEST_AUTH_FAILURE = "1";
  const result = await run("cf-dev-init");
  expect(result.code).not.toBe(0); expect(result.output).toContain("Authentication error");
  expect(calls().some((args) => args.includes("deploy") || args.includes("put") || args.includes("create"))).toBe(false);
});

test("credential helper preserves blank secrets, quotes replacements and writes private files", async () => {
  const path = join(root, "cf.env");
  writeFileSync(path, `# local comment\nUNRELATED='keep me'\nCLOUDFLARE_API_TOKEN='old-fake-token'\nAWS_SECRET_ACCESS_KEY='old-fake-s3-secret'\n`);
  const replacement = "fake'\"$(touch should-not-exist)";
  const helperEnv = { ...env, CF_ENV_FILE: path, CF_ACCOUNT: account, CF_TOKEN: replacement, CF_R2_KEY: "fake-access-id", CF_R2_SEC: "" };
  const child = Bun.spawn(["bun", join(root, "scripts/cf-credentials-write.ts")], { cwd: root, env: helperEnv, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0); expect(out + err).not.toContain(replacement);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const { readdirSync } = await import("node:fs");
  const backups = readdirSync(root).filter((name) => name.startsWith("cf.env.bak."));
  expect(backups).toHaveLength(1); expect(statSync(join(root, backups[0]!)).mode & 0o777).toBe(0o600);
  expect(readFileSync(path, "utf8")).toContain("UNRELATED='keep me'");
  expect(readFileSync(path, "utf8")).toContain("AWS_SECRET_ACCESS_KEY='old-fake-s3-secret'");
  const verify = Bun.spawn(["bun", "-e", 'const {parseDotenv, dotenvValues} = await import("./scripts/cf-dotenv.ts"); const v = dotenvValues(parseDotenv(await Bun.file(process.env.REVKIT_CF_ENV).text())); if (v.CLOUDFLARE_API_TOKEN !== process.env.CF_TOKEN || v.AWS_REGION !== "auto" || v.AWS_ENDPOINT_URL_S3 !== "https://" + process.env.CF_ACCOUNT + ".r2.cloudflarestorage.com") process.exit(1);'], { cwd: root, env: helperEnv, stdout: "pipe", stderr: "pipe" });
  expect(await verify.exited).toBe(0); expect(existsSync(join(root, "should-not-exist"))).toBe(false);
});


test("real SOPS reads encrypted dotenv with .sops suffix and preserves shell-special values", async () => {
  const identity = join(root, "test-identity");
  const keygen = Bun.spawn(["age-keygen", "-o", identity], { env, stdout: "pipe", stderr: "pipe" });
  expect(await keygen.exited).toBe(0);
  const pub = Bun.spawn(["age-keygen", "-y", identity], { env, stdout: "pipe", stderr: "pipe" });
  const recipient = (await new Response(pub.stdout).text()).trim();
  expect(await pub.exited).toBe(0);
  const specialToken = "fake'\"$(touch should-not-exist)";
  writeFileSync(join(root, "cf.env"), "CLOUDFLARE_ACCOUNT_ID=placeholder\nCLOUDFLARE_API_TOKEN=placeholder\nAWS_ACCESS_KEY_ID=placeholder\nAWS_SECRET_ACCESS_KEY=placeholder\n");
  const prepare = Bun.spawn(["bun", join(root, "scripts/cf-credentials-write.ts")], {
    env: { ...env, CF_ENV_FILE: join(root, "cf.env"), CF_ACCOUNT: account, CF_TOKEN: specialToken, CF_R2_KEY: r2Key, CF_R2_SEC: r2Secret },
    stdout: "pipe", stderr: "pipe",
  });
  await Promise.all([new Response(prepare.stdout).text(), new Response(prepare.stderr).text()]);
  expect(await prepare.exited).toBe(0);
  const encryptedPath = join(root, "encrypted.env.sops");
  const encryption = Bun.spawn(["bash", "-c", 'bun scripts/cf-credentials-write.ts encrypt > "$CF_TEST_ENCRYPTED"'], {
    cwd: root, env: { ...env, CF_ENV_FILE: join(root, "cf.env"), CF_AGE_RECIPIENT: recipient,
      CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: specialToken, AWS_ACCESS_KEY_ID: r2Key, AWS_SECRET_ACCESS_KEY: r2Secret,
      CF_TEST_ENCRYPTED: encryptedPath }, stdout: "pipe", stderr: "pipe",
  });
  const error = await new Response(encryption.stderr).text();
  expect(await encryption.exited, error).toBe(0);
  env.SOPS_AGE_KEY_FILE = identity; env.REVKIT_CF_SOPS = encryptedPath; env.CF_TEST_ECHO = "1";
  rmSync(join(root, "cf.env"));
  const result = await run("cf", "whoami", "literal 'quoted'\n$(touch should-not-exist)");
  expect(result.code).toBe(0); expect(result.output).toContain("[REDACTED]");
  expect(result.output).not.toContain(specialToken); expect(result.output).not.toContain(r2Secret);
  expect(result.output).toContain("literal 'quoted'\n$(touch should-not-exist)");
  expect(existsSync(join(root, "should-not-exist"))).toBe(false);
});


test("missing API token fails before Wrangler can attempt interactive login", async () => {
  writeFileSync(join(root, "cf.env"), `CLOUDFLARE_ACCOUNT_ID=${account}\n`);
  for (const recipe of ["cf", "cf-dev", "cf-dev-init"]) {
    const result = await run(recipe, ...(recipe === "cf-dev-init" ? [] : ["whoami"]));
    expect(result.code).not.toBe(0); expect(result.output).toContain("missing local Cloudflare API token");
  }
  expect(calls()).toEqual([]);
});


// Fix-round reproductions use only the fake Wrangler installed above.
for (const [label, args] of [
  ["trailing separator", ["deploy", "--dry-run", "--"]],
  ["routes", ["deploy", "--routes", "example.invalid/*"]],
  ["domain", ["deploy", "--domain", "example.invalid"]],
  ["environment alias", ["deploy", "--e=production"]],
  ["compatibility flags", ["deploy", "--compatibility-flags", "nodejs_compat"]],
  ["camel-case env file", ["deploy", "--envFile=other.env"]],
  ["unknown command", ["queues", "list"]],
  ["unknown flag", ["deploy", "--unexpected"]],
] as const) {
  test(`r1: allowlist refuses ${label} before Wrangler`, async () => {
    const result = await run("cf-dev", ...args);
    expect(result.code).not.toBe(0); expect(result.output).toContain("not allowed"); expect(calls()).toEqual([]);
  });
}

for (const flag of ["--route", "--routes", "--domain", "--domains", "--compatibility-flag", "--compatibility-flags",
  "--compatibility-date", "--var", "--triggers", "--dispatch-namespace", "--secrets-file", "--assets",
  "--env", "--env-file", "--name", "--config", "--cwd", "--account-id", "--e", "--envFile", "-e", "-c"]) {
  test(`r1: allowlist rejects all forms of ${flag}`, async () => {
    for (const suffix of ["", "=unsafe"]) {
      const result = await run("cf-dev", "deploy", flag + suffix, ...(suffix ? [] : ["unsafe"]));
      expect(result.code).not.toBe(0); expect(result.output).toContain("not allowed");
    }
    expect(calls()).toEqual([]);
  });
}

test("r1: generated config precedes every user argument", async () => {
  expect((await run("cf-dev", "deploy", "--dry-run")).code).toBe(0);
  expect(calls()[0]?.slice(0, 2)).toEqual(["--config", join(root, "packages/worker/wrangler.dev.jsonc")]);
});

test("r1: deploy finishes even while caller stdin remains open", async () => {
  env.CF_TEST_READ_STDIN = "1";
  const child = Bun.spawn(["just", "cf-dev-deploy"], { cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = await Promise.race([child.exited.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 2500); })]);
  clearTimeout(timer);
  child.stdin.end();
  expect(await child.exited).toBe(0); await output;
  expect(finished).toBe(true);
});

for (const args of [["delete"], ["d1", "delete", "revkit-review-dev"], ["r2", "bucket", "delete", "revkit-previews-dev"],
  ["d1", "time-travel", "restore", "revkit-review-dev"], ["rollback"], ["secret", "delete", "INVITE_TOKEN_HMAC_KEY"],
  ["versions", "delete", "fake-version"]]) {
  for (const recipe of ["cf", "cf-dev"]) {
    test(`r1: ${recipe} refuses destructive ${args.join(" ")} without its own TTY confirmation`, async () => {
      for (const flags of [[], ["--yes-really"]]) {
        const result = await run(recipe, ...args, ...flags);
        expect(result.code).not.toBe(0); expect(result.output).toContain("TTY confirmation");
      }
      expect(calls()).toEqual([]);
    });
  }
}

test("r1: plaintext parsing rejects executable shell syntax without running it", async () => {
  writeFileSync(join(root, "cf.env"), readFileSync(join(root, "cf.env"), "utf8") + 'UNRELATED=$(touch "$HOME/executed")\n');
  const result = await run("cf", "whoami");
  expect(existsSync(join(root, "executed"))).toBe(false); expect(calls()).toEqual([]);
  expect(result.code).not.toBe(0); expect(result.output).toContain("line 5 (UNRELATED)");
});

test("r1: malformed plaintext reports line and key without value fragments", async () => {
  writeFileSync(join(root, "cf.env"), `CLOUDFLARE_ACCOUNT_ID=${account}\nCLOUDFLARE_API_TOKEN=FAKETOKEN_part1 FAKETOKEN_part2\n`);
  const result = await run("cf", "whoami");
  expect(result.code).not.toBe(0); expect(result.output).toContain("line 2 (CLOUDFLARE_API_TOKEN)");
  expect(result.output).not.toContain("FAKETOKEN_part1"); expect(result.output).not.toContain("FAKETOKEN_part2");
  expect(calls()).toEqual([]);
});

test("r1: credential helper retains the newest five private UTC backups", async () => {
  const path = join(root, "cf.env");
  for (let i = 0; i < 7; i++) {
    const helper = Bun.spawn(["bun", join(root, "scripts/cf-credentials-write.ts")], {
      env: { ...env, CF_ENV_FILE: path, CF_ACCOUNT: account, CF_TOKEN: `fake-generation-${i}`, CF_R2_KEY: "", CF_R2_SEC: "" },
      stdout: "pipe", stderr: "pipe",
    });
    await Promise.all([new Response(helper.stdout).text(), new Response(helper.stderr).text()]);
    expect(await helper.exited).toBe(0);
  }
  const { readdirSync } = await import("node:fs");
  const backups = readdirSync(root).filter((name) => name.startsWith("cf.env.bak.")).sort();
  expect(backups).toHaveLength(5);
  for (const [index, name] of backups.entries()) {
    expect(name).toMatch(/^cf\.env\.bak\.\d{4}-\d{2}-\d{2}T.*Z\./);
    expect(statSync(join(root, name)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, name), "utf8")).toContain(`fake-generation-${index + 1}`);
  }
});

test("r1: --file inputs are resolved from the repository root", async () => {
  expect((await run("cf-dev", "d1", "execute", "revkit-review-dev", "--remote", "--file", "fixtures/query.sql")).code).toBe(0);
  expect(calls()[0]).toContain(join(root, "fixtures/query.sql"));
});


for (const reply of ["DELETE", "cancel"]) {
  test(`r1: destructive cf command with --yes-really requires TTY response ${reply}`, async () => {
    env.CF_TEST_ECHO = "1";
    const argv = process.platform === "darwin"
      ? ["script", "-q", "/dev/null", "just", "cf", "secret", "delete", "INVITE_TOKEN_HMAC_KEY", "--yes-really"]
      : ["script", "-qefc", "just cf secret delete INVITE_TOKEN_HMAC_KEY --yes-really", "/dev/null"];
    const child = Bun.spawn(argv, { cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    let output = "";
    let answered = false;
    const read = async () => {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        output += decoder.decode(value, { stream: !done });
        if (!answered && output.includes("Type DELETE to confirm:")) {
          answered = true; child.stdin.write(reply + "\n"); child.stdin.flush();
        }
        if (done) break;
      }
    };
    await Promise.all([read(), new Response(child.stderr).text()]);
    const code = await child.exited;
    child.stdin.end();
    expect(answered).toBe(true);
    if (reply === "DELETE") {
      expect(code).toBe(0); expect(calls()).toHaveLength(1);
      expect(calls()[0]).not.toContain("--yes-really"); expect(output).toContain("[REDACTED]");
    } else { expect(code).not.toBe(0); expect(calls()).toEqual([]); }
    for (const value of [token, r2Key, r2Secret]) expect(output).not.toContain(value);
  });
}

test("r1: missing-Worker detection is pinned to the installed Wrangler source and version", async () => {
  const { dirname, resolve } = await import("node:path");
  const { realpathSync } = await import("node:fs");
  const installed = realpathSync(Bun.which("wrangler")!);
  // The Nix wrapper and npm's CLI symlink have different layouts.
  const nix = join(dirname(installed), "../lib/packages/wrangler");
  const pkg = existsSync(join(nix, "package.json")) ? nix : resolve(dirname(installed), "..");
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  const source = readFileSync(join(pkg, "wrangler-dist/cli.js"), "utf8");
  const check = Bun.spawn(["bun", "-e", 'const c = await import("./scripts/cf-wrangler-contract.ts"); const version = JSON.parse(await Bun.file(process.env.CF_TEST_PACKAGE).text()).version; if (c.WRANGLER_CONTRACT_VERSION !== version || c.missingWorkerMessage("revkit-review-dev") !== process.env.CF_TEST_MESSAGE || !c.isMissingWorker(process.env.CF_TEST_MESSAGE, "revkit-review-dev") || c.isMissingWorker("Authentication error", "revkit-review-dev")) process.exit(1);'], {
    cwd: root, env: { ...env, CF_TEST_PACKAGE: join(pkg, "package.json"), CF_TEST_MESSAGE: missingWorker }, stdout: "pipe", stderr: "pipe",
  });
  await Promise.all([new Response(check.stdout).text(), new Response(check.stderr).text()]);
  expect(await check.exited).toBe(0); expect(manifest.version).toBe("4.93.0");
  for (const line of missingWorker.split("\n").filter(Boolean).slice(1)) {
    expect(source.includes(line.replaceAll("`", "\\`")), "installed Wrangler missing-Worker wording changed").toBe(true);
  }
  expect(source.includes('Worker "${scriptName}"${args.env ?'), "installed Wrangler Worker-name template changed").toBe(true);
});
