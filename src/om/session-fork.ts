/**
 * Fork/switch continuity — F3.
 *
 * Forks previously inherited zero pending OM state and re-observed from
 * scratch (wasted spend, not corruption). The `session_before_fork` event
 * fires BEFORE the fork session exists, so the new session id is unknown at
 * that point — the pending-file copy must happen on the fork's
 * `session_start` (reason === "fork", previousSessionFile present).
 *
 * `session_before_switch` resets in-memory cursors when they belong to a
 * different session than the one being resumed, so cursor state can never
 * bleed across sessions.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "./runtime.js";
import { debugLog } from "./debug-log.js";
import { copyPendingState, sessionIdFromFile } from "./pending.js";

export function registerSessionForkHandlers(
  pi: ExtensionAPI,
  runtime: Runtime,
): void {
  // Copy parent pending state into the newly forked session.
  pi.on("session_start", (event: any, ctx: any) => {
    if (event?.reason !== "fork") return;
    const previousSessionFile = event?.previousSessionFile as
      string | undefined;
    if (!previousSessionFile) return;
    const parentId = sessionIdFromFile(previousSessionFile);
    const forkId =
      typeof ctx?.sessionManager?.getSessionId === "function"
        ? ctx.sessionManager.getSessionId()
        : undefined;
    if (!parentId || !forkId || parentId === forkId) return;
    const copied = copyPendingState(parentId, forkId);
    debugLog(
      "session_fork.pending_copy",
      { parentId, forkId, copied },
      runtime.config.debugLog === true,
    );
  });

  // Reset in-memory cursors when they belong to a different session.
  pi.on("session_before_switch", (event: any, _ctx: any) => {
    const targetFile = event?.targetSessionFile as string | undefined;
    if (!targetFile) return;
    const targetId = sessionIdFromFile(targetFile);
    if (
      runtime.cursorsLoadedSessionId !== undefined &&
      runtime.cursorsLoadedSessionId !== targetId
    ) {
      runtime.cursors = {};
      runtime.cursorsLoadedSessionId = undefined;
      debugLog(
        "session_switch.cursor_reset",
        { targetId },
        runtime.config.debugLog === true,
      );
    }
  });
}
