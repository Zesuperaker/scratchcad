import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "./api/errors";
import { type FileEntry, readMesh, readScript, writeFile } from "./api/files";
import { mesh } from "./api/scratchcad";
import { FileList } from "./components/FileList";
import { ParamsPanel } from "./components/ParamsPanel";
import { ProblemsPanel } from "./components/ProblemsPanel";
import { RegionPanel } from "./components/RegionPanel";
import { CodeEditor } from "./editor/CodeEditor";
import { useFiles, usePreview } from "./hooks";
import { parseParams, setParam } from "./lib/params";
import { DEFAULT_REGION, parseRegion, regionAround, setRegion } from "../../src/shared/region.ts";
import { NEW_SCRIPT } from "./lib/template";
import type { MeshInfo } from "./viewport/Viewport";
import { ViewportView } from "./viewport/ViewportView";

type Open =
  | { kind: "script"; path: string; version: string; saved: string }
  | { kind: "mesh"; path: string; version: string; stl: ArrayBuffer };

interface Notice {
  id: number;
  tone: "info" | "error";
  text: string;
}

/** The file changed on disk while there were unsaved edits (or a save hit 409). */
interface Conflict {
  /** The version on disk now, or null if the file was deleted. */
  version: string | null;
}

const message = (e: unknown) =>
  e instanceof ApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);

