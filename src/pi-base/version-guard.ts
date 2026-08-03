/**
 * Version guard — S5.
 *
 * pi-blackhole hand-replicates Pi-internal cut logic and reads private
 * registry fields (peer range `>=0.81.1 <1.0.0`). If Pi's runtime drifts
 * outside that range, behavior may silently change. Warn once per process
 * on the first session_start instead of failing mysteriously later.
 *
 * Version detection is best-effort: @earendil-works/pi-coding-agent does not
 * export ./package.json and its exports map has no require condition, so we
 * walk up the filesystem from this extension's own location looking for
 * node_modules/@earendil-works/pi-coding-agent/package.json. In a compiled
 * binary build this may fail — then the guard degrades silently (unknown
 * version = no alarm).
 */
import { dirname, join } from "path";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";

const MIN_VERSION = [0, 81, 1] as const;
const MAX_VERSION = [1, 0, 0] as const;

/** Read the installed Pi runtime version, or undefined when not detectable. */
export function getPiRuntimeVersion(): string | undefined {
  try {
    const start = dirname(fileURLToPath(import.meta.url));
    let dir = start;
    for (let i = 0; i < 16; i++) {
      const pkgPath = join(
        dir,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "package.json",
      );
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          version?: string;
        };
        return pkg.version;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function parseVersion(v: string): number[] | undefined {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmp(a: number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** True when the version satisfies `>=0.81.1 <1.0.0`. Unknown → true (don't alarm). */
export function isVersionInRange(v?: string): boolean {
  const p = parseVersion(v ?? "");
  if (!p) return true;
  return cmp(p, MIN_VERSION) >= 0 && cmp(p, MAX_VERSION) < 0;
}
