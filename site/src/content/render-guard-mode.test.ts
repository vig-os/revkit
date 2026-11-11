// `render-guard-mode` captures astro's `command` so the render guard
// (`content.config.ts` → `guardedDocsLoader`) can skip its throw in
// `astro dev`. The guard's dev-skip is justified in the PR / module
// comment: astro's dev server already surfaces render errors via its
// error overlay, and a throw from `load()` only yields astro's
// "Dev server process exited before becoming ready" — strictly LESS
// useful than what astro already shows (round-2 review of #237).
import { describe, expect, test } from "bun:test";
import { renderGuardMode, revkitRenderGuardMode } from "./render-guard-mode.ts";

describe("revkitRenderGuardMode astro integration", () => {
  test("writes astro's command into `renderGuardMode.command`", () => {
    const integration = revkitRenderGuardMode();
    expect(integration.name).toBe("revkit-render-guard-mode");
    integration.hooks["astro:config:setup"]({ command: "build" });
    expect(renderGuardMode.command).toBe("build");
    integration.hooks["astro:config:setup"]({ command: "dev" });
    expect(renderGuardMode.command).toBe("dev");
    // Restore a defensive default so other test ordering never sees a
    // stale value.
    integration.hooks["astro:config:setup"]({ command: "build" });
  });
});
