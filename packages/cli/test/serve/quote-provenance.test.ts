// Salvages #124's source/refusal and #126 cases, using actual HTML DOM
// text nodes instead of tag-stripping regexes or a Markdown projection.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { revisionOf, isLineAnchor, type Anchor } from "@revkit/review-core";
import { SqliteThreadStore } from "../../src/serve/sqlite-store.ts";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import { startReanchorDaemon } from "../../src/serve/reanchor-daemon.ts";
import { EventBus } from "../../src/serve/event-bus.ts";
import { makeLogger } from "../../src/serve/logger.ts";
import { renderProvenance, recoverLegacyAnchor, selectionAnchor, type RenderedProvenance } from "../../src/serve/source-provenance.ts";

const PATH = "docs/probe.md";
const roots: string[] = [];
const daemons: DaemonHandle[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function rootWith(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "revkit-provenance-"));
  roots.push(root);
  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, PATH), source);
  writeFileSync(join(root, "dist/index.html"), "<main>fixture</main>");
  return root;
}

export function endpoints(rendered: RenderedProvenance, needle: string, occurrence = 0): { start: { leaf: string; offset: number }; end: { leaf: string; offset: number } } {
  const block = rendered.document.querySelector("[data-src]")!;
  const nodes: Text[] = [];
  const walk = (node: Node): void => { if (node.nodeType === 3) nodes.push(node as Text); for (const child of node.childNodes) walk(child); };
  walk(block);
  const text = nodes.map((n) => n.data).join("");
  let at = -1;
  for (let i = 0; i <= occurrence; i++) at = text.indexOf(needle, at + 1);
  if (at < 0) throw new Error(`Renderer does not contain ${JSON.stringify(needle)}: ${JSON.stringify(text)}`);
  let length = 0;
  let start: { leaf: string; offset: number } | undefined;
  let end: { leaf: string; offset: number } | undefined;
  for (const node of nodes) {
    const leaf = node.parentElement?.closest("[data-revkit-leaf]")?.getAttribute("data-revkit-leaf") ?? "unmapped";
    if (at >= length && at < length + node.length) start = { leaf, offset: at - length };
    if (at + needle.length > length && at + needle.length <= length + node.length) end = { leaf, offset: at + needle.length - length };
    length += node.length;
  }
  return { start: start!, end: end! };
}

async function setup(source: string, durable = false) {
  const root = rootWith(source);
  const sqlitePath = durable ? join(root, "test.sqlite") : ":memory:";
  const daemon = await startDaemon({ dir: join(root, "dist"), repoRoot: root, port: 0, sqlitePath, version: "0.0.0-test", localUserId: "u", installSignalHandlers: false, logSink: { write: () => {} } });
  daemons.push(daemon);
  const launch = await fetch(daemon.launchUrl, { redirect: "manual" });
  const cookie = launch.headers.get("set-cookie")!.split(";")[0]!;
  const revision = await revisionOf(source);
  const rendered = await renderProvenance(root, PATH, source);
  const post = (selection: unknown, quote?: Anchor["quote"], lines = [1, source.replace(/\r\n?/g, "\n").split("\n").length]) => fetch(`${daemon.url}/api/threads`, {
    method: "POST", headers: { cookie, origin: daemon.url, "content-type": "application/json" },
    body: JSON.stringify({ anchor: { path: PATH, startLine: lines[0], endLine: lines[1], revision, ...(quote ? { quote } : {}) }, selection, body: "Review this selection" }),
  });
  return { root, daemon, cookie, revision, rendered, post, sqlitePath };
}

for (const forgery of ["other-file", "other-revision", "beyond-length", "reversed", "stale-version"] as const) test(`crafted ${forgery} endpoints are refused before events or snapshots`, async () => {
  const source = "same **words** here";
  const env = await setup(source, true);
  let range = endpoints(env.rendered, "words");
  if (forgery === "other-file") range = endpoints(await renderProvenance(env.root, "docs/other.md", source), "words");
  if (forgery === "other-revision") range = endpoints(await renderProvenance(env.root, PATH, source.replace("same", "some")), "words");
  if (forgery === "beyond-length") range = { ...range, end: { ...range.end, offset: 6 } };
  if (forgery === "reversed") range = { start: range.end, end: range.start };
  const response = await env.post({ kind: "range", version: forgery === "stale-version" ? 0 : 1, revision: env.revision, ...range });
  expect(response.status).toBe(400);
  const observer = SqliteThreadStore.open({ filename: env.sqlitePath });
  try {
    expect(observer.head()).toBe(0);
    expect(await observer.threads()).toHaveLength(0);
    expect(observer.getSnapshot(env.revision)).toBeUndefined();
  } finally { observer.close(); }
});

