// ADR-0025's runtime gate (A1, A2, A4) plus the Worker's HTTP surface.
//
// Three runtimes, one answer:
//
//   A1 — the REAL Worker, built from `src/index.ts`, answers `GET /healthz`
//        inside workerd with `compatibility_flags: []`. No `nodejs_compat`,
//        so "the core runs on the workers runtime" is enforced by the
//        platform, not by a lint.
//   A2 — `revisionOf` evaluated INSIDE workerd returns a pinned literal.
//        Pinning the literal is the point: `Anchor.revision` is what the
//        whole re-anchoring pipeline trusts, so cross-runtime determinism
//        has to be a regression test, not a claim.
//   A4 — the built bundle contains no `require(`, no `node:`, no `bun:`,
//        no `Buffer`, no `process.env`. This complements review-core's
//        `src-imports.test.ts`, which guards the core's SOURCES; this
//        guards the shipped ARTIFACT, including its dependencies.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { revisionOf } from "@revkit/review-core";
import { probeBundle, startWorker, workerBundle, type Harness } from "./harness.ts";

/** ADR-0006's acceptance: the revision id is the SHA-256 of the source
 * normalised to LF line endings. This literal was computed on a third
 * runtime during the M4 spike; matching it here means three independent
 * runtimes agree, and a change to the normalisation is caught here rather
 * than by a reviewer noticing that every existing thread re-anchors. */
const PINNED_REVISION = "2751a3a2f303ad21752038085e2b8c5f98ecff61a2e4ebbd43506a941725be80";

