// The output directory as a workspace of Rhai scripts and STL meshes.
//
// The save_script / read_script / export_stl tools and the editor's file API
// share these path rules: only .rhai and .stl files, only inside the output
// directory, with symlinks followed before the check.
import fs from "node:fs";
import path from "node:path";
import { formatRegion, parseRegion, type Region, setRegion } from "./shared/region.ts";

export const SCRIPT = ".rhai";
export const MESH = ".stl";
export type Kind = "script" | "mesh";
const KINDS: Record<string, Kind> = { [SCRIPT]: "script", [MESH]: "mesh" };

/** A path or file the workspace refuses; the message says why. */
export class WorkspaceError extends Error {
  override name = "WorkspaceError";
}

export interface Entry {
  /** Relative to the output directory, with forward slashes. */
  path: string;
  kind: Kind;
  bytes: number;
  /** Seconds since the epoch. */
  modified: number;
  /** Changes whenever the file is rewritten; used to detect edit conflicts. */
  version: string;
}

/**
 * The real path of `target`, following symlinks, including dangling ones and
 * paths that don't exist yet (like Python's Path.resolve(strict=False)).
 */
export function realpath(target: string, depth = 0): string {
  if (depth > 40) throw new WorkspaceError(`too many levels of symbolic links in ${target}`);
  try {
    return fs.realpathSync.native(target);
  } catch {
    const link = fs.lstatSync(target, { throwIfNoEntry: false });
    if (link?.isSymbolicLink()) {
      const next = path.resolve(path.dirname(target), fs.readlinkSync(target));
      return realpath(next, depth + 1);
    }
    // "/" always resolves, so this ends before running out of parents.
    return path.join(realpath(path.dirname(target), depth + 1), path.basename(target));
  }
}

/**
 * The absolute path for `relative` inside the output directory.
 *
 * Throws WorkspaceError if it is empty, leaves the directory (through `..`,
 * an absolute path or a symlink), has another suffix, or is a directory.
 */
export function resolve(outputDir: string, relative: string, suffixes: string[]): string {
  if (!relative.trim()) throw new WorkspaceError("path must not be empty");
  const root = realpath(outputDir);
  const target = realpath(path.resolve(root, relative));
  const inside = path.relative(root, target);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new WorkspaceError(`path must stay inside the output directory ${root}`);
  }
  if (!suffixes.includes(path.extname(target).toLowerCase())) {
    throw new WorkspaceError(`path must end in ${suffixes.join(" or ")}`);
  }
  if (fs.statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
    throw new WorkspaceError(`${target} is a directory`);
  }
  return target;
}

export function isFile(target: string): boolean {
  return fs.statSync(target, { throwIfNoEntry: false })?.isFile() ?? false;
}

export function version(target: string): string {
  const stat = fs.statSync(target, { bigint: true });
  return `${stat.mtimeNs}-${stat.size}`;
}

export function entry(outputDir: string, target: string): Entry {
  const stat = fs.statSync(target, { bigint: true });
  return {
    path: path.relative(realpath(outputDir), target).split(path.sep).join("/"),
    kind: KINDS[path.extname(target).toLowerCase()]!,
    bytes: Number(stat.size),
    modified: Number(stat.mtimeNs) / 1e9,
    version: `${stat.mtimeNs}-${stat.size}`,
  };
}

// The output directory defaults to the client's working directory, often a
// repository root, and the walk runs synchronously on a request: skip build
// and dependency trees and stop at a sane depth so a listing stays quick.
const SKIPPED_DIRS = new Set(["node_modules", "target"]);
const MAX_DEPTH = 8;

/**
 * Every script and mesh under the output directory, newest first. Hidden,
 * node_modules and target directories are skipped, as is anything nested more
 * than MAX_DEPTH directories down and symlinks that lead out of the directory.
 */
export function listFiles(outputDir: string): Entry[] {
  const root = realpath(outputDir);
  const entries: Entry[] = [];
  const walk = (directory: string, depth: number) => {
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return; // missing or unreadable: nothing to list
    }
    for (const child of children) {
      const full = path.join(directory, child.name);
      if (child.isDirectory()) {
        const skipped = child.name.startsWith(".") || SKIPPED_DIRS.has(child.name);
        if (!skipped && depth < MAX_DEPTH) walk(full, depth + 1);
        continue;
      }
      let target: string;
      try {
        target = resolve(root, path.relative(root, full), [SCRIPT, MESH]);
      } catch {
        continue;
      }
      if (isFile(target)) entries.push(entry(root, target));
    }
  };
  walk(root, 0);
  return entries.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
}

/** Writes the file atomically, so a reader never sees half of it. */
export function write(target: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, data);
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** The script with its region line replaced (or added) and one final newline. */
export function withRegion(script: string, region: Region): string {
  return `${setRegion(script, region).trimEnd()}\n`;
}

export { formatRegion, parseRegion, type Region };