test("endpoint requests store source quote, lines and context; hostile rendered quote is ignored", async () => {
  const source = '🎉 first &quot;hi&quot; -- now...... and `**kwargs` here';
  const env = await setup(source);
  const range = endpoints(env.rendered, '“hi” — now… and **kwargs');
  const response = await env.post({ kind: "range", version: 1, revision: env.revision, ...range }, { exact: "HOSTILE client text", prefix: "", suffix: "" });
  expect(response.status).toBe(201);
  const { event } = await response.json() as { event: { anchor: Anchor } };
  const exact = '&quot;hi&quot; -- now...... and `**kwargs';
  expect(event.anchor.quote.exact).toBe(exact);
  expect(event.anchor.quote.prefix).toBe("🎉 first ");
  expect(event.anchor.quote.suffix).toBe("` here");
  expect(event.anchor.startLine).toBe(1);
  expect(event.anchor.endLine).toBe(1);
  expect(event.anchor.revision).toBe(await revisionOf(source));
});

test("repeated phrases choose the selected second copy, including entity/escape copies", async () => {
  const source = "foo\\_bar + foo_bar + A &amp; B + A & B";
  const env = await setup(source);
  for (const [needle, expectedPrefix] of [["foo_bar", "foo\\_bar + "], ["A & B", "foo\\_bar + foo_bar + A &amp; B + "]] as const) {
    const response = await env.post({ kind: "range", version: 1, revision: env.revision, ...endpoints(env.rendered, needle, 1) });
    expect(response.status, await response.clone().text()).toBe(201);
    const { event } = await response.json() as { event: { anchor: Anchor } };
    expect(event.anchor.quote.exact).toBe(needle);
    expect(event.anchor.quote.prefix).toBe(expectedPrefix.slice(-32));
  }
});

test("stale revision, unknown leaf, invalid offsets, reversed range and forged map are refused without writes", async () => {
  const env = await setup("alpha **beta** gamma");
  const range = endpoints(env.rendered, "alpha beta gamma");
  const valid = { kind: "range", version: 1, revision: env.revision, ...range };
  for (const selection of [
    { ...valid, revision: "0".repeat(64) }, { ...valid, version: 2 },
    { ...valid, start: { leaf: "unknown", offset: 0 } },
    { ...valid, start: { ...range.start, offset: -1 } },
    { ...valid, end: { ...range.end, offset: 1000 } },
    { ...valid, end: range.start, start: range.end },
    { ...valid, map: { start: 0, end: 9999 } },
  ]) expect((await env.post(selection)).status).toBe(400);
  expect((await env.post(valid, undefined, [40, 41])).status).toBe(400);
  writeFileSync(join(env.root, PATH), "a different current paragraph");
  expect((await env.post(valid)).status).toBe(400);
  const response = await fetch(`${env.daemon.url}/api/threads`, { headers: { cookie: env.cookie, origin: env.daemon.url } });
  const result = await response.json() as { threads: unknown[]; head: number };
  expect(result.threads).toHaveLength(0);
  expect(result.head).toBe(0);
});

test("math/generated content between mapped endpoints is refused; explicit whole-block succeeds", async () => {
  const env = await setup("before $x^2$ after");
  const response = await env.post({ kind: "range", version: 1, revision: env.revision, ...endpoints(env.rendered, env.rendered.document.querySelector("p")!.textContent!) });
  expect(response.status).toBe(400);
  const whole = await env.post({ kind: "block", version: 1, revision: env.revision });
  expect(whole.status).toBe(201);
  const { event } = await whole.json() as { event: { anchor: Anchor } };
  expect(event.anchor.quote.exact).toBe("before $x^2$ after");
});

