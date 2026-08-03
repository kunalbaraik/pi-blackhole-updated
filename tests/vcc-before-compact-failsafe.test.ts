/**
 * F2 fail-safe: if the before-compact hook body throws, the wrapper must fail
 * closed ({cancel:true}) for non-overflow reasons — never leak the __pi_vcc__
 * sentinel into Pi's fallback compactor — and fall through (undefined) on
 * overflow so the session still recovers.
 *
 * compile() is mocked to throw so every pipeline path hits the catch.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  registerBeforeCompactHook,
  PI_VCC_COMPACT_INSTRUCTION,
} from "../src/hooks/before-compact.js";

vi.mock("../src/core/summarize.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/core/summarize.js")>();
  return {
    ...mod,
    compile: vi.fn(() => {
      throw new Error("boom: deterministic compile exploded");
    }),
  };
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bh-failsafe-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

interface Setup {
  invoke: (ev: any) => any;
  notifyCalls: Array<{ msg: string; level: string }>;
}

function setup(): Setup {
  const notifyCalls: Array<{ msg: string; level: string }> = [];
  let handler: ((e: any, c: any) => any) | undefined;
  const config = {
    overrideDefaultCompaction: false,
    noAutoCompact: false,
    compaction: "auto",
    compactionEngine: "blackhole",
    tailBehavior: "minimal",
    debug: false,
    debugLog: false,
  };
  const ctx = {
    cwd: tmpDir,
    hasUI: true,
    ui: {
      notify: (msg: string, level: string) => {
        notifyCalls.push({ msg, level });
      },
    },
  };
  const omRuntime = {
    ensureConfig: vi.fn(() => {}),
    tryEmitInfo: vi.fn(() => false),
    config,
  };
  const pi = {
    on: (name: string, h: (e: any, c: any) => any) => {
      if (name === "session_before_compact") handler = h;
    },
  };
  registerBeforeCompactHook(pi as any, omRuntime as any);
  return {
    invoke: (ev: any) => handler!(ev, ctx),
    notifyCalls,
  };
}

const event = (
  customInstructions?: string,
  reason: "manual" | "threshold" | "overflow" = "threshold",
  willRetry = false,
) => ({
  type: "session_before_compact",
  customInstructions,
  branchEntries: [
    { id: "m1", type: "message", message: { role: "user", content: "x" } },
    { id: "m2", type: "message", message: { role: "assistant", content: "y" } },
    { id: "m3", type: "message", message: { role: "user", content: "z" } },
    { id: "m4", type: "message", message: { role: "assistant", content: "w" } },
  ],
  preparation: {
    previousSummary: undefined,
    fileOps: { read: [], written: [], edited: [] },
    tokensBefore: 1000,
  },
  reason,
  willRetry,
  signal: new AbortController().signal,
});

describe("registerBeforeCompactHook: fail-safe wrapper (F2)", () => {
  test("interior throw on /blackhole (manual) → {cancel:true}, sentinel never leaks", () => {
    const { invoke } = setup();
    const result = invoke(event(PI_VCC_COMPACT_INSTRUCTION, "manual"));
    // Fail closed — Pi's emit() never sees an exception, so it never falls
    // back with customInstructions="__pi_vcc__" in the prompt.
    expect(result).toEqual({ cancel: true });
  });

  test("interior throw on threshold → {cancel:true} (no paid Pi compactor run)", () => {
    const { invoke } = setup();
    const result = invoke(event(undefined, "threshold", false));
    expect(result).toEqual({ cancel: true });
  });

  test("interior throw on overflow → undefined (Pi's compactor recovers the session)", () => {
    const { invoke } = setup();
    const result = invoke(event(undefined, "overflow", true));
    expect(result).toBeUndefined();
  });
});
