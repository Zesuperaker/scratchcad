import { useEffect, useRef, useState } from "react";
import { ApiError } from "./api/errors";
import { type FileEntry, listFiles } from "./api/files";
import { mesh, validate } from "./api/scratchcad";
import { problem, type Problem } from "./lib/problems";
import { DEFAULT_REGION, parseRegion } from "../../src/shared/region.ts";

const POLL_MS = 2000;
const PREVIEW_DELAY_MS = 300;

/**
 * The output directory's files, polled so agent changes show up. `onChange`
 * is called with each new listing.
 */
export function useFiles(onChange: (files: FileEntry[]) => void) {
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let last = "";
    const poll = async () => {
      try {
        const next = await listFiles();
        const key = JSON.stringify(next);
        if (!cancelled && key !== last) {
          last = key;
          setFiles(next);
          onChangeRef.current(next);
        }
        if (!cancelled) setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tick]);

  return { files, error, refresh: () => setTick((t) => t + 1) };
}

export interface Preview {
  /** Which document this preview belongs to. */
  key: string | null;
  running: boolean;
  /** The last mesh that built; kept while the script has errors. */
  stl: ArrayBuffer | null;
  /** True when `stl` is from an earlier version of the script. */
  stale: boolean;
  triangles: number | null;
  computeMs: number | null;
  nodes: number | null;
  problems: Problem[];
}

const EMPTY: Preview = {
  key: null,
  running: false,
  stl: null,
  stale: false,
  triangles: null,
  computeMs: null,
  nodes: null,
  problems: [],
};

/**
 * Validates and meshes the script a moment after it stops changing. `key`
 * names the document (its path): a preview for another key is never returned,
 * so switching files never shows the previous file's mesh.
 */
export function usePreview(key: string | null, script: string | null, depth: number): Preview {
  const [preview, setPreview] = useState<Preview>(EMPTY);

  useEffect(() => {
    if (script === null) return;
    const controller = new AbortController();
    const { signal } = controller;
    const timer = setTimeout(async () => {
      setPreview((p) =>
        p.key === key ? { ...p, running: true } : { ...EMPTY, key, running: true },
      );
      // Kept for the catch: a script can validate and then fail to mesh.
      let checked: Awaited<ReturnType<typeof validate>> | null = null;
      try {
        checked = await validate(script, signal);
        const region = parseRegion(script) ?? DEFAULT_REGION;
        const result = await mesh(
          { script, center: region.center, halfSize: region.halfSize, depth },
          signal,
        );
        setPreview({
          key,
          running: false,
          stl: result.stl,
          stale: false,
          triangles: result.triangles,
          computeMs: result.computeMs,
          nodes: checked.nodes,
          problems: [
            ...checked.output.map((line) => problem("info", line)),
            ...result.warnings.map((warning) => problem("warning", warning)),
          ],
        });
      } catch (e) {
        if (signal.aborted) return;
        const message = e instanceof ApiError ? `${e.code}: ${e.message}` : String(e);
        setPreview((p) => ({
          ...p,
          key,
          running: false,
          stale: p.stl !== null,
          nodes: checked ? checked.nodes : p.nodes,
          problems: [
            ...(checked?.output ?? []).map((line) => problem("info", line)),
            problem("error", message),
          ],
        }));
      }
    }, PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, script, depth]);

  if (script === null || preview.key !== key) return { ...EMPTY, key };
  return preview;
}
