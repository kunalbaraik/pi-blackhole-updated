/**
 * F3 — fork/switch continuity.
 *
 * Forks inherit parent pending OM state (pending file copied on the fork's
 * session_start); switching sessions resets in-memory cursors so state never
 * bleeds across sessions.
 *
 * PI_CODING_AGENT_DIR redirects Pi's getAgentDir() to a temp dir so pending
 * files are written/read without touching the real agent directory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerSessionForkHandlers } from "../src/om/session-fork.js";
import { copyPendingState, sessionIdFromFile } from "../src/om/pending.js";

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "bh-fork-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(agentDir, { recursive: true, force: true });
});

const pendingDir = () => join(agentDir, "pi-blackhole");

function seedPending(sessionId: string, content: string): void {
  const dir = pendingDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}-pending.json`), content);
}

describe("copyPendingState (pending.ts)", () => {
  it("copies the source pending file to the target session", () => {
    seedPending("parent", '{"dropped":[]}');
    expect(copyPendingState("parent", "fork")).toBe(true);
    expect(readFileSync(join(pendingDir(), "fork-pending.json"), "utf8")).toBe(
      '{"dropped":[]}',
    );
  });

  it("returns false when the source has no pending state", () => {
    expect(copyPendingState("ghost", "fork")).toBe(false);
    expect(existsSync(join(pendingDir(), "fork-pending.json"))).toBe(false);
  });
});

describe("sessionIdFromFile (pending.ts)", () => {
  it("strips the directory and .jsonl extension", () => {
    expect(sessionIdFromFile("/some/dir/abc123.jsonl")).toBe("abc123");
    expect(sessionIdFromFile("abc123.jsonl")).toBe("abc123");
  });
});

interface Captured {
  invoke: (event: any, ctx?: any) => any;
}

function captureHandlers(): Captured {
  const handlers = new Map<string, (e: any, c: any) => any>();
  const pi = {
    on: vi.fn((name: string, cb: (e: any, c: any) => any) => {
      handlers.set(name, cb);
    }),
  };
  const runtime = {
    config: { debugLog: false },
    cursors: {} as Record<string, unknown>,
    cursorsLoadedSessionId: undefined as string | undefined,
  };
  registerSessionForkHandlers(pi as any, runtime as any);
  return {
    invoke: (event: any, ctx?: any) => {
      const h = handlers.get(event.type);
      if (!h) throw new Error(`no handler for ${event.type}`);
      return h(
        event,
        ctx ?? { sessionManager: { getSessionId: () => "fork" } },
      );
    },
  };
}

describe("registerSessionForkHandlers (F3)", () => {
  it("copies parent pending state into the fork on session_start(reason=fork)", () => {
    seedPending("parent", '{"dropped":[{"id":"x"}]}');
    const { invoke } = captureHandlers();
    invoke(
      {
        type: "session_start",
        reason: "fork",
        previousSessionFile: "/sessions/parent.jsonl",
      },
      { sessionManager: { getSessionId: () => "fork" } },
    );
    expect(readFileSync(join(pendingDir(), "fork-pending.json"), "utf8")).toBe(
      '{"dropped":[{"id":"x"}]}',
    );
  });

  it("does nothing on non-fork session_start", () => {
    seedPending("parent", '{"dropped":[]}');
    const { invoke } = captureHandlers();
    invoke({ type: "session_start", reason: "startup" });
    expect(existsSync(join(pendingDir(), "fork-pending.json"))).toBe(false);
  });

  it("resets in-memory cursors when switching to a different session", () => {
    const handlers = new Map<string, (e: any, c: any) => any>();
    const pi = {
      on: vi.fn((name: string, cb: (e: any, c: any) => any) => {
        handlers.set(name, cb);
      }),
    };
    const runtime = {
      config: { debugLog: false },
      cursors: { observer: { entryId: "x", state: "recorded" } },
      cursorsLoadedSessionId: "old-session",
    };
    registerSessionForkHandlers(pi as any, runtime as any);

    handlers.get("session_before_switch")!(
      {
        type: "session_before_switch",
        reason: "resume",
        targetSessionFile: "/sessions/new-session.jsonl",
      },
      {},
    );

    expect(runtime.cursors).toEqual({});
    expect(runtime.cursorsLoadedSessionId).toBeUndefined();
  });

  it("keeps cursors when switching back to the same session", () => {
    const handlers = new Map<string, (e: any, c: any) => any>();
    const pi = {
      on: vi.fn((name: string, cb: (e: any, c: any) => any) => {
        handlers.set(name, cb);
      }),
    };
    const runtime = {
      config: { debugLog: false },
      cursors: { observer: { entryId: "x", state: "recorded" } },
      cursorsLoadedSessionId: "same",
    };
    registerSessionForkHandlers(pi as any, runtime as any);

    handlers.get("session_before_switch")!(
      {
        type: "session_before_switch",
        reason: "resume",
        targetSessionFile: "/sessions/same.jsonl",
      },
      {},
    );

    expect(runtime.cursors).toEqual({
      observer: { entryId: "x", state: "recorded" },
    });
  });
});
