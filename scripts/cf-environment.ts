// The credential file is trusted data; the caller's transport/target overrides are not.
export const credentialNames = new Set([
  "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL_S3", "AWS_REGION",
]);
export function checkEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if ((/^(WRANGLER_|CLOUDFLARE_)/.test(name) && !credentialNames.has(name)) || /_PROXY$/i.test(name)) {
      throw new Error(`cf: forbidden environment variable ${name}`);
    }
  }
}
export function wranglerEnvironment(env: NodeJS.ProcessEnv, logPath: string): Record<string, string> {
  checkEnvironment(env);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && (credentialNames.has(name) ||
        ["PATH", "HOME", "TMPDIR", "LANG", "NO_COLOR"].includes(name) || /^LC_[A-Z_]+$/.test(name))) result[name] = value;
  }
  return { ...result, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: logPath,
    WRANGLER_LOG: "log", CLOUDFLARE_ENV: "" };
}
if (import.meta.main) {
  try { checkEnvironment(process.env); } catch (error) {
    process.stderr.write((error as Error).message + "\n"); process.exitCode = 1;
  }
}
