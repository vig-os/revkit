// Mint a FRESH launch URL from a bearer-authenticated caller.
//
// A daemon's launch code is single-use (`AuthState.exchangeLaunchCode`
// marks the record spent) AND expires after `LAUNCH_CODE_TTL_MS`
// (60 s, `auth.ts`). So a spec that boots one daemon in `beforeAll`
// and then replays that daemon's *startup* launch URL from N tests
// can only ever succeed once — every later `page.goto` gets a 403
// from `handleAuthExchange`.
//
// That is exactly what issue #74 caught: `ask-page.spec.ts` replayed
// one startup URL across 11 call sites. `fullyParallel: true` hid it
// locally (each test got its own worker, and therefore its own
// `beforeAll` → its own daemon → its own code), but CI pins
// `workers: 1`, so all 11 tests shared one daemon. `retries: 2` then
// hid the 403s: a worker restart re-runs `beforeAll`, which boots a
// FRESH daemon with a fresh code, so every retry passed.
//
// The fix is to mint per navigation instead of replaying. This is
// the same `POST /-/launch-code` path `revkit mcp`'s `review_url`
// tool uses, so the specs exercise the real endpoint rather than a
// test-only back door.

/** The subset of a booted daemon context this helper needs. */
export interface LaunchMinterCtx {
  /** Daemon base URL, e.g. `http://127.0.0.1:51234`. */
  readonly url: string;
  /** Bound port — the Host header must be `127.0.0.1:<port>`. */
  readonly port: number;
  /** The agent bearer from `.revkit/serve.json`. */
  readonly agentToken: string;
}

/** Mint one single-use launch URL via `POST /-/launch-code`.
 *
 * Throws with the daemon's own body on a non-2xx so a failure names
 * the cause (`401` = wrong bearer, `421` = Host mismatch) instead of
 * surfacing later as a bare 403 on the browser navigation. */
export async function mintLaunchUrl(ctx: LaunchMinterCtx): Promise<string> {
  const response = await fetch(`${ctx.url}/-/launch-code`, {
    method: "POST",
    headers: {
      host: `127.0.0.1:${ctx.port}`,
      authorization: `Bearer ${ctx.agentToken}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(`launch mint failed: ${response.status} ${await response.text()}`);
  }
  const parsed = (await response.json()) as { launchUrl: string };
  return parsed.launchUrl;
}