describe("ADR-0025 runtime gate", () => {
  let harness: Harness;
  let probe: Harness;

  beforeAll(async () => {
    // Sequential on purpose: both bundles are built before either
    // miniflare starts, so the two `Bun.build` calls never overlap.
    const workerScript = await workerBundle();
    const probeScript = await probeBundle();
    harness = await startWorker({ script: workerScript });
    probe = await startWorker({ script: probeScript });
  });

  afterAll(async () => {
    await harness.dispose();
    await probe.dispose();
  });

  // ── A1 ───────────────────────────────────────────────────────────────
  test("A1: the real Worker answers GET /healthz 200 with ok:true", async () => {
    const response = await harness.dispatch("http://localhost/healthz");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; revkitVersion: string; requestId: string };
    expect(body.ok).toBe(true);
    // The version the Worker RUNS, not the repo's current CLI version:
    // a deployed Worker is pinned to the release it was deployed as.
    expect(body.revkitVersion).toBe("0.0.0");
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("A1: HEAD /healthz is the same handler without a body", async () => {
    const response = await harness.dispatch("http://localhost/healthz", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  test("A1: workerd really has no Node globals, so the flag-free claim is enforced", async () => {
    const body = (await (await probe.dispatch("http://localhost/globals")).json()) as Record<string, string>;
    // Measured from INSIDE the runtime, not asserted from a comment.
    expect(body["buffer"]).toBe("undefined");
    expect(body["process"]).toBe("undefined");
    expect(body["require"]).toBe("undefined");
    // And the two host globals the core DOES use are present natively,
    // which is why `revisionOf` works here at all.
    expect(body["cryptoRandomUUID"]).toBe("function");
    expect(body["textEncoder"]).toBe("function");
  });

  // ── A2 ───────────────────────────────────────────────────────────────
  test("A2: revisionOf evaluated INSIDE workerd equals the pinned digest", async () => {
    const body = (await (await probe.dispatch("http://localhost/revision")).json()) as { revision: string };
    expect(body.revision).toBe(PINNED_REVISION);
  });

  test("A2: the same input hashes identically in Bun — the third runtime agrees", async () => {
    expect(await revisionOf("line1\r\nline2\n")).toBe(PINNED_REVISION);
  });

  test("A2: the hosted store round trip runs inside workerd", async () => {
    // D1 append -> exportArchive -> import into a fresh in-memory store ->
    // threads(). That is `revkit threads export|import` in the Worker, and
    // it proves the Worker's OWN `d1-store.ts` executes on the runtime.
    const body = (await (await probe.dispatch("http://localhost/store")).json()) as {
      seq: number;
      archived: number;
      threads: number;
      status: string;
      startLine: number | null;
    };
    expect(body.seq).toBe(1);
    expect(body.archived).toBe(1);
    expect(body.threads).toBe(1);
    expect(body.status).toBe("open");
    expect(body.startLine).toBe(2);
  });

  // ── A4 ───────────────────────────────────────────────────────────────
  test("A4: the built Worker bundle has no Node or Bun escape hatches", async () => {
    const bundle = await workerBundle();
    // Guard against the test silently passing on an empty or tiny string.
    expect(bundle.length).toBeGreaterThan(100_000);
    for (const [pattern, what] of [
      [/require\s*\(/, "require("],
      [/node:/, "node:"],
      [/bun:/, "bun:"],
      [/\bBuffer\b/, "Buffer"],
      [/process\.env/, "process.env"],
    ] as const) {
      const hit = pattern.exec(bundle);
      expect(
        hit === null,
        `the bundle contains ${what} at offset ${hit?.index ?? -1}: …${bundle.slice(
          Math.max(0, (hit?.index ?? 0) - 60),
          (hit?.index ?? 0) + 60,
        )}…`,
      ).toBe(true);
    }
  });

  test("A4: the bundle carries no specifier left for the platform to resolve", async () => {
    const bundle = await workerBundle();
    // Bun inlines the whole graph, so a correct bundle has ZERO import
    // specifiers. A bare one would mean a dependency escaped bundling and
    // would fail at first import in production; a relative one would mean
    // the bundle is not self-contained. Either is a packaging defect, so
    // the assertion is "none of any kind" rather than "all relative".
    const specifiers = [
      ...[...bundle.matchAll(/from\s*"([^"]+)"/g)].map((m) => m[1] ?? ""),
      ...[...bundle.matchAll(/import\s*"([^"]+)"/g)].map((m) => m[1] ?? ""),
      ...[...bundle.matchAll(/import\s*\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1] ?? ""),
    ];
    expect(specifiers).toEqual([]);
  });

  // ── the HTTP surface ─────────────────────────────────────────────────
  test("GET /api/threads returns the thread projection with a head", async () => {
    await harness.db.prepare("DELETE FROM events").run();
    const empty = (await (await harness.dispatch("http://localhost/api/threads")).json()) as {
      head: number;
      threads: unknown[];
    };
    expect(empty).toEqual({ head: 0, threads: [] });
  });

  test("GET /api/threads?since=n returns the LOG since n, ascending", async () => {
    await harness.db.prepare("DELETE FROM events").run();
    for (const seq of [1, 2, 3]) {
      await harness.db
        .prepare("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)")
        .bind(
          seq,
          `2026-10-03T12:00:0${seq}Z`,
          JSON.stringify({
            seq,
            ts: `2026-10-03T12:00:0${seq}Z`,
            actor: { kind: "gh-user", id: "gerchowl" },
            kind: "comment.created",
            threadId: `th-http-${seq}`,
            commentId: `c-http-${seq}`,
            anchor: {
              path: "docs/a.mdx",
              startLine: 1,
              endLine: 1,
              quote: { exact: "x", prefix: "", suffix: "" },
              revision: "b".repeat(64),
            },
            body: "http",
          }),
        )
        .run();
    }
    const body = (await (await harness.dispatch("http://localhost/api/threads?since=1")).json()) as {
      head: number;
      events: { seq: number }[];
    };
    expect(body.events.map((e) => e.seq)).toEqual([2, 3]);
    const bad = await harness.dispatch("http://localhost/api/threads?since=-1");
    expect(bad.status).toBe(400);
  });

  test("POST /api/threads is 501 and names the slice that enables it", async () => {
    // ADR-0012 requires a per-session CSRF token on every state-changing
    // call. Slice 1 has no session, so the endpoint does not exist yet —
    // see the module header. This asserts the refusal is a real 501 with a
    // pointer, not an accidental 404 or a 200 that would hide it.
    const response = await harness.dispatch("http://localhost/api/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "comment.created" }),
    });
    expect(response.status).toBe(501);
    const body = (await response.json()) as { error: string; enabledIn: string; detail: string };
    expect(body.error).toBe("not-implemented");
    expect(body.enabledIn).toContain("M4 slice 2");
    expect(body.detail).toContain("ADR-0012");
    // And nothing was written.
    const counted = await harness.db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    expect(counted?.n).toBe(3);
  });

  test("PUT /api/threads is 405, not 501 — the verb is wrong, not the feature", async () => {
    const response = await harness.dispatch("http://localhost/api/threads", { method: "PUT" });
    expect(response.status).toBe(405);
  });

  test("an unknown path is 404 and /_revkit/ never redirects (ADR-0012)", async () => {
    const unknown = await harness.dispatch("http://localhost/nope");
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("location")).toBeNull();
    // A stored page that tries to load a bundle from the revkit-owned
    // path must not be redirected: a browser drops the path part of a CSP
    // source after a redirect, which would widen script-src.
    const bundle = await harness.dispatch("http://localhost/_revkit/0.0.0/rail.js");
    expect(bundle.status).toBe(404);
    expect(bundle.headers.get("location")).toBeNull();
  });

  test("a recognised preview path is 501 naming slice 5, not a silent 404", async () => {
    const response = await harness.dispatch("http://localhost/revkit/pr-7/index.html");
    expect(response.status).toBe(501);
    const body = (await response.json()) as { enabledIn: string };
    expect(body.enabledIn).toContain("slice 5");
  });

  test("every response carries the request id in a header, on every status", async () => {
    for (const [path, method] of [
      ["/healthz", "GET"],
      ["/nope", "GET"],
      ["/api/threads", "POST"],
      ["/_revkit/0.0.0/x.js", "GET"],
      ["/revkit/pr-1/", "GET"],
    ] as const) {
      const response = await harness.dispatch(`http://localhost${path}`, { method });
      expect(response.headers.get("x-revkit-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  test("a 500 still carries ADR-0012 hygiene headers and the request id", async () => {
    // Force the catch path by dropping the events table out from under the
    // handler — the one failure a hosted Worker really will hit (a
    // migration not yet applied).
    await harness.db.prepare("DROP TABLE IF EXISTS temp_probe").run();
    await harness.db.prepare("ALTER TABLE events RENAME TO events_moved").run();
    try {
      const response = await harness.dispatch("http://localhost/api/threads");
      expect(response.status).toBe(500);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(response.headers.get("permissions-policy")).toContain("camera=()");
      expect(response.headers.get("x-revkit-request-id")).toMatch(/^[0-9a-f-]{36}$/);
      // The body stays generic: an error string can carry a SQL fragment.
      expect(await response.text()).toBe("internal error\n");
    } finally {
      await harness.db.prepare("ALTER TABLE events_moved RENAME TO events").run();
    }
  });
});
