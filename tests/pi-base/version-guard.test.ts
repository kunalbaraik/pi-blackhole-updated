import { describe, it, expect } from "vitest";
import {
  getPiRuntimeVersion,
  isVersionInRange,
} from "../../src/pi-base/version-guard.js";

describe("version guard (S5)", () => {
  it("accepts versions in range >=0.81.1 <1.0.0", () => {
    expect(isVersionInRange("0.81.1")).toBe(true);
    expect(isVersionInRange("0.81.2")).toBe(true);
    expect(isVersionInRange("0.82.0")).toBe(true);
    expect(isVersionInRange("0.99.99")).toBe(true);
  });

  it("rejects versions below 0.81.1", () => {
    expect(isVersionInRange("0.81.0")).toBe(false);
    expect(isVersionInRange("0.80.9")).toBe(false);
    expect(isVersionInRange("0.9.9")).toBe(false);
  });

  it("rejects 1.x (peer upper bound <1.0.0)", () => {
    expect(isVersionInRange("1.0.0")).toBe(false);
    expect(isVersionInRange("1.2.3")).toBe(false);
  });

  it("treats unknown/unparseable as in-range (don't alarm)", () => {
    expect(isVersionInRange(undefined)).toBe(true);
    expect(isVersionInRange("")).toBe(true);
    expect(isVersionInRange("dev")).toBe(true);
    expect(isVersionInRange("0.81")).toBe(true); // parseable prefix required
  });

  it("reads a version string from the installed Pi runtime (devDep 0.83.0)", () => {
    const v = getPiRuntimeVersion();
    expect(typeof v).toBe("string");
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
    // devDeps pin 0.83.0 → must be inside the supported range.
    expect(isVersionInRange(v)).toBe(true);
  });
});
