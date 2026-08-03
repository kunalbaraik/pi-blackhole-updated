/**
 * F5 — backoff state persistence across restarts.
 *
 * lastConsolidationErrorAt / midRunCompactionSuspended used to be in-memory
 * only: a restart reset them, so a failing model was hammered immediately
 * after restart. Now they persist in PendingOMState alongside cursors and
 * hydrate on load.
 *
 * PI_CODING_AGENT_DIR redirects Pi's getAgentDir() to a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Runtime } from "../src/om/runtime.js";
import { readBackoffState, writeBackoffState } from "../src/om/pending.js";

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "bh-backoff-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(agentDir, { recursive: true, force: true });
});

const pendingDir = () => join(agentDir, "pi-blackhole");

describe("backoff persistence (F5)", () => {
  it("round-trips backoff state through the pending file", () => {
    const now = Date.now();
    writeBackoffState("s1", {
      lastConsolidationErrorAt: now,
      midRunCompactionSuspended: true,
    });
    expect(readBackoffState("s1")).toEqual({
      lastConsolidationErrorAt: now,
      midRunCompactionSuspended: true,
    });
  });

  it("keeps the pending file alive for backoff-only state", () => {
    writeBackoffState("s1", { midRunCompactionSuspended: true });
    // A backoff-only file must NOT be treated as empty and deleted.
    expect(existsSync(join(pendingDir(), "s1-pending.json"))).toBe(true);
    expect(readBackoffState("s1")).toEqual({
      midRunCompactionSuspended: true,
    });
  });

  it("preserves cursors when writing backoff and vice versa", () => {
    const now = Date.now();
    const runtime = new Runtime();
    runtime.cursors.observer = { entryId: "e1", state: "recorded" };
    runtime.lastConsolidationErrorAt = now;
    runtime.saveCursorsToPending("s1");

    // Fresh runtime (simulating restart) hydrates both from disk.
    const fresh = new Runtime();
    fresh.loadCursorsFromPending("s1");
    expect(fresh.cursors.observer).toEqual({
      entryId: "e1",
      state: "recorded",
    });
    expect(fresh.lastConsolidationErrorAt).toBe(now);
  });

  it("hydrates midRunCompactionSuspended on load", () => {
    const runtime = new Runtime();
    runtime.midRunCompactionSuspended = true;
    runtime.persistBackoff("s1");

    const fresh = new Runtime();
    fresh.loadCursorsFromPending("s1");
    expect(fresh.midRunCompactionSuspended).toBe(true);
  });

  it("does not hydrate when no backoff was persisted", () => {
    const fresh = new Runtime();
    fresh.lastConsolidationErrorAt = 42;
    fresh.midRunCompactionSuspended = true;
    fresh.loadCursorsFromPending("s1");
    // In-memory values are untouched (nothing on disk to hydrate from).
    expect(fresh.lastConsolidationErrorAt).toBe(42);
    expect(fresh.midRunCompactionSuspended).toBe(true);
  });

  it("writes valid JSON containing both cursors and backoff", () => {
    const runtime = new Runtime();
    runtime.cursors.observer = { entryId: "e1", state: "recorded" };
    runtime.midRunCompactionSuspended = true;
    runtime.saveCursorsToPending("s1");
    const raw = readFileSync(join(pendingDir(), "s1-pending.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.cursors.observer.entryId).toBe("e1");
    expect(parsed.backoff.midRunCompactionSuspended).toBe(true);
  });
});
