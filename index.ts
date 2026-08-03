/**
 * Unified entry point. Registers all pi-vcc + observational-memory
 * commands, hooks, and tools.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/index.ts)
 *           https://github.com/sting8k/pi-vcc (index.ts)
 * Merged and extended by pi-vcc-om.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scaffoldSettings } from "./src/core/settings";
import { registerBeforeCompactHook } from "./src/hooks/before-compact";
import { registerPiVccCommand } from "./src/commands/pi-vcc";
import { registerMemoryCommand } from "./src/commands/memory";
import { registerVccRecallCommand } from "./src/commands/vcc-recall";
import { registerConsolidationTrigger } from "./src/om/consolidation.js";
import { registerCompactionTrigger } from "./src/om/compaction-trigger.js";
import { registerSessionForkHandlers } from "./src/om/session-fork.js";
import { registerRecallTool } from "./src/tools/recall";
import { Runtime } from "./src/om/runtime.js";
import { captureRegisteredProviderStreams } from "./src/om/provider-stream.js";
import {
  getPiRuntimeVersion,
  isVersionInRange,
} from "./src/pi-base/version-guard.js";

export default (pi: ExtensionAPI) => {
  // ── Bridge: capture custom provider stream functions for jiti-loaded agents ──
  // pi-blackhole's consolidation agents are loaded via jiti with moduleCache: false,
  // which creates a separate pi-ai instance whose apiProviderRegistry lacks custom
  // providers (e.g., claude-bridge registered by other extensions). This bridge stores
  // streamSimple functions in a Symbol.for() global so agents can access them without
  // going through pi-ai's registry.
  //
  // Capture custom provider streams from Pi's model registry before each run.
  // This works regardless of extension load order and includes providers added
  // after startup.
  const PROVIDER_STREAMS_KEY = Symbol.for("pi-blackhole:provider-streams");
  const providerStreams: Map<string, Function> = ((globalThis as any)[
    PROVIDER_STREAMS_KEY
  ] ??= new Map());
  pi.on("agent_start", (_event: unknown, ctx: any) => {
    captureRegisteredProviderStreams(ctx.modelRegistry, providerStreams);
  });

  scaffoldSettings();

  const omRuntime = new Runtime();

  // ── Version guard (S5) + session-model fallback warning (S3) ─────────────
  // Warn once per process; both degrade silently on missing ctx/ui.
  const piVersion = getPiRuntimeVersion();
  let versionWarned = false;
  let sessionModelWarned = false;
  pi.on("session_start", (_event: unknown, ctx: any) => {
    if (!versionWarned && !isVersionInRange(piVersion)) {
      versionWarned = true;
      try {
        ctx?.ui?.notify?.(
          `blackhole: Pi runtime ${piVersion ?? "unknown"} is outside the supported range >=0.81.1 <1.0.0 — compaction internals may have changed.`,
          "warning",
        );
      } catch {}
    }
    if (!sessionModelWarned) {
      try {
        omRuntime.ensureConfig(ctx?.cwd ?? process.cwd());
      } catch {}
      const cfg = omRuntime.config;
      const usesSessionModel =
        cfg.memory !== false &&
        cfg.sessionFallback !== false &&
        !cfg.observerModel &&
        !cfg.reflectorModel &&
        !cfg.dropperModel &&
        !cfg.model;
      if (usesSessionModel) {
        sessionModelWarned = true;
        try {
          ctx?.ui?.notify?.(
            "blackhole: observer/reflector/dropper will run on your session model (paid). Set observerModel/reflectorModel/dropperModel to cheaper models to cut cost.",
            "info",
          );
        } catch {}
      }
    }
  });

  // Observational memory: background consolidation pipeline
  registerConsolidationTrigger(pi, omRuntime); // agent_start + turn_end → observer/reflector/dropper
  registerCompactionTrigger(pi, omRuntime); // agent_end → auto-compaction
  registerSessionForkHandlers(pi, omRuntime); // session_start(fork) → pending copy; switch → cursor reset

  // Pi-vcc: compaction + om injection
  registerBeforeCompactHook(pi, omRuntime); // session_before_compact → pi-vcc + om content

  // Commands
  registerPiVccCommand(pi, omRuntime); // /pi-vcc (needs runtime for noAutoCompact flush)
  registerMemoryCommand(pi, omRuntime); // /blackhole-memory [status|view|full]
  registerVccRecallCommand(pi); // /blackhole-recall <query>

  // Tools
  registerRecallTool(pi); // unified recall (#N + [12char])
};
