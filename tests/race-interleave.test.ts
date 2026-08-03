/**
 * F1 — consolidation↔compaction race stress suite.
 *
 * Both triggers register on turn_end (consolidation.ts:462, compaction-trigger.ts:104)
 * sharing one Runtime. When compaction fires mid-pipeline, the branch is
 * rewritten while stages run. Cursor advances must never reference entries a
 * compaction replaced: validateCursors is re-run against the post-compaction
 * branch at pipeline completion (before the flush).
 *
 * Zero interleaving coverage existed before this suite.
 */
import { describe, it, expect } from "vitest";
import { validateCursors } from "../src/om/consolidation.js";
import { Runtime } from "../src/om/runtime.js";
import {
  OM_OBSERVATIONS_RECORDED,
  OM_REFLECTIONS_RECORDED,
  OM_OBSERVATIONS_DROPPED,
} from "../src/om/ledger/types.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const msg = (id: string, role = "user") => ({
  id,
  type: "message",
  message: { role, content: "x" },
});
const compaction = (id: string) => ({ id, type: "compaction" });
const marker = (id: string, customType: string, coversUpToId: string) => ({
  id,
  type: "custom",
  customType,
  data:
    customType === OM_OBSERVATIONS_RECORDED
      ? { coversUpToId, observations: [{ id: "o1", text: "obs" }] }
      : customType === OM_REFLECTIONS_RECORDED
        ? { coversUpToId, reflections: [{ id: "r1", text: "refl" }] }
        : { coversUpToId, observationIds: ["o1"] },
});

function runtimeWith(
  cursors: Partial<{
    observer: { entryId: string; state: string };
    reflector: { entryId: string; state: string };
    dropper: { entryId: string; state: string };
  }>,
): Runtime {
  const r = new Runtime();
  r.cursors = cursors as Runtime["cursors"];
  return r;
}

// ── Scenarios ───────────────────────────────────────────────────────────────

describe("F1 race: validateCursors against post-compaction branches", () => {
  it("keeps cursors untouched when no compaction interleaved", () => {
    const entries = [
      marker("mark1", OM_OBSERVATIONS_RECORDED, "m2"),
      msg("m2", "user"),
      msg("m3", "assistant"),
      msg("m4", "user"),
    ];
    const runtime = runtimeWith({
      observer: { entryId: "m4", state: "recorded" },
    });
    validateCursors(entries, runtime);
    expect(runtime.cursors.observer).toEqual({
      entryId: "m4",
      state: "recorded",
    });
  });

  it("resets to the surviving OM marker when compaction removed the cursor entry", () => {
    // Pre-compaction: observer cursor at m4. Compaction fires mid-run; branch
    // rewritten. A post-compaction observer run left a marker covering the
    // new tail (m5) — the cursor falls back to it and re-observes.
    const postCompactionBranch = [
      compaction("c1"),
      msg("m5", "user"),
      marker("mark1", OM_OBSERVATIONS_RECORDED, "m5"),
    ];
    const runtime = runtimeWith({
      observer: { entryId: "m4", state: "recorded" },
    });
    validateCursors(postCompactionBranch, runtime);
    expect(runtime.cursors.observer).toEqual({
      entryId: "m5",
      state: "initial", // will re-observe from the marker forward
    });
  });

  it("deletes the cursor when compaction left no usable marker", () => {
    const postCompactionBranch = [compaction("c1"), msg("m5", "user")];
    const runtime = runtimeWith({
      observer: { entryId: "m4", state: "recorded" },
    });
    validateCursors(postCompactionBranch, runtime);
    expect(runtime.cursors.observer).toBeUndefined();
  });

  it("revalidates all three stages (observer/reflector/dropper)", () => {
    const postCompactionBranch = [
      compaction("c1"),
      msg("m5", "user"),
      marker("markObs", OM_OBSERVATIONS_RECORDED, "m5"),
      marker("markRef", OM_REFLECTIONS_RECORDED, "m5"),
      marker("markDrop", OM_OBSERVATIONS_DROPPED, "m5"),
    ];
    const runtime = runtimeWith({
      observer: { entryId: "m4", state: "recorded" },
      reflector: { entryId: "m4", state: "recorded" },
      dropper: { entryId: "m4", state: "recorded" },
    });
    validateCursors(postCompactionBranch, runtime);
    expect(runtime.cursors.observer).toEqual({
      entryId: "m5",
      state: "initial",
    });
    expect(runtime.cursors.reflector).toEqual({
      entryId: "m5",
      state: "initial",
    });
    expect(runtime.cursors.dropper).toEqual({
      entryId: "m5",
      state: "initial",
    });
  });

  it("converges after repeated interleaves (compaction churn)", () => {
    // Simulate: observe → compact → observe → compact, with each observer run
    // leaving a marker covering the then-current tail. Cursors stay valid and
    // converge to the newest coverage at every step.
    const branches = [
      // cycle 1 pre-compaction: cursor advanced to m4
      [
        marker("mark1", OM_OBSERVATIONS_RECORDED, "m2"),
        msg("m2"),
        msg("m3"),
        msg("m4"),
      ],
      // cycle 1 compaction + fresh observer marker covering new tail m5
      [
        compaction("c1"),
        msg("m5"),
        marker("mark2", OM_OBSERVATIONS_RECORDED, "m5"),
      ],
      // cycle 2: observer advanced to m6; marker covers m6
      [marker("mark3", OM_OBSERVATIONS_RECORDED, "m6"), msg("m6")],
      // cycle 2 compaction + fresh marker covering m7
      [
        compaction("c2"),
        msg("m7"),
        marker("mark4", OM_OBSERVATIONS_RECORDED, "m7"),
      ],
    ];

    const runtime = runtimeWith({
      observer: { entryId: "m4", state: "recorded" },
    });
    validateCursors(branches[0], runtime);
    expect(runtime.cursors.observer!.entryId).toBe("m4");

    // Compaction fired — cursor m4 is gone; falls back to mark2 (covers m5).
    validateCursors(branches[1], runtime);
    expect(runtime.cursors.observer).toEqual({
      entryId: "m5",
      state: "initial",
    });

    // Observer re-runs and advances to m6.
    runtime.cursors.observer = { entryId: "m6", state: "recorded" };
    validateCursors(branches[2], runtime);
    expect(runtime.cursors.observer!.entryId).toBe("m6");

    // Second compaction — cursor m6 gone; falls back to mark4 (covers m7).
    validateCursors(branches[3], runtime);
    expect(runtime.cursors.observer).toEqual({
      entryId: "m7",
      state: "initial",
    });
  });
});
