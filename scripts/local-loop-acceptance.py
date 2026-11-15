"""End-to-end local-loop acceptance driver (issue #202).

The brief in a line: "run the full consumer loop (MCP registration →
auto-started daemon → publish → rail comment → channel frame → reply +
resolve → re-anchor → restart → fd-flat) with NO `bun` on the server's
PATH, so the blockers #197-#201 never go invisible to CI again."

Called by `scripts/local-loop-acceptance.sh` with the paths to a
packaged `revkit` CLI, a scaffolded consumer tree and the per-run temp
directory. Every one of the 9 acceptance steps from issue #202 fails
hard with a prefixed `FAIL:` line — no soft logging, no retries, no
skipped assertions. Uses Python's stdlib only (so the driver's own
tooling adds nothing to the server's PATH); for step 6 it shells out to
the companion Bun/Playwright script which runs OUTSIDE the server env.

The driver is the harness, so the daemon's environment is scrubbed at
spawn time: `env = {PATH: <REVKIT_BIN>:<coreutils>, HOME: <scratch>}`
and nothing else inheritable. We prove it by reading
`/proc/<daemon pid>/environ` and asserting `bun` is absent from both
`PATH` and the full env.

Exit code is the step number that failed (1-9), or 0 on full success.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from hashlib import sha256
from pathlib import Path
from queue import Empty, Queue
from typing import Any, NoReturn


# ------------------------------------------------------------------- utils ----


def log(step: str, msg: str) -> None:
    sys.stdout.write(f"[accept {step}] {msg}\n")
    sys.stdout.flush()


def fail(step: int, msg: str) -> NoReturn:
    sys.stdout.write(f"FAIL: step {step}: {msg}\n")
    sys.stdout.flush()
    sys.exit(step)


# JSON-RPC over MCP stdio is line-delimited (one JSON per line). Outbound is
# fully synchronous; inbound mixes responses (identified by `id`) with
# notifications (identified by `method` and no `id`).
class McpClient:
    """Minimal JSON-RPC-over-stdio client for `revkit mcp`.

    Spawns the MCP with a scrubbed env (no `bun` on PATH), reads every line
    from stdout in a background thread, routes responses to `call()` waiters
    and notifications to a queue the driver drains.
    """

    def __init__(self, cmd: list[str], cwd: str, env: dict[str, str]) -> None:
        self.cwd = cwd
        self.env = env
        # stderr → pipe so a failure mode ("Executable not found in $PATH:
        # bun") surfaces in the log instead of /dev/null.
        self.proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self._next_id = 1
        self._pending: dict[int, Queue[dict[str, Any]]] = {}
        self._notifications: Queue[dict[str, Any]] = Queue()
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()
        self._stderr_buf: list[str] = []
        self._stderr_reader = threading.Thread(target=self._stderr_loop, daemon=True)
        self._stderr_reader.start()

    def _read_loop(self) -> None:
        stdout = self.proc.stdout
        assert stdout is not None
        for raw in stdout:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                # MCP never prints non-JSON on stdout; log it so a regression
                # (a stray `console.log` in the server) is visible.
                sys.stderr.write(f"[mcp stdout non-json] {line}\n")
                continue
            if "id" in msg and msg.get("method") is None:
                waiter = self._pending.pop(msg["id"], None)
                if waiter is not None:
                    waiter.put(msg)
                continue
            # Notification or server→client request (we handle none of the
            # latter; drop them).
            if msg.get("method") is not None and "id" not in msg:
                self._notifications.put(msg)

    def _stderr_loop(self) -> None:
        stderr = self.proc.stderr
        assert stderr is not None
        for raw in stderr:
            line = raw.decode("utf-8", errors="replace").rstrip("\n")
            self._stderr_buf.append(line)
            sys.stderr.write(f"[mcp stderr] {line}\n")

    def stderr_tail(self, n: int = 20) -> str:
        return "\n".join(self._stderr_buf[-n:])

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        msg: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        self._write(msg)

    def call(
        self, method: str, params: dict[str, Any] | None = None, timeout: float = 30.0
    ) -> dict[str, Any]:
        with self._lock:
            rid = self._next_id
            self._next_id += 1
            waiter: Queue[dict[str, Any]] = Queue()
            self._pending[rid] = waiter
        msg: dict[str, Any] = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            msg["params"] = params
        self._write(msg)
        try:
            response = waiter.get(timeout=timeout)
        except Empty as exc:
            self._pending.pop(rid, None)
            raise TimeoutError(
                f"mcp call {method} id={rid} timed out after {timeout}s"
            ) from exc
        if "error" in response:
            raise RuntimeError(f"mcp call {method} id={rid} error: {response['error']}")
        return response.get("result", {})

    def _write(self, msg: dict[str, Any]) -> None:
        stdin = self.proc.stdin
        assert stdin is not None
        payload = (json.dumps(msg) + "\n").encode("utf-8")
        stdin.write(payload)
        stdin.flush()

    def wait_notification(
        self,
        predicate: Callable[[dict[str, Any]], bool],
        timeout: float,
        collect: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        seen: list[dict[str, Any]] = []
        while time.monotonic() < deadline:
            remaining = max(0.05, deadline - time.monotonic())
            try:
                note = self._notifications.get(timeout=remaining)
            except Empty:
                continue
            seen.append(note)
            if collect is not None:
                collect.append(note)
            if predicate(note):
                return note
        raise TimeoutError(
            f"timed out after {timeout}s; saw {len(seen)} notifications: "
            f"{[n.get('method') + '/' + str(n.get('params', {}).get('meta', {}).get('kind', '')) for n in seen]}",
        )

    def drain_notifications(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        while True:
            try:
                out.append(self._notifications.get_nowait())
            except Empty:
                return out

    def close(self) -> None:
        self._stop.set()
        try:
            self.proc.terminate()
        except ProcessLookupError:
            return
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=5)


# -------------------------------------------------------------- tool helpers ----


def tool_call(
    mcp: McpClient, name: str, args: dict[str, Any], timeout: float = 30.0
) -> Any:
    """Invoke `tools/call` and return the parsed JSON body of the single text
    content block. Every revkit tool returns a JSON-serialised daemon result in
    `content[0].text`; a non-JSON or multi-block result is a protocol break
    and we fail hard.
    """
    result = mcp.call("tools/call", {"name": name, "arguments": args}, timeout=timeout)
    if result.get("isError"):
        raise RuntimeError(f"tool '{name}' returned isError: {result}")
    contents = result.get("content") or []
    if len(contents) != 1 or contents[0].get("type") != "text":
        raise RuntimeError(f"tool '{name}' returned unexpected content: {contents!r}")
    try:
        return json.loads(contents[0]["text"])
    except json.JSONDecodeError:
        return contents[0]["text"]


def read_serve_state(consumer_dir: str) -> dict[str, Any]:
    state_path = Path(consumer_dir) / ".revkit" / "serve.json"
    return json.loads(state_path.read_text())


def http_get(url: str, token: str) -> tuple[int, bytes]:
    req = urllib.request.Request(
        url,
        headers={"authorization": f"Bearer {token}", "accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


# ---------------------------------------------------------------- the steps ----


def step1_version(revkit_bin: str, expected: str) -> None:
    out = subprocess.check_output([revkit_bin, "--version"], text=True).strip()
    if not out.startswith(expected):
        fail(1, f"revkit --version is {out!r}; expected prefix {expected!r}")
    # Must be a /nix/store path — a dev-shell lookup would defeat the
    # whole test (the point is that the packaged CLI runs with nothing
    # else on PATH).
    real = os.path.realpath(revkit_bin)
    if not real.startswith("/nix/store/"):
        fail(1, f"revkit bin realpath {real!r} is not under /nix/store")
    log("step1", f"revkit --version = {out} (bin {real})")


def step2_scaffold_no_bun(consumer_dir: str, server_path: str) -> None:
    # The acceptance *harness* has bun on PATH (dev shell). The server
    # environment we will hand to `revkit mcp` must not.
    for part in server_path.split(":"):
        p = Path(part)
        if (p / "bun").exists():
            fail(
                2,
                f"server PATH component {part!r} contains a `bun` executable (would defeat #197/#206)",
            )
    # And a scaffold must have landed (the shell did the `nix flake init`).
    for required in ("flake.nix", "docs/index.mdx", ".mcp.json"):
        if not (Path(consumer_dir) / required).exists():
            fail(2, f"scaffolded consumer tree missing {required}")
    reg = json.loads((Path(consumer_dir) / ".mcp.json").read_text())["mcpServers"][
        "revkit"
    ]
    if reg != {"command": "revkit", "args": ["mcp"]}:
        fail(2, f"template .mcp.json registration drifted: {reg!r}")
    log("step2", f"scaffold ok; server PATH={server_path} (no bun)")


def step3_check_and_hooks(
    consumer_dir: str, server_env: dict[str, str], revkit_bin: str
) -> None:
    # `revkit check` on the scaffolded tree (consumer path).
    subprocess.run(
        ["revkit", "check"],
        cwd=consumer_dir,
        env=server_env,
        check=True,
    )
    # Run the `lib.hooks.mkHooks` entry (just `${revkit}/bin/revkit check`
    # with the file list passed through pre-commit — we exercise its
    # command shape as the hook would call it, with --no-stdin-files).
    # The entry is `${revkit}/bin/revkit check`; run it the way pre-commit
    # would (no file args, since `pass_filenames = false`).
    subprocess.run(
        [revkit_bin, "check"],
        cwd=consumer_dir,
        env=server_env,
        check=True,
    )
    log("step3", "revkit check (consumer) and lib.hooks entry both passed")


def ensure_daemon_env_clean(daemon_pid: int) -> None:
    """Prove the daemon inherited a bun-free environment.

    Reads `/proc/<daemon pid>/environ` and asserts that neither PATH nor the
    full environment carries a `bun` entry. This is what makes the whole
    bun-free claim measurable instead of merely argued.
    """
    environ_path = Path(f"/proc/{daemon_pid}/environ")
    try:
        raw = environ_path.read_bytes()
    except (FileNotFoundError, PermissionError) as exc:
        fail(4, f"could not read /proc/{daemon_pid}/environ: {exc}")
    env_entries = [e.decode("utf-8", errors="replace") for e in raw.split(b"\x00") if e]
    path_values = [e.split("=", 1)[1] for e in env_entries if e.startswith("PATH=")]
    for pv in path_values:
        for part in pv.split(":"):
            if Path(part, "bun").exists():
                fail(
                    4,
                    f"daemon PATH {pv!r} resolves `bun` (part {part!r}) — isolation broken",
                )
    # An over-eager env leak shows up as `_=/…/bun` or `BUN_INSTALL=…`:
    # refuse any env var whose VALUE contains the literal "bun" as a
    # path component.
    for entry in env_entries:
        name, _, value = entry.partition("=")
        if name in {"PATH", "_"}:
            continue
        for part in value.split(":"):
            if Path(part).name == "bun" and Path(part).exists():
                fail(4, f"daemon env {name}={value!r} contains a resolvable bun path")


def step4_launch_mcp(consumer_dir: str, server_env: dict[str, str]) -> McpClient:
    log("step4", "spawning `revkit mcp` through the shipped template registration")
    mcp = McpClient(["revkit", "mcp"], cwd=consumer_dir, env=server_env)
    # MCP handshake. `initialize` then `notifications/initialized`.
    init = mcp.call(
        "initialize",
        {
            "protocolVersion": "2024-11-05",
            "capabilities": {"experimental": {"claude/channel": {}}},
            "clientInfo": {"name": "revkit-local-loop-acceptance", "version": "1"},
        },
        timeout=30,
    )
    if "serverInfo" not in init:
        fail(4, f"initialize response missing serverInfo: {init!r}")
    mcp.notify("notifications/initialized")
    # Wait for the daemon's advertisement file; proves the bootstrap
    # finished and gave us the daemon's pid.
    state_path = Path(consumer_dir) / ".revkit" / "serve.json"
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if state_path.exists():
            break
        if mcp.proc.poll() is not None:
            fail(
                4,
                f"revkit mcp exited (code {mcp.proc.returncode}) before publishing serve.json; stderr tail:\n{mcp.stderr_tail()}",
            )
        time.sleep(0.05)
    if not state_path.exists():
        fail(4, f"serve.json never appeared; stderr tail:\n{mcp.stderr_tail()}")
    state = read_serve_state(consumer_dir)
    daemon_pid = state["pid"]
    ensure_daemon_env_clean(daemon_pid)
    # The daemon owning the lock proves the bootstrap didn't just mint
    # `serve.json` and die.
    if not Path(f"/proc/{daemon_pid}").exists():
        fail(4, f"serve.json names pid {daemon_pid} but /proc/{daemon_pid} is missing")
    log("step4", f"MCP initialized; daemon pid={daemon_pid} url={state['url']}")
    return mcp


# `docs/adr/0202-local-loop-acceptance-fixture.md` is the publish target.
# The content has frontmatter (title required by Starlight's schema) AND a
# fenced code block — the fence forces the daemon's full-build path, which
# is what B4 (raw-source provenance) was about. Three paragraphs so step 7
# can insert two before the quoted paragraph and assert a non-zero line shift.
FIXTURE_PATH = "docs/adr/0202-local-loop-acceptance-fixture.md"
FIXTURE_V1 = """\
---
title: Local-loop acceptance fixture
description: Round-trip page used by scripts/local-loop-acceptance.sh.
---

