// Answer the first-run interactive prompts inside the test pane. The two
// dialogs we ever see are:
//   - workspace-trust: "Accessing workspace / Quick safety check / trust
//     this folder ... Enter to confirm"
//   - development-channel consent: "Loading development channels / allow
//     this MCP server ... Enter to confirm"
//
// Both use the `❯` cursor to indicate the highlighted option. We refuse
// to press Enter until the cursor is on a KNOWN positive option — a
// mismatched cursor is a SAFETY ABORT, not a blind keypress.
//
// The bash version was ~90 lines of pane-reading; this port keeps the
// same regex/predicate shape.

import type { Logger } from "./logger.ts";
import { agentWaitReady, paneRead, paneSendKeys, paneSendText } from "./flk.ts";

const YES_TRUST_CURSOR = /^[\s]*❯[\s]+Yes,[\s]I[\s]trust[\s]this[\s]folder/m;
const CHANNEL_YES_CURSOR = /^[\s]*❯[\s]+(1\.[\s]+I am using this for local development|Yes|Allow|Enable|Load|Trust|Continue)/m;

export async function answerPrompts(opts: {
  readonly paneId: string;
  readonly logger: Logger;
  readonly timeoutMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  let answeredTrust = false;
  let answeredChannel = false;
  while (Date.now() < deadline) {
    const screen = paneRead(opts.paneId) ?? "";
    if (
      !answeredTrust &&
      /Accessing workspace|Quick safety check|trust this folder/.test(screen) &&
      /Enter to confirm/.test(screen)
    ) {
      opts.logger.log("workspace-trust prompt detected — sending Down");
      paneSendKeys(opts.paneId, "Down");
      let landed = false;
      for (let i = 0; i < 5; i += 1) {
        await sleep(400);
        if (YES_TRUST_CURSOR.test(paneRead(opts.paneId) ?? "")) {
          landed = true;
          break;
        }
      }
      if (!landed) {
        opts.logger.log("'Down' key did not move the cursor; trying raw ESC[B via send-text");
        paneSendText(opts.paneId, "\x1b[B");
        for (let i = 0; i < 5; i += 1) {
          await sleep(400);
          if (YES_TRUST_CURSOR.test(paneRead(opts.paneId) ?? "")) {
            landed = true;
            break;
          }
        }
      }
      if (!landed) {
        opts.logger.log("SAFETY ABORT: workspace-trust cursor did NOT land on 'Yes, I trust this folder'");
        opts.logger.logBlock("pane", paneRead(opts.paneId) ?? "");
        throw new Error("unsafe to answer trust prompt");
      }
      opts.logger.log("confirming 'Yes, I trust this folder' with Enter");
      paneSendKeys(opts.paneId, "Enter");
      answeredTrust = true;
      await sleep(2000);
      continue;
    }
    if (
      !answeredChannel &&
      /Loading development channels|development channel|allow this MCP server|load this channel/.test(screen) &&
      /Enter to confirm|\[y\/N\]|\[Y\/n\]/.test(screen)
    ) {
      if (!CHANNEL_YES_CURSOR.test(screen)) {
        opts.logger.log("SAFETY ABORT: channel-consent cursor is not on a known positive option — refusing to press Enter");
        opts.logger.logBlock("pane", screen);
        throw new Error("unsafe to answer channel-consent prompt");
      }
      opts.logger.log("confirming channel-consent prompt with Enter");
      paneSendKeys(opts.paneId, "Enter");
      answeredChannel = true;
      await sleep(2000);
      continue;
    }
    if (/don't ask on|dontAsk|Try "/.test(screen) && /❯/.test(screen)) {
      opts.logger.log("session appears interactive-ready");
      return;
    }
    await sleep(1000);
  }
  throw new Error("could not clear first-run prompts (may be a manual step)");
}

/** Wait for the pane's agent to reach the ready state after prompts. */
export function waitReadyOrThrow(paneId: string, logger: Logger): void {
  if (!agentWaitReady(paneId, 30_000)) {
    logger.log("agent did not reach ready after prompts");
    logger.logBlock("pane", paneRead(paneId, 120) ?? "");
    throw new Error("agent never became ready — inspect the log");
  }
  logger.log("agent is ready");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
