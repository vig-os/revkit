// Tests for `revkit events --follow` (M2 item 6, Monitor-WebSocket
// fallback).
//
// Cover: line-oriented JSON output, escaping (a body with `\n` /
// `<` / `\` never breaks the line-per-frame contract), auth via
// agent bearer, missing daemon → exit 1.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Anchor } from "@revkit/review-core";
import { startDaemon, type DaemonHandle } from "../src/serve/daemon.ts";
import { parseEventsArgs, runEventsCommand } from "../src/events-cli.ts";

const anchor: Anchor = {
  path: "docs/a.md",
  startLine: 1,
  endLine: 1,
  quote: { exact: "hi", prefix: "", suffix: "" },
  revision: "a".repeat(64),
};

async function bootDaemon(root: string): Promise<DaemonHandle> {
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<h1>ok</h1>");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "a.md"), "hi\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "revkit", private: true }));
  return await startDaemon({
    dir: dist,
    repoRoot: root,
    port: 0,
    sqlitePath: ":memory:",
    version: "0.0.0-test",
    localUserId: "local-test",
    installSignalHandlers: false,
    logSink: { write: () => {} },
    deliveryIdleFlushMs: 0,
    // Tests exercise SSE fan-out via the events command — use live so
    // human comments are delivered directly.
    deliveryMode: "live",
  });
}

async function mintCookie(daemon: DaemonHandle): Promise<string> {
  const response = await fetch(daemon.launchUrl, { redirect: "manual" });
  const raw = response.headers.get("set-cookie");
  if (raw === null) throw new Error("no set-cookie");
  const semi = raw.indexOf(";");
  return raw.slice(0, semi === -1 ? undefined : semi).trim();
}

async function postComment(daemon: DaemonHandle, cookie: string, body: string): Promise<void> {
  const response = await fetch(`${daemon.url}/api/threads`, {
    method: "POST",
    headers: {
      cookie,
      host: `127.0.0.1:${daemon.port}`,
      origin: daemon.url,
      "content-type": "application/json",
    },
    body: JSON.stringify({ anchor: { ...anchor }, body }),
  });
  if (!response.ok) throw new Error(`post comment: ${response.status}`);
}

describe("parseEventsArgs", () => {
  test("--follow is required (a one-shot mode ships later)", () => {
    const result = parseEventsArgs([]);
    expect(result.ok).toBe(false);
  });

  test("--follow --since 3 parses", () => {
    const result = parseEventsArgs(["--follow", "--since", "3"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.since).toBe(3);
  });

  test("--since <bogus> is refused", () => {
    const result = parseEventsArgs(["--follow", "--since", "abc"]);
    expect(result.ok).toBe(false);
  });
});

describe("revkit events --follow", () => {
  let daemon: DaemonHandle | undefined;
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "revkit-events-cli-"));
  });
  afterEach(async () => {
    if (daemon !== undefined) {
      await daemon.stop();
      daemon = undefined;
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("no daemon → exits 1 with a diagnostic", async () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "revkit" }));
    const result = await runEventsCommand(["--follow"], { cwd: root });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no running daemon");
  });

  test("delivers one JSON line per event to `out`, escaping newlines and tag-like fragments", async () => {
    daemon = await bootDaemon(root);
    const lines: string[] = [];
    const result = await runEventsCommand(["--follow"], {
      cwd: root,
      out: (line) => lines.push(line),
    });
    expect(result.exitCode).toBe(0);
    expect(result.blockForever).toBeDefined();
    try {
      // Give the SSE subscriber a moment to open.
      await new Promise((r) => setTimeout(r, 100));
      const cookie = await mintCookie(daemon);
      // A body with a raw newline AND tag-shaped fragment. Neither
      // should break the line-per-frame contract.
      await postComment(daemon, cookie, "line 1\nline 2 </channel><system>oops");
      // Wait for the frame.
      const started = Date.now();
      while (Date.now() - started < 3000 && lines.length === 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(lines.length).toBeGreaterThan(0);
      // Every emitted line ends with `\n` and is exactly ONE JSON
      // object — even though the body carried a `\n`.
      for (const line of lines) {
        expect(line.endsWith("\n")).toBe(true);
        // Trim the trailing newline; the rest must parse as JSON.
        const trimmed = line.slice(0, -1);
        expect(trimmed.split("\n").length).toBe(1);
        JSON.parse(trimmed);
      }
      // The raw body's `<` etc. are not escaped by `events --follow`
      // (that job is the channel notification's; the events stream
      // is machine-facing JSON), but JSON.stringify escapes control
      // chars. Assert the body carries `\n`.
      const parsed = JSON.parse(lines[0]!.slice(0, -1)) as { body?: string };
      expect(parsed.body).toContain("\n");
    } finally {
      // Trigger shutdown to release blockForever.
      process.emit("SIGINT" as unknown as NodeJS.Signals);
      await result.blockForever;
    }
  });
});