export default function App() {
  const [open, setOpen] = useState<Open | null>(null);
  const [text, setText] = useState("");
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [tab, setTab] = useState<"params" | "region">("params");
  const [previewDepth, setPreviewDepth] = useState(7);
  const [exportDepth, setExportDepth] = useState(8);
  const [exporting, setExporting] = useState(false);
  const [meshInfo, setMeshInfo] = useState<MeshInfo | null>(null);
  // Versions of the open file this editor has loaded or written, so a poll
  // that raced with a save isn't mistaken for someone else's change.
  const seen = useRef(new Set<string>());
  // Whether a listing has shown the open file yet. Until then, its absence
  // means the listing predates the file (a new script), not a deletion.
  const listed = useRef(false);

  const script = open?.kind === "script" ? text : null;
  const dirty = open?.kind === "script" && text !== open.saved;
  const preview = usePreview(open?.path ?? null, script, previewDepth);
  const params = useMemo(() => (script === null ? [] : parseParams(script)), [script]);
  const recordedRegion = script === null ? null : parseRegion(script);
  const region = recordedRegion ?? DEFAULT_REGION;
  const clipped = preview.problems.some((p) => p.message.includes("reaches the boundary"));

  const notify = useCallback((tone: Notice["tone"], text: string) => {
    const id = Date.now() + Math.random();
    setNotices((n) => [...n, { id, tone, text }]);
    setTimeout(
      () => setNotices((n) => n.filter((x) => x.id !== id)),
      tone === "error" ? 8000 : 4000,
    );
  }, []);

  const load = useCallback(
    async (file: Pick<FileEntry, "path" | "kind"> & Partial<FileEntry>) => {
      try {
        if (file.kind === "script") {
          const { text, version } = await readScript(file.path);
          seen.current = new Set([version]);
          listed.current = false;
          setOpen({ kind: "script", path: file.path, version, saved: text });
          setText(text);
        } else {
          const stl = await readMesh(file.path);
          const version = file.version ?? "";
          seen.current = new Set([version]);
          listed.current = false;
          setOpen({ kind: "mesh", path: file.path, version, stl });
        }
        setConflict(null);
      } catch (e) {
        notify("error", `Could not open ${file.path}: ${message(e)}`);
      }
    },
    [notify],
  );

  // Keep ?open= in step with the open file, so reloading the page keeps it.
  const openPath = open?.path ?? null;
  useEffect(() => {
    const url = new URL(window.location.href);
    if (openPath) url.searchParams.set("open", openPath);
    else url.searchParams.delete("open");
    window.history.replaceState(null, "", url);
  }, [openPath]);

  const openFile = (file: FileEntry) => {
    if (file.path === open?.path) return;
    if (dirty && !window.confirm(`Discard unsaved changes to ${open.path}?`)) return;
    void load(file);
  };

  // React to changes on disk, usually the agent rewriting a script. The
  // handler reads the latest state through a ref, as polling outlives renders.
  const latest = useRef({ open, dirty, load, notify });
  useEffect(() => {
    latest.current = { open, dirty, load, notify };
  });
  // The file named in ?open= (save_script's editor link), opened once the
  // first listing arrives.
  const linked = useRef<string | null>(new URLSearchParams(window.location.search).get("open"));
  const onFiles = useCallback((listing: FileEntry[]) => {
    const { open, dirty, load, notify } = latest.current;
    if (linked.current !== null) {
      const wanted = listing.find((f) => f.path === linked.current);
      if (wanted) void load(wanted);
      else notify("error", `${linked.current} isn't in the output directory.`);
      linked.current = null;
      return;
    }
    if (!open) return;
    const entry = listing.find((f) => f.path === open.path);
    if (!entry) {
      if (listed.current) setConflict({ version: null });
      return;
    }
    listed.current = true;
    if (seen.current.has(entry.version)) return;
    seen.current.add(entry.version);
    if (open.kind === "script" && dirty) {
      setConflict({ version: entry.version });
    } else {
      notify("info", `Reloaded ${open.path}: it changed on disk.`);
      void load(entry);
    }
  }, []);
  const { files, error: filesError, refresh } = useFiles(onFiles);

  const save = useCallback(async () => {
    if (open?.kind !== "script") return;
    try {
      const entry = await writeFile(open.path, text, open.version);
      seen.current.add(entry.version);
      setOpen({ ...open, version: entry.version, saved: text });
      setConflict(null);
      refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setConflict({ version: e.current ?? null });
        notify("error", `Not saved: ${open.path} changed on disk. Choose which version to keep.`);
      } else {
        notify("error", `Could not save ${open.path}: ${message(e)}`);
      }
    }
  }, [open, text, notify, refresh]);

  const keepMine = () => {
    if (open?.kind !== "script" || !conflict) return;
    const version = conflict.version ?? "new";
    seen.current.add(version);
    setOpen({ ...open, version });
    setConflict(null);
  };

  const newScript = async () => {
    if (dirty && !window.confirm(`Discard unsaved changes to ${open.path}?`)) return;
    let name = window.prompt("Name of the new script", "part.rhai")?.trim();
    if (!name) return;
    if (!name.toLowerCase().endsWith(".rhai")) name += ".rhai";
    try {
      await writeFile(name, NEW_SCRIPT, "new");
      refresh();
      await load({ path: name, kind: "script" });
    } catch (e) {
      notify("error", `Could not create ${name}: ${message(e)}`);
    }
  };

  const exportStl = async () => {
    if (open?.kind !== "script") return;
    const path = open.path.replace(/\.rhai$/i, "") + ".stl";
    const exists = files?.some((f) => f.path === path) ?? false;
    if (exists && !window.confirm(`Replace ${path}?`)) return;
    setExporting(true);
    try {
      const result = await mesh({
        script: text,
        center: region.center,
        halfSize: region.halfSize,
        depth: exportDepth,
      });
      await writeFile(path, result.stl, exists ? null : "new");
      refresh();
      const triangles = result.triangles?.toLocaleString() ?? "?";
      notify("info", `Exported ${path} (${triangles} triangles).`);
      for (const warning of result.warnings) notify("error", `Warning: ${warning}`);
    } catch (e) {
      notify("error", `Export failed: ${message(e)}`);
    } finally {
      setExporting(false);
    }
  };

  // Ctrl/Cmd+S saves, and closing the tab warns about unsaved edits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [save, dirty]);

  const stl = open?.kind === "mesh" ? open.stl : preview.stl;
  const sourceScript =
    open?.kind === "mesh"
      ? files?.find((f) => f.path === open.path.replace(/\.stl$/i, "") + ".rhai")
      : undefined;
  const button =
    "rounded-md border border-zinc-300 px-3 py-1 text-sm font-medium hover:bg-zinc-100 " +
    "disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800";

  return (
    <div className="grid h-full grid-cols-1 grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[15rem_minmax(0,1fr)_minmax(0,1fr)]">
      <header className="col-span-full flex items-center gap-3 border-b border-zinc-200 bg-white px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="font-semibold">scratchcad</h1>
        <span className="truncate text-sm text-zinc-500">
          {open ? open.path : "No file open"}
          {dirty && <span title="Unsaved changes"> ●</span>}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            className={button}
            disabled={!dirty}
            onClick={() => void save()}
            title="Save (Ctrl+S)"
          >
            Save
          </button>
          <button
            type="button"
            className={`${button} border-blue-600 bg-blue-600 text-white hover:bg-blue-700 dark:hover:bg-blue-700`}
            disabled={open?.kind !== "script" || exporting}
            onClick={() => void exportStl()}
            title={`Mesh at detail ${exportDepth} and write an .stl next to the script`}
          >
            {exporting ? "Exporting…" : "Export STL"}
          </button>
        </div>
      </header>

      <FileList
        files={files}
        error={filesError}
        openPath={open?.path ?? null}
        onOpen={openFile}
        onNew={() => void newScript()}
      />

      <main className="flex min-h-[50vh] min-w-0 flex-col">
        {conflict && open?.kind === "script" && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 border-b border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          >
            <span className="mr-auto">
              {conflict.version
                ? `${open.path} changed on disk (perhaps the agent edited it) while you had unsaved changes.`
                : `${open.path} was deleted on disk.`}
            </span>
            {conflict.version && (
              <button type="button" className={button} onClick={() => void load(open)}>
                Load the version on disk
              </button>
            )}
            <button type="button" className={button} onClick={keepMine}>
              {conflict.version ? "Keep mine (overwrite on save)" : "Keep mine (recreate on save)"}
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1">
          {open?.kind === "script" ? (
            <CodeEditor
              docKey={open.path}
              value={text}
              onChange={setText}
              problems={preview.problems}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-zinc-500">
              {open?.kind === "mesh" ? (
                <div className="flex flex-col items-center gap-3">
                  <p>{open.path} is an exported mesh, so it can't be edited.</p>
                  {sourceScript && (
                    <button type="button" className={button} onClick={() => openFile(sourceScript)}>
                      Open {sourceScript.path}
                    </button>
                  )}
                </div>
              ) : (
                <p className="max-w-sm leading-relaxed">
                  Open a script on the left, or start a new one. Scripts the agent saves with
                  save_script appear there too, and update here when it changes them.
                </p>
              )}
            </div>
          )}
        </div>
        {open?.kind === "script" && (
          <ProblemsPanel
            problems={preview.problems}
            nodes={preview.nodes}
            computeMs={preview.computeMs}
            running={preview.running}
          />
        )}
      </main>

      <section className="flex min-h-[60vh] min-w-0 flex-col border-l border-zinc-200 dark:border-zinc-800">
        <div className="min-h-0 flex-1">
          <ViewportView
            stl={stl}
            fitKey={open?.path ?? null}
            stale={open?.kind === "script" && preview.stale}
            busy={preview.running}
            info={meshInfo}
            onInfo={setMeshInfo}
            onError={(text) => notify("error", text)}
          />
        </div>
        {open?.kind === "script" && (
          <div className="flex max-h-[45%] min-h-0 flex-col border-t border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <div
              role="tablist"
              className="flex gap-1 border-b border-zinc-200 px-2 pt-1.5 dark:border-zinc-800"
            >
              {(
                [
                  ["params", `Parameters (${params.length})`],
                  ["region", "Region & export"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => setTab(id)}
                  className="rounded-t-md px-3 py-1 text-xs font-medium text-zinc-500 aria-selected:bg-zinc-100 aria-selected:text-zinc-900 dark:aria-selected:bg-zinc-800 dark:aria-selected:text-zinc-100"
                >
                  {label}
                  {id === "region" && clipped && " ⚠"}
                </button>
              ))}
            </div>
            <div className="min-h-0 overflow-y-auto p-3">
              {tab === "params" ? (
                <ParamsPanel
                  params={params}
                  onChange={(param, value) => setText((t) => setParam(t, param, value))}
                />
              ) : (
                <RegionPanel
                  region={region}
                  recorded={recordedRegion !== null}
                  clipped={clipped}
                  previewDepth={previewDepth}
                  exportDepth={exportDepth}
                  canFit={meshInfo !== null && !preview.stale}
                  onRegion={(r) => setText((t) => setRegion(t, r))}
                  onFit={() =>
                    meshInfo &&
                    setText((t) => setRegion(t, regionAround(meshInfo.min, meshInfo.max)))
                  }
                  onPreviewDepth={setPreviewDepth}
                  onExportDepth={setExportDepth}
                />
              )}
            </div>
          </div>
        )}
      </section>

      <div className="pointer-events-none fixed right-4 bottom-4 z-10 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {notices.map((n) => (
          <div
            key={n.id}
            role="status"
            className={`pointer-events-auto rounded-md px-3 py-2 text-sm shadow-lg ${
              n.tone === "error"
                ? "bg-red-600 text-white"
                : "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
            }`}
          >
            {n.text}
          </div>
        ))}
      </div>
    </div>
  );
}