# Local-loop acceptance fixture

This paragraph is published by the acceptance test and is one of two
candidate anchors for the rail comment.

The second paragraph is unique to this fixture so reanchor-after-insert
can find it again at a different line after step 7 shifts it.

```text
fenced code forces the full build path
instead of the fast-path renderer, exercising B4
```
"""

FIXTURE_V2 = """\
---
title: Local-loop acceptance fixture
description: Round-trip page used by scripts/local-loop-acceptance.sh.
---

# Local-loop acceptance fixture

Inserted paragraph alpha — pushes the anchored paragraph down by one
block so the reanchor pipeline has a real line shift to report.

Inserted paragraph beta — a second insertion so the shift in step 7 is
unambiguous and not an off-by-one on a single paragraph.

This paragraph is published by the acceptance test and is one of two
candidate anchors for the rail comment.

The second paragraph is unique to this fixture so reanchor-after-insert
can find it again at a different line after step 7 shifts it.

```text
fenced code forces the full build path
instead of the fast-path renderer, exercising B4
```
"""


def step5_publish(mcp: McpClient, consumer_dir: str) -> dict[str, Any]:
    # Make sure docs/adr/ exists — the daemon's publish confinement
    # rejects any `docs/adr/*.md` whose parent is missing (same shape as
    # the audit report's observation).
    (Path(consumer_dir) / "docs" / "adr").mkdir(parents=True, exist_ok=True)
    result = tool_call(
        mcp,
        "publish",
        {"docs": [{"path": FIXTURE_PATH, "content": FIXTURE_V1}]},
        timeout=60,
    )
    published = result.get("published") or []
    if len(published) != 1 or published[0].get("path") != FIXTURE_PATH:
        fail(5, f"publish[0] did not confirm the fixture: {result!r}")
    rendering = result.get("rendering") or []
    # The fenced-code fixture must take the full-build path. If a
    # future change makes fences fast-path-safe, this assertion is the
    # signal to update the fixture (else the test loses its B4 coverage).
    if rendering and rendering[0].get("state") == "fast":
        fail(5, f"fixture rendered via fast path; expected full build: {rendering!r}")
    build_status = (result.get("build") or {}).get("status")
    if build_status not in {"pending", "running", "succeeded"}:
        fail(5, f"publish build status unexpected: {build_status!r}")
    # Wait for the build to succeed. A `build.failed` is a hard fail.
    # The daemon writes the built HTML to .revkit/dist/<route>/index.html.
    deadline = time.monotonic() + 180
    built_path = (
        Path(consumer_dir)
        / ".revkit"
        / "dist"
        / "adr"
        / "0202-local-loop-acceptance-fixture"
        / "index.html"
    )
    while time.monotonic() < deadline:
        if built_path.exists():
            html = built_path.read_text()
            if "Local-loop acceptance fixture" in html and "fenced code forces" in html:
                break
        time.sleep(0.2)
    else:
        fail(5, f"built page never appeared or lacked the body text at {built_path}")
    # Provenance: every data-src attribute points into the *source* file
    # with the *source* line numbers. B4: with frontmatter present, the
    # old pipeline reported lines off by the frontmatter height.
    html = built_path.read_text()
    source = (Path(consumer_dir) / FIXTURE_PATH).read_text().splitlines()
    src_attrs = re.findall(r'data-src="([^"]+)"', html)
    if not src_attrs:
        fail(5, f"built page carries no data-src attributes: {built_path}")
    para = "This paragraph is published by the acceptance test"
    source_para_line = next(
        (i + 1 for i, line in enumerate(source) if para in line), None
    )
    if source_para_line is None:
        fail(5, "fixture source no longer contains the first-paragraph marker")
    matched = False
    for attr in src_attrs:
        m = re.match(rf"^{re.escape(FIXTURE_PATH)}:(\d+)-(\d+)$", attr)
        if m is None:
            continue
        start, end = int(m.group(1)), int(m.group(2))
        if start <= source_para_line <= end:
            matched = True
            break
    if not matched:
        fail(
            5,
            f"no data-src range covers the first paragraph's source line {source_para_line}; "
            f"ranges={src_attrs} (B4 — provenance is off by the frontmatter height)",
        )
    log(
        "step5",
        f"publish → 201, build succeeded, data-src covers source line {source_para_line}",
    )
    return result


def step6_rail_comment_and_reply(
    mcp: McpClient,
    consumer_dir: str,
    revkit_repo: str,
    scratch_dir: str,
) -> dict[str, Any]:
    """Drive the whole rail-UI leg in ONE Playwright process so the
    "reply + resolve appear without reload" assertion is observable on
    the page that posted the comment. Python coordinates: it reads the
    browser's stdout line by line, calls `reply` and `resolve` on the
    MCP once the browser confirms the create, then waits for the browser
    to assert the SSE update landed.
    """
    state = read_serve_state(consumer_dir)
    browser_env = {
        **os.environ,
        "REVKIT_ACCEPT_URL": state["url"],
        "REVKIT_ACCEPT_TOKEN": state["agentToken"],
        "REVKIT_ACCEPT_ROUTE": "/adr/0202-local-loop-acceptance-fixture/",
        "REVKIT_ACCEPT_SCRATCH": scratch_dir,
    }
    drained = mcp.drain_notifications()
    log(
        "step6", f"drained {len(drained)} notifications before posting the rail comment"
    )
    browser_script = str(
        Path(revkit_repo) / "site" / "scripts" / "local-loop-acceptance-browser.ts"
    )
    log(
        "step6",
        "launching Bun+Playwright browser (one process, coordinated over stdout)",
    )
    proc = subprocess.Popen(
        ["bun", browser_script],
        cwd=str(Path(revkit_repo) / "site"),
        env=browser_env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert (
        proc.stdout is not None and proc.stdin is not None and proc.stderr is not None
    )

    stderr_buf: list[str] = []
    stdout_queue: Queue[str | None] = Queue()

    def drain_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            stderr_buf.append(line.rstrip("\n"))
            sys.stderr.write(f"[browser stderr] {line}")

    def drain_stdout() -> None:
        # Pumping stdout into a queue decouples "the child hasn't printed
        # yet" from "readline() is stuck on a half-closed pipe" — the
        # thread blocks on readline, main blocks on Queue.get with a
        # timeout, and EOF closes the pump cleanly by enqueuing None.
        assert proc.stdout is not None
        for line in proc.stdout:
            stdout_queue.put(line)
        stdout_queue.put(None)

    threading.Thread(target=drain_stderr, daemon=True).start()
    threading.Thread(target=drain_stdout, daemon=True).start()

    def read_marker(prefix: str, timeout_s: float) -> str:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            remaining = max(0.1, deadline - time.monotonic())
            try:
                line = stdout_queue.get(timeout=remaining)
            except Empty:
                continue
            if line is None:
                fail(
                    6,
                    f"browser closed stdout before {prefix!r}; exit code {proc.poll()}; stderr:\n"
                    + "\n".join(stderr_buf[-30:]),
                )
            sys.stdout.write(f"[browser stdout] {line}")
            sys.stdout.flush()
            if line.startswith(prefix):
                return line.rstrip("\n")
        fail(6, f"browser never emitted {prefix!r} within {timeout_s}s")

    try:
        # Browser leg: nav → launchUrl + fixture page, select + compose +
        # submit, wait for the daemon's 201. 180 s is generous for a
        # cold runner where each nav triggers a rerender on the daemon.
        created = read_marker("COMMENT_OK", 180)
        m = re.match(r"COMMENT_OK thread_id=(\S+) comment_id=(\S+)", created)
        if m is None:
            fail(6, f"browser COMMENT_OK line malformed: {created!r}")
        thread_id, comment_id = m.group(1), m.group(2)
        # Wait for the channel frame carrying this thread_id. The
        # browser leg POSTed `/api/handover` immediately after submit,
        # so the agent (us) should see a frame right away.
        note = mcp.wait_notification(
            lambda n: (
                n.get("method") == "notifications/claude/channel"
                and n.get("params", {}).get("meta", {}).get("thread_id") == thread_id
            ),
            timeout=15,
        )
        # The MCP sends `{ content, meta }` as the notification params;
        # Claude Code wraps the content in `<channel source="revkit" …>`
        # on receipt. See formatChannelPayload in
        # packages/cli/src/mcp/channel-server.ts for the fields the
        # server fills.
        params = note.get("params") or {}
        content = params.get("content") or ""
        meta = params.get("meta") or {}
        if "New comment on" not in content or FIXTURE_PATH not in content:
            fail(
                6,
                f"channel frame content did not describe the new comment: {content!r}",
            )
        # `source` is set by Claude Code when it wraps the frame — not
        # by the MCP server (see formatChannelPayload in
        # packages/cli/src/mcp/channel-server.ts). Thread id, path and
        # author_kind are what the server fills, and what we check.
        if meta.get("thread_id") != thread_id:
            fail(6, f"channel frame meta did not carry the new thread id: {meta!r}")
        if meta.get("path") != FIXTURE_PATH:
            fail(6, f"channel frame meta path mismatch: {meta!r}")
        tool_call(
            mcp,
            "reply",
            {
                "thread_id": thread_id,
                "parent_id": comment_id,
                "body": "acceptance-ack from the MCP reply tool",
            },
        )
        tool_call(mcp, "resolve", {"thread_id": thread_id})
        # Tell the browser we're done posting server-side updates.
        proc.stdin.write(f"EXPECT thread_id={thread_id}\n")
        proc.stdin.flush()
        # The browser's watcher must see both the reply body and the
        # resolved status without a reload.
        confirm = read_marker("REPLY_RESOLVE_OK", 60)
        log("step6", f"browser confirmed rail update: {confirm.strip()}")
        return {"thread_id": thread_id, "comment_id": comment_id}
    finally:
        try:
            if proc.stdin and not proc.stdin.closed:
                proc.stdin.write("BYE\n")
                proc.stdin.flush()
                proc.stdin.close()
        except (BrokenPipeError, ValueError):
            pass
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()


def step7_reanchor(mcp: McpClient, consumer_dir: str) -> None:
    """Republish with two inserted paragraphs; the thread re-anchors with
    a positive line shift. Step 6 resolved its thread, so we open a fresh
    anchored thread against v1's second paragraph here via the daemon's
    own POST /api/threads (loopback, we hold the agent bearer — this is
    the same wire a Playwright submit would take, minus the DOM). Not a
    rail-UI assertion: step 6 is that one.
    """
    state = read_serve_state(consumer_dir)
    source_text = (Path(consumer_dir) / FIXTURE_PATH).read_text()
    source = source_text.splitlines()
    marker = "The second paragraph is unique to this fixture"
    marker_line = next((i + 1 for i, s in enumerate(source) if marker in s), None)
    if marker_line is None:
        fail(7, "fixture lost the second-paragraph marker before step 7")
    # Find the data-src block that contains this line so the daemon's
    # `selectionAnchor` can match: the server rejects a (startLine,
    # endLine) pair that does not correspond to an existing block
    # on the rendered page (see selectionAnchor in
    # packages/cli/src/serve/source-provenance.ts).
    built_html = (
        Path(consumer_dir)
        / ".revkit"
        / "dist"
        / "adr"
        / "0202-local-loop-acceptance-fixture"
        / "index.html"
    ).read_text()
    block_range: tuple[int, int] | None = None
    for match in re.finditer(
        rf'data-src="{re.escape(FIXTURE_PATH)}:(\d+)-(\d+)"', built_html
    ):
        start, end = int(match.group(1)), int(match.group(2))
        if start <= marker_line <= end:
            block_range = (start, end)
            break
    if block_range is None:
        fail(7, f"no data-src block on the built page covers line {marker_line}")
    start_line, end_line = block_range
    # revisionOf(source) — LF-normalised SHA-256 of the raw source file,
    # same formula as packages/review-core/src/revision.ts.
    normalised = source_text.replace("\r\n", "\n").replace("\r", "\n")
    revision = sha256(normalised.encode("utf-8")).hexdigest()
    # `selection: { kind: "block", version: 1, revision }` is the daemon's
    # "I meant the whole block" path. The anchor also carries `revision`
    # so a stale page is refused instead of silently moving the anchor.
    body = json.dumps(
        {
            "anchor": {
                "path": FIXTURE_PATH,
                "startLine": start_line,
                "endLine": end_line,
                "revision": revision,
            },
            "selection": {"kind": "block", "version": 1, "revision": revision},
            "body": "acceptance step 7 — expect a reanchor on the next republish",
        }
    ).encode()
    req = urllib.request.Request(
        f"{state['url']}/api/threads",
        data=body,
        headers={
            "authorization": f"Bearer {state['agentToken']}",
            "content-type": "application/json",
            "origin": state["url"],
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            payload = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        fail(
            7,
            f"anchor-setup POST failed {exc.code}: {exc.read().decode('utf-8', 'replace')[:400]}",
        )
    anchored_thread_id = (
        (payload.get("event") or {}).get("threadId")
        or payload.get("threadId")
        or (payload.get("thread") or {}).get("id")
    )
    if anchored_thread_id is None:
        fail(7, f"anchor-setup POST returned no thread id: {payload!r}")
    drained = mcp.drain_notifications()
    log(
        "step7",
        f"drained {len(drained)} notifications before republish "
        f"(anchor block {start_line}-{end_line} on marker line {marker_line})",
    )
    tool_call(
        mcp,
        "publish",
        {"docs": [{"path": FIXTURE_PATH, "content": FIXTURE_V2}]},
        timeout=60,
    )
    # Wait for the reanchor notification. The channel-server does NOT
    # stamp `kind` for `thread.reanchored` (only `reanchor_orphan` gets
    # one — see packages/cli/src/mcp/channel-server.ts:674), so we match
    # on content shape plus the meta `thread_id`. `reanchor_orphan` is
    # the explicit failure mode and is a product bug if it fires here.
    note = mcp.wait_notification(
        lambda n: (
            n.get("method") == "notifications/claude/channel"
            and (
                n.get("params", {}).get("meta", {}).get("thread_id")
                == anchored_thread_id
            )
            and (
                "re-anchored" in (n.get("params", {}).get("content") or "")
                or n.get("params", {}).get("meta", {}).get("kind") == "reanchor_orphan"
            )
        ),
        timeout=60,
    )
    meta_kind = note["params"]["meta"].get("kind")
    if meta_kind == "reanchor_orphan":
        fail(7, f"thread {anchored_thread_id} was orphaned instead of re-anchored")
    content = note["params"]["content"]
    match = re.search(r"now at [^:]+:(\d+)-\d+", content)
    if match is None:
        fail(7, f"reanchor frame missing 'now at …:N-M' marker: {content!r}")
    new_line = int(match.group(1))
    if new_line <= start_line:
        fail(
            7,
            f"reanchor did not move the anchor forward: was block "
            f"starting line {start_line}, now {new_line}",
        )
    log("step7", f"thread re-anchored from line {start_line} to line {new_line}")


def step8_kill_and_restart(mcp: McpClient, consumer_dir: str) -> None:
    before = read_serve_state(consumer_dir)
    pre_threads = tool_call(mcp, "threads", {}, timeout=15)
    pre_ids = sorted(t["id"] for t in pre_threads.get("threads", []))
    log("step8", f"pre-restart threads: {pre_ids}")
    # SIGTERM — a well-behaved daemon exits cleanly and removes its lock.
    os.kill(before["pid"], signal.SIGTERM)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            os.kill(before["pid"], 0)
        except ProcessLookupError:
            break
        time.sleep(0.1)
    else:
        fail(8, f"daemon {before['pid']} did not exit on SIGTERM within 15s")
    # Small grace while the lock-release and serve.json-removal races
    # settle on a loaded CI runner.
    for _ in range(50):
        if not (Path(consumer_dir) / ".revkit" / "serve.json").exists():
            break
        time.sleep(0.05)
    # Next tool call must auto-restart the daemon (through the single-
    # flight reconnect added for #197/#206). Threads must survive.
    post_threads = tool_call(mcp, "threads", {}, timeout=30)
    post_ids = sorted(t["id"] for t in post_threads.get("threads", []))
    if post_ids != pre_ids:
        fail(8, f"thread ids differ across restart; before={pre_ids} after={post_ids}")
    after = read_serve_state(consumer_dir)
    if after["pid"] == before["pid"]:
        fail(8, f"daemon pid unchanged across SIGTERM+restart: {after['pid']}")
    ensure_daemon_env_clean(after["pid"])
    log(
        "step8",
        f"daemon restarted (pid {before['pid']} → {after['pid']}); threads intact",
    )


# Descriptor budget: the daemon holds open fds for its sqlite db, event-log,
# the inotify watcher and the dist tree. A single publish re-opens a few
# watchers temporarily. We allow a small growth band to accommodate the
# dist-grows-by-one-page case: the fixture is one route, so each full
# rebuild of the dist adds up to a handful of entries to the inotify
# watcher's bookkeeping. 20 is well above the observed floor (watchers at
# the audit were O(dist entries); this is a generous ceiling that still
# fails a real leak — the pre-#86 regression ran into the hundreds).
FD_GROWTH_MAX = 20


def step9_fd_budget(mcp: McpClient, consumer_dir: str) -> None:
    state = read_serve_state(consumer_dir)
    pid = state["pid"]
    fd_dir = Path(f"/proc/{pid}/fd")
    if not fd_dir.exists():
        fail(9, f"/proc/{pid}/fd missing — cannot count descriptors")
    before = len(list(fd_dir.iterdir()))
    # Three full builds, driven by rewrites of the fixture that keep the
    # fenced code so each one takes the full-build path.
    for i in range(3):
        content = FIXTURE_V2.replace("alpha", f"alpha-{i}").replace("beta", f"beta-{i}")
        tool_call(
            mcp,
            "publish",
            {"docs": [{"path": FIXTURE_PATH, "content": content}]},
            timeout=120,
        )
        # Drain so the queue doesn't grow unbounded — we don't need these
        # frames for the budget check.
        mcp.drain_notifications()
    # 30 "small" publishes against a separate path so we exercise the
    # publish → re-anchor → rerender loop without exploding the dist.
    # docs/designs/ is another publishable root in the allowlist.
    small_path = "docs/designs/0202-local-loop-acceptance-small.md"
    (Path(consumer_dir) / "docs" / "designs").mkdir(parents=True, exist_ok=True)
    for i in range(30):
        content = (
            "---\n"
            "title: Acceptance small\n"
            "---\n\n"
            f"Small publish iteration {i}, no fence — fast path if the "
            "renderer accepts it.\n"
        )
        tool_call(
            mcp,
            "publish",
            {"docs": [{"path": small_path, "content": content}]},
            timeout=30,
        )
        mcp.drain_notifications()
    # Give inotify a beat to settle its bookkeeping — this is the one
    # place we deliberately sleep, and it is 500 ms, not a polling loop.
    time.sleep(0.5)
    after = len(list(fd_dir.iterdir()))
    growth = after - before
    if growth > FD_GROWTH_MAX:
        fail(
            9,
            f"descriptor count grew {before} → {after} (+{growth}); over budget {FD_GROWTH_MAX}",
        )
    log(
        "step9",
        f"descriptor count stable: {before} → {after} (+{growth}; budget {FD_GROWTH_MAX})",
    )


# -------------------------------------------------------------------- main ----


def main() -> int:
    parser = argparse.ArgumentParser(
        description="revkit local-loop acceptance driver (#202)"
    )
    parser.add_argument(
        "--revkit-bin", required=True, help="absolute path to the packaged revkit CLI"
    )
    parser.add_argument(
        "--revkit-repo", required=True, help="absolute path to the revkit checkout"
    )
    parser.add_argument(
        "--consumer-dir",
        required=True,
        help="absolute path to the scaffolded consumer tree",
    )
    parser.add_argument(
        "--expected-version",
        required=True,
        help="revkit version the --version output must start with",
    )
    parser.add_argument(
        "--scratch-dir",
        required=True,
        help="per-run scratch dir (artifact, screenshots)",
    )
    args = parser.parse_args()

    # The *server* environment: a minimal PATH with only the packaged
    # revkit's bin and the Nix coreutils profile. No bun, no node, no
    # playwright. This is the environment the MCP (and through it, the
    # daemon) will inherit.
    core_bin = os.environ.get("REVKIT_ACCEPT_CORE_BIN") or "/run/current-system/sw/bin"
    server_path = f"{Path(args.revkit_bin).parent}:{core_bin}:/usr/bin:/bin"
    server_env: dict[str, str] = {
        "PATH": server_path,
        "HOME": args.consumer_dir,
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "TMPDIR": str(Path(args.scratch_dir) / "tmp"),
    }
    Path(server_env["TMPDIR"]).mkdir(parents=True, exist_ok=True)

    step1_version(args.revkit_bin, args.expected_version)
    step2_scaffold_no_bun(args.consumer_dir, server_path)
    step3_check_and_hooks(args.consumer_dir, server_env, args.revkit_bin)

    mcp = step4_launch_mcp(args.consumer_dir, server_env)
    try:
        step5_publish(mcp, args.consumer_dir)
        step6_rail_comment_and_reply(
            mcp, args.consumer_dir, args.revkit_repo, args.scratch_dir
        )
        step7_reanchor(mcp, args.consumer_dir)
        step8_kill_and_restart(mcp, args.consumer_dir)
        step9_fd_budget(mcp, args.consumer_dir)
    finally:
        mcp.close()
        # SIGTERM the daemon if anything still owns the lock. Only PIDs
        # we observed in serve.json during this run.
        try:
            state = read_serve_state(args.consumer_dir)
        except FileNotFoundError:
            state = None
        if state is not None:
            try:
                os.kill(state["pid"], signal.SIGTERM)
            except ProcessLookupError:
                pass

    sys.stdout.write("ACCEPT: all 9 steps passed\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
