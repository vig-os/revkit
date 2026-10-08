import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DotenvError, dotenvValues, parseDotenv, quoteDotenv } from "./cf-dotenv.ts";

try {
  const path = process.env.CF_ENV_FILE!;
  const lines = existsSync(path) ? parseDotenv(readFileSync(path, "utf8")) : [];
  if (process.argv[2] === "encrypt") {
    const entries = Object.entries(dotenvValues(lines)).map(([name, value]) => `${name}=${value}`);
    const encrypted = Bun.spawn(["sops", "encrypt", "--age", process.env.CF_AGE_RECIPIENT!,
      "--input-type", "dotenv", "--output-type", "dotenv", "/dev/stdin"], {
      stdin: new Blob([entries.join("\n") + "\n"]), stdout: "inherit", stderr: "pipe",
    });
    // Parser errors can include input text. Suppress them rather than leak it.
    await new Response(encrypted.stderr).text();
    if (await encrypted.exited !== 0) throw new Error();
  } else {
    const account = process.env.CF_ACCOUNT!;
    const updates = Object.fromEntries(Object.entries({
      CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: process.env.CF_TOKEN,
      AWS_ACCESS_KEY_ID: process.env.CF_R2_KEY, AWS_SECRET_ACCESS_KEY: process.env.CF_R2_SEC,
      AWS_ENDPOINT_URL_S3: `https://${account}.r2.cloudflarestorage.com`, AWS_REGION: "auto",
    }).filter((entry): entry is [string, string] => Boolean(entry[1])));
    if (lines.at(-1)?.raw === "") lines.pop();
    const seen = new Set<string>();
    const out = lines.map(({ raw, key }) => {
      if (!key || !(key in updates)) return raw;
      seen.add(key); return `${key}=${quoteDotenv(updates[key]!)}`;
    });
    for (const [key, value] of Object.entries(updates)) if (!seen.has(key)) out.push(`${key}=${quoteDotenv(value)}`);
    mkdirSync(dirname(path), { recursive: true });
    const temp = mkdtempSync(join(dirname(path), ".cf-credentials-"));
    try {
      if (existsSync(path)) {
        // Unique UTC names preserve earlier generations, even for concurrent writers.
        writeFileSync(join(temp, "backup"), "", { mode: 0o600 });
        copyFileSync(path, join(temp, "backup")); chmodSync(join(temp, "backup"), 0o600);
        renameSync(join(temp, "backup"), `${path}.bak.${new Date().toISOString()}.${basename(temp)}`);
      }
      writeFileSync(join(temp, "env"), out.join("\n") + "\n", { mode: 0o600 });
      renameSync(join(temp, "env"), path);
      const prefix = basename(path) + ".bak.";
      const backups = readdirSync(dirname(path)).filter((name) => name.startsWith(prefix)).sort();
      for (const old of backups.slice(0, -5)) rmSync(join(dirname(path), old), { force: true });
    } finally { rmSync(temp, { recursive: true, force: true }); }
    process.stdout.write("cf-credentials: updated " + Object.keys(updates).sort().join(", ") + "\n");
  }
} catch (error) {
  process.stderr.write((error instanceof DotenvError ? error.message : "cf-credentials: could not update/encrypt the local credential file") + "\n");
  process.exitCode = 1;
}