test("authored block stamps and collapsed endpoints inside an entity are not authority", async () => {
  const source = "x &NotEqualTilde; y";
  const revision = await revisionOf(source);
  const rendered = await renderProvenance("/repo", PATH, source);
  const forged = rendered.document.createElement("p");
  forged.setAttribute("data-src", `${PATH}:40-40`);
  forged.textContent = "forged";
  rendered.document.body.append(forged);
  expect(selectionAnchor(rendered, source, { path: PATH, startLine: 40, endLine: 40 }, { kind: "block", version: 1, revision }, revision)).toBeUndefined();
  const endpoint = { leaf: endpoints(rendered, "≂̸").start.leaf, offset: 3 };
  expect(selectionAnchor(rendered, source, { path: PATH, startLine: 1, endLine: 1 }, { kind: "range", version: 1, revision, start: endpoint, end: endpoint }, revision)).toBeUndefined();
});

test("legacy ambiguous source/rendered candidates orphan, never pick a literal copy", async () => {
  const source = "A &amp; B and A & B";
  const rendered = await renderProvenance("/repo", PATH, source);
  const anchor = { path: PATH, startLine: 1, endLine: 1, revision: await revisionOf(source), quote: { exact: "A & B", prefix: "", suffix: "" } };
  expect(recoverLegacyAnchor(rendered, source, anchor)).toBeUndefined();
  const env = await setup(source);
  expect((await env.post(undefined, anchor.quote)).status).toBe(400);
});

test("bounded legacy recovery preserves the final newline belonging to its recorded line", async () => {
  const source = "a...\nnext line";
  const rendered = await renderProvenance("/repo", PATH, source);
  const anchor = { path: PATH, startLine: 1, endLine: 1, revision: await revisionOf(source), quote: { exact: "a…\n", prefix: "", suffix: "" } };
  const recovered = recoverLegacyAnchor(rendered, source, anchor);
  expect(recovered?.quote).toEqual({ exact: "a...\n", prefix: "", suffix: "next line" });
  expect([recovered?.startLine, recovered?.endLine]).toEqual([1, 1]);
});

for (const line of [
  'He said "hi" -- ok... (c) 2026 and it\'s fine.',
  "Wait... what... really... ok... fine... yes... done...",
  "Dots...... here...... and...... a...... word...... fine",
]) test(`#113/#126/#127 legacy snapshot recovery: ${line}`, async () => {
  const source = `# Title\n\n${line}\n\nTail paragraph.`;
  const root = rootWith(source);
  const store = SqliteThreadStore.open({ filename: ":memory:" });
  const service = startReanchorDaemon({ store, bus: new EventBus(), repoRoot: root, distDir: join(root, "dist"), logger: makeLogger({ sink: { write: () => {} } }) });
  try {
    const rendered = await renderProvenance(root, PATH, source);
    const revision = await revisionOf(source);
    const quote = rendered.document.querySelector("p")!.textContent!;
    const anchor: Anchor = { path: PATH, startLine: 3, endLine: 3, revision, quote: { exact: quote, prefix: "", suffix: "" } };
    store.putSnapshot(revision, source);
    await store.append({ kind: "comment.created", actor: { kind: "local", id: "u" }, threadId: "legacy", commentId: "legacy-comment", body: "Existing comment", anchor });
    const v2 = source.replace("fine", "wrong") + "\n\nUnrelated paragraph.";
    writeFileSync(join(root, PATH), v2);
    await service.refresh(PATH);
    let thread = (await store.threads())[0]!;
    expect(thread.status).toBe("open");
    expect(isLineAnchor(thread.anchor)).toBe(true);
    if (!isLineAnchor(thread.anchor)) throw new Error("line anchor required");
    expect(thread.anchor.startLine).toBe(3);
    expect(thread.anchor.endLine).toBe(3);
    expect(thread.anchor.quote.exact).toBe(line.replace("fine", "wrong"));
    const v3 = v2 + "\n\nAnother unrelated paragraph.";
    writeFileSync(join(root, PATH), v3);
    await service.refresh(PATH);
    thread = (await store.threads())[0]!;
    expect(thread.status).toBe("open");
    const events = await store.since(0);
    expect(events[0]!.kind).toBe("comment.created");
    expect((events[0] as { anchor: Anchor }).anchor.quote.exact).toBe(quote);
    expect(events.filter((e) => e.kind === "thread.reanchored")).toHaveLength(2);
  } finally { await service.stop(); store.close(); }
});
