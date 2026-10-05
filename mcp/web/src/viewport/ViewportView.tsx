import { useEffect, useRef, useState } from "react";
import { type MeshInfo, Viewport } from "./Viewport";

interface Props {
  stl: ArrayBuffer | null;
  /** The camera reframes when this changes (e.g. a different file opens). */
  fitKey: string | null;
  stale: boolean;
  busy: boolean;
  /** What onInfo last reported, for the overlay. */
  info: MeshInfo | null;
  onInfo: (info: MeshInfo | null) => void;
  onError: (message: string) => void;
}

const fmt = (n: number) => Number(n.toPrecision(4)).toString();

export function ViewportView({ stl, fitKey, stale, busy, info, onInfo, onError }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const cubeCanvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<Viewport | null>(null);
  const fitted = useRef<string | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const [autoFit, setAutoFit] = useState(true);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    try {
      viewport.current = new Viewport(canvas.current!, cubeCanvas.current!);
    } catch (e) {
      onErrorRef.current(`3D view unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    return () => {
      viewport.current?.dispose();
      viewport.current = null;
      fitted.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewport.current;
    if (!view) return;
    let next: MeshInfo | null = null;
    if (stl) {
      try {
        next = view.show(stl, fitted.current !== fitKey ? "reset" : "follow");
        fitted.current = fitKey;
      } catch (e) {
        onErrorRef.current(
          `Could not show the mesh: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } else {
      view.clear();
    }
    onInfo(next);
  }, [stl, fitKey, onInfo]);

  useEffect(() => viewport.current?.setStale(stale), [stale]);
  useEffect(() => viewport.current?.setWireframe(wireframe), [wireframe]);
  useEffect(() => viewport.current?.setAutoFit(autoFit), [autoFit]);

  const size = info && info.max.map((hi, i) => fmt(hi - info.min[i]!)).join(" × ");
  const button =
    "rounded-md border border-zinc-300 bg-white/90 px-2.5 py-1 text-xs font-medium shadow-sm " +
    "hover:bg-white dark:border-zinc-700 dark:bg-zinc-900/90 dark:hover:bg-zinc-800";

  return (
    <div className="relative h-full min-h-0 bg-zinc-100 dark:bg-zinc-900">
      <canvas ref={canvas} className="block h-full w-full" />
      <canvas
        ref={cubeCanvas}
        title="Click a face, edge or corner to look from that side"
        className="absolute top-2 right-2 h-[120px] w-[120px]"
      />
      <div className="absolute right-3 bottom-3 flex gap-2">
        <button
          type="button"
          aria-pressed={autoFit}
          onClick={() => setAutoFit((a) => !a)}
          title="Keep the whole part in view as it changes"
          className={`${button} ${autoFit ? "border-blue-500 text-blue-600 dark:text-blue-400" : ""}`}
        >
          Auto-fit
        </button>
        <button
          type="button"
          aria-pressed={wireframe}
          onClick={() => setWireframe((w) => !w)}
          className={`${button} ${wireframe ? "border-blue-500 text-blue-600 dark:text-blue-400" : ""}`}
        >
          Wireframe
        </button>
        <button type="button" onClick={() => viewport.current?.frame()} className={button}>
          Reset view
        </button>
      </div>
      <div className="absolute bottom-3 left-3 flex flex-col gap-0.5 rounded-md bg-white/90 px-2.5 py-1.5 text-xs text-zinc-600 tabular-nums shadow-sm dark:bg-zinc-900/90 dark:text-zinc-400">
        {busy && <span className="text-blue-600 dark:text-blue-400">Meshing…</span>}
        {info && <span>{info.triangles.toLocaleString()} triangles</span>}
        {size && <span>size {size}</span>}
        {stale && <span className="text-amber-600 dark:text-amber-400">Out of date</span>}
        {!busy && !info && <span>No mesh</span>}
      </div>
    </div>
  );
}
