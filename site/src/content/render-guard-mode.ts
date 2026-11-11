// The render guard (`content.config.ts` → `guardedDocsLoader`) behaves
// differently in `astro dev` and `astro build`:
//
//   - `astro build`: the structural check throws if a doc with a
//     non-empty source body did not render to HTML, and astro surfaces
//     that as a non-zero exit code.
//   - `astro dev`: the dev server's own error overlay already shows
//     render errors; throwing from `load()` yields the astro supervisor
//     message "Dev server process exited before becoming ready", which
//     is strictly LESS useful than what astro already prints (round-2
//     review of #237). The gate skips its throw in dev.
//
// Astro's loader context carries no `command` field, so the
// `revkitRenderGuardMode` astro integration here captures the command
// from `astro:config:setup`'s argument and writes it to a module-level
// box. The loader reads the box. Module identity is stable within one
// astro process (astro loads `content.config.ts` ONCE per build), so a
// setter + reader on the same module works without a per-request
// channel.

/** Captured command — the string astro passes to
 * `astro:config:setup`. Starts `"unknown"` so the loader errs on the
 * safe side (gate runs) if the integration is not registered. */
export const renderGuardMode: {
  command: "dev" | "build" | "preview" | "sync" | "unknown";
} = {
  command: "unknown",
};

/** Shape of the astro integration object. Kept minimal (no import of
 * `AstroIntegration`) so this module stays usable in a site config
 * loaded outside the astro dist. */
export interface AstroIntegrationLike {
  readonly name: string;
  readonly hooks: {
    readonly "astro:config:setup": (args: {
      readonly command: "dev" | "build" | "preview" | "sync";
    }) => void;
  };
}

/** The companion astro integration. Registered from
 * `site/astro.config.mjs`. */
export function revkitRenderGuardMode(): AstroIntegrationLike {
  return {
    name: "revkit-render-guard-mode",
    hooks: {
      "astro:config:setup": ({ command }) => {
        renderGuardMode.command = command;
      },
    },
  };
}
