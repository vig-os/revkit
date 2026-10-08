import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Values arrive via the environment, never argv. Bash quoting also preserves
// unrelated entries when the helper merges an existing credential file.
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
if (process.argv[2] === "encrypt") {
  try {
    const names = readFileSync(process.env.CF_ENV_FILE!, "utf8").split("\n")
      .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name));
    const entries = [...new Set(names)].map((name) => {
      const value = process.env[name];
      if (value === undefined || /[\r\n]/.test(value)) throw new Error();
      return `${name}=${value}`;
    });
    const encrypted = Bun.spawn(["sops", "encrypt", "--age", process.env.CF_AGE_RECIPIENT!,
      "--input-type", "dotenv", "--output-type", "dotenv", "/dev/stdin"], {
      stdin: new Blob([entries.join("\n") + "\n"]), stdout: "inherit", stderr: "pipe",
    });
    // Parser errors can include input text. Suppress them rather than leak it.
    await new Response(encrypted.stderr).text();
    if (await encrypted.exited !== 0) throw new Error();
  } catch { console.error("cf-credentials: could not encrypt the dotenv copy"); process.exitCode = 1; }
} else {
  try {
    const path = process.env.CF_ENV_FILE!;
    const account = process.env.CF_ACCOUNT!;
    const updates = Object.fromEntries(Object.entries({
      CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: process.env.CF_TOKEN,
      AWS_ACCESS_KEY_ID: process.env.CF_R2_KEY, AWS_SECRET_ACCESS_KEY: process.env.CF_R2_SEC,
      AWS_ENDPOINT_URL_S3: `https://${account}.r2.cloudflarestorage.com`, AWS_REGION: "auto",
    }).filter((entry): entry is [string, string] => Boolean(entry[1])));
    const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
    if (lines.at(-1) === "") lines.pop();
    const seen = new Set<string>();
    const out = lines.map((line) => {
      const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];
      if (!key || !(key in updates)) return line;
      seen.add(key); return `${key}=${quote(updates[key]!)}`;
    });
    for (const [key, value] of Object.entries(updates)) if (!seen.has(key)) out.push(`${key}=${quote(value)}`);
    mkdirSync(dirname(path), { recursive: true });
    const temp = mkdtempSync(join(dirname(path), ".cf-credentials-"));
    try {
      if (existsSync(path)) {
        // Create the backup privately before copying, even if an old backup was loose.
        writeFileSync(join(temp, "backup"), "", { mode: 0o600 });
        copyFileSync(path, join(temp, "backup")); chmodSync(join(temp, "backup"), 0o600);
        renameSync(join(temp, "backup"), path + ".bak");
      }
      writeFileSync(join(temp, "env"), out.join("\n") + "\n", { mode: 0o600 });
      renameSync(join(temp, "env"), path);
    } finally { rmSync(temp, { recursive: true, force: true }); }
    process.stdout.write("cf-credentials: updated " + Object.keys(updates).sort().join(", ") + "\n");
  } catch {
    console.error("cf-credentials: could not update the local credential file"); process.exitCode = 1;
  }
}
