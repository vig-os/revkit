// Unit test for the `event-subscriber` SSE loop.
//
// We drive it against a real, in-process daemon: subscribe to
// `/events?for=agent`, post a comment as the human, and assert the
// subscriber's `onEvent` fires with the exact event the daemon
// appended. Then simulate a hiccup by closing the subscriber and
// re-attaching with `since = lastSeen`, and assert no duplicate
// event is delivered.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Anchor } from "@revkit/review-core";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import { startEventSubscriber, type WireEvent } from "../../src/mcp/event-subscriber.ts";

const anchor: Anchor = {
  path: "docs/adr/0003.md",
  startLine: 40,
  endLine: 44,
  quote: { exact: "why 30s?", prefix: "", suffix: "" },
  revision: "b".repeat(64),
};

async function mintCookie(daemon: DaemonHandle): Promise<string> {
  const response = await fetch(daemon.launchUrl, { redirect: "manual" });
  if (response.status !== 302) throw new Error(`auth exchange: ${response.status}`);
  const raw = response.headers.get("set-cookie");
  if (raw === null) throw new Error("no set-cookie");
  const eq = raw.indexOf("=");
  const semi = raw.indexOf(";");
  return raw.slice(0, semi === -1 ? undefined : semi).trim();
}

describe("event-subscriber (SSE)", () => {
  let daemon: DaemonHandle;
  let root: string;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "revkit-sse-"));
    const dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<h1>ok</h1>");
    daemon = await startDaemon({
      dir: dist,
      repoRoot: root,
      port: 0,
      sqlitePath: ":memory:",
      version: "0.0.0-test",
      localUserId: "local-test",
      installSignalHandlers: false,
      logSink: { write: () => {} },
    });
  });
  afterEach(async () => {
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("delivers each appended event to onEvent", async () => {
    const received: WireEvent[] = [];
    const subscriber = startEventSubscriber({
      url: daemon.url,
      agentToken: daemon.agentToken,
      onEvent: (event) => {
        received.push(event);
      },
    });
    try {
      const cookie = await mintCookie(daemon);
      const created = await fetch(`${daemon.url}/api/threads`, {
        method: "POST",
        headers: {
          cookie,
          host: `127.0.0.1:${daemon.port}`,
          origin: daemon.url,
          "content-type": "application/json",
        },
        body: JSON.stringify({ anchor, body: "hello" }),
      });
      expect(created.status).toBe(201);
      // Wait for the SSE frame to reach us. A short polling loop
      // beats a fixed sleep — the test is done as soon as the event
      // arrives.
      await waitFor(() => received.length >= 1);
      const first = received[0]!;
      expect(first.kind).toBe("comment.created");
      expect(first.seq).toBeGreaterThan(0);
      // The wire event carries the same threadId/body the API returned.
      expect((first as { readonly body?: string }).body).toBe("hello");
    } finally {
      subscriber.close();
    }
  });

  test("resume via since= skips already-seen seq", async () => {
    const cookie = await mintCookie(daemon);
    // Post one event.
    const created = await fetch(`${daemon.url}/api/threads`, {
      method: "POST",
      headers: {
        cookie,
        host: `127.0.0.1:${daemon.port}`,
        origin: daemon.url,
        "content-type": "application/json",
      },
      body: JSON.stringify({ anchor, body: "one" }),
    });
    const firstSeq = ((await created.json()) as { seq: number }).seq;

    // First subscriber sees it.
    const firstBatch: WireEvent[] = [];
    const firstSub = startEventSubscriber({
      url: daemon.url,
      agentToken: daemon.agentToken,
      onEvent: (e) => {
        firstBatch.push(e);
      },
    });
    await waitFor(() => firstBatch.length >= 1);
    firstSub.close();

    // Second subscriber connects with since = firstSeq. No replay of
    // the first event — only anything new.
    const secondBatch: WireEvent[] = [];
    const secondSub = startEventSubscriber({
      url: daemon.url,
      agentToken: daemon.agentToken,
      since: firstSeq,
      onEvent: (e) => {
        secondBatch.push(e);
      },
    });
    try {
      // Post a second event.
      await fetch(`${daemon.url}/api/threads`, {
        method: "POST",
        headers: {
          cookie,
          host: `127.0.0.1:${daemon.port}`,
          origin: daemon.url,
          "content-type": "application/json",
        },
        body: JSON.stringify({ anchor, body: "two" }),
      });
      await waitFor(() => secondBatch.length >= 1);
      // Only the SECOND event should have arrived on the resume.
      expect(secondBatch.every((e) => e.seq > firstSeq)).toBe(true);
      expect(secondBatch.some((e) => (e as { body?: string }).body === "two")).toBe(true);
      expect(secondBatch.some((e) => (e as { body?: string }).body === "one")).toBe(false);
    } finally {
      secondSub.close();
    }
  });

  test("rejects a bad bearer with an error callback (auth is load-bearing)", async () => {
    const errors: Error[] = [];
    const subscriber = startEventSubscriber({
      url: daemon.url,
      agentToken: "wrong-token-" + "x".repeat(40),
      baseRetryDelayMs: 10,
      maxRetryDelayMs: 20,
      onEvent: () => {},
      onError: (e) => errors.push(e),
    });
    try {
      await waitFor(() => errors.length >= 1);
      expect(errors[0]?.message).toMatch(/401|4\d\d/);
    } finally {
      subscriber.close();
    }
  });
});

/** Poll `predicate` until it returns true, or throw after `deadlineMs`.
 * Keeps SSE-timing tests deterministic without a fixed sleep. */
async function waitFor(predicate: () => boolean, deadlineMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > deadlineMs) {
      throw new Error(`waitFor: predicate did not become true within ${deadlineMs} ms`);
    }
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}
