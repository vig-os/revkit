"""Exercise the consumer registration with only the packaged CLI on PATH."""

import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time

root = Path.cwd()
registration = json.loads((root / ".mcp.json").read_text())["mcpServers"]["revkit"]
assert registration == {"command": "revkit", "args": ["mcp"]}, registration
state_path = root / ".revkit/serve.json"
assert not state_path.exists(), "smoke requires a fresh repository with no daemon"
bin_dir = root / ".revkit/mcp-smoke-bin"
bin_dir.mkdir(parents=True)
(bin_dir / "revkit").symlink_to(sys.argv[1])
env = {**os.environ, "PATH": str(bin_dir)}
with (root / ".revkit/mcp-smoke.err").open("w") as diagnostics:
    child = subprocess.Popen(
        [registration["command"], *registration["args"]],
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=diagnostics,
    )
    try:
        request = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "template-smoke", "version": "1"},
            },
        }
        child.stdin.write((json.dumps(request) + "\n").encode())
        child.stdin.flush()
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if not selector.select(timeout=1):
                continue
            line = child.stdout.readline()
            assert line, "MCP exited before initialize response"
            response = json.loads(line)
            if response.get("id") == 1:
                assert "result" in response, response
                break
        else:
            raise AssertionError("MCP initialize timed out")
        # Initialize alone could succeed while daemon startup failed. Require
        # the auto-started daemon's advertisement as well.
        while not state_path.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert state_path.exists(), "MCP did not auto-start its daemon"
        print(
            "smoke: OK — registration initialized MCP and auto-started daemon without bun on PATH"
        )
    finally:
        child.terminate()
        child.wait(timeout=10)
        # Fresh scratch repository: only this invocation can have published it.
        if state_path.exists():
            pid = json.loads(state_path.read_text())["pid"]
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            for _ in range(100):
                if not state_path.exists():
                    break
                time.sleep(0.05)
