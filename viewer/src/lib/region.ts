// The region a script is meshed in, recorded on its first line by the MCP
// server's save_script tool (and by this editor):
//
//   // region: center=[0, 0, 0] half_size=30
//
// Keep the format in sync with mcp/src/scratchcad_mcp/workspace.py.

export type Vec3 = [number, number, number];

export interface Region {
  center: Vec3;
  halfSize: number;
}

export const DEFAULT_REGION: Region = { center: [0, 0, 0], halfSize: 1 };

const REGION =
  /^\/\/\s*region:\s*center=\[\s*([^\],]+),\s*([^\],]+),\s*([^\],]+)\]\s+half_size=(\S+)\s*$/;

/** The region on the script's first line, or null if it has none. */
export function parseRegion(script: string): Region | null {
  const first = script.split("\n", 1)[0]!.trim();
  const match = REGION.exec(first);
  if (!match) return null;
  const [x, y, z, halfSize] = match.slice(1).map((group) => Number(group.trim()));
  if (![x, y, z, halfSize].every((n) => Number.isFinite(n))) return null;
  return { center: [x!, y!, z!], halfSize: halfSize! };
}

export function formatRegion(region: Region): string {
  const center = region.center.map(String).join(", ");
  return `// region: center=[${center}] half_size=${region.halfSize}`;
}

/** The script with its region line replaced, or added if it has none. */
export function setRegion(script: string, region: Region): string {
  const line = formatRegion(region);
  if (parseRegion(script) === null) return `${line}\n${script}`;
  const end = /\r?\n/.exec(script);
  return end ? line + script.slice(end.index) : line;
}

/** A region that encloses a bounding box with a little margin. */
export function regionAround(min: Vec3, max: Vec3, margin = 1.1): Region {
  const half = Math.max(...min.map((lo, i) => (max[i]! - lo) / 2));
  const halfSize = roundNice(Math.max(half * margin, 1e-3), "up");
  // Snap the center to a hundredth of the region, so a mesh that is centered
  // up to float noise gets center 0 rather than -0.00000477.
  const grid = 10 ** Math.floor(Math.log10(halfSize / 100));
  const center = min.map((lo, i) => {
    const snapped = Math.round((lo + max[i]!) / 2 / grid) * grid;
    return Number(snapped.toPrecision(6)) + 0; // + 0 turns -0 into 0
  }) as Vec3;
  return { center, halfSize };
}

/** Rounds to 3 significant figures, so region lines stay readable. */
export function roundNice(value: number, direction: "nearest" | "up" = "nearest"): number {
  if (value === 0) return 0;
  const scale = 10 ** (Math.floor(Math.log10(Math.abs(value))) - 2);
  const round = direction === "up" ? Math.ceil : Math.round;
  return Number((round(value / scale) * scale).toPrecision(3));
}
