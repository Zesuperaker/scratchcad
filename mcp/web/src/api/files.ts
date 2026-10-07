// The file API for the output directory, served by the same local process
// (scratchcad-mcp) that serves this page.
import { errorFrom } from "./errors";

const BASE = "/api/files";

export interface FileEntry {
  /** Relative to the output directory, with forward slashes. */
  path: string;
  kind: "script" | "mesh";
  bytes: number;
  /** Seconds since the epoch. */
  modified: number;
  /** Opaque; changes whenever the file is rewritten. */
  version: string;
}

export function fileUrl(path: string): string {
  return `${BASE}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

async function get(path: string): Promise<Response> {
  const response = await fetch(fileUrl(path), { cache: "no-store" });
  if (!response.ok) throw await errorFrom(response);
  return response;
}

export async function listFiles(signal?: AbortSignal): Promise<FileEntry[]> {
  const response = await fetch(BASE, { cache: "no-store", signal });
  if (!response.ok) throw await errorFrom(response);
  return (await response.json()) as FileEntry[];
}

export async function readScript(path: string): Promise<{ text: string; version: string }> {
  const response = await get(path);
  return { text: await response.text(), version: response.headers.get("x-version") ?? "" };
}

export async function readMesh(path: string): Promise<ArrayBuffer> {
  return (await get(path)).arrayBuffer();
}

/**
 * Writes a file. `expected` is the version last read, so a file changed since
 * (by the agent, say) is not overwritten: that throws an ApiError with status
 * 409 and the version on disk in `current`. Pass "new" to only create, or
 * null to overwrite unconditionally.
 */
export async function writeFile(
  path: string,
  body: string | ArrayBuffer,
  expected: string | null,
): Promise<FileEntry> {
  const response = await fetch(fileUrl(path), {
    method: "PUT",
    headers: expected === null ? {} : { "x-expected-version": expected },
    body,
  });
  if (!response.ok) throw await errorFrom(response);
  return (await response.json()) as FileEntry;
}
