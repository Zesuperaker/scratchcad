import type { FileEntry } from "../api/files";

interface Props {
  files: FileEntry[] | null;
  error: string | null;
  openPath: string | null;
  onOpen: (file: FileEntry) => void;
  onNew: () => void;
}

function ago(seconds: number): string {
  const delta = Date.now() / 1000 - seconds;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)} min ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} h ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function Section({
  title,
  files,
  ...props
}: Omit<Props, "files" | "error" | "onNew"> & {
  title: string;
  files: FileEntry[];
}) {
  return (
    <section>
      <h2 className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
        {title}
      </h2>
      {files.length === 0 && <p className="px-3 py-1 text-xs text-zinc-500">None yet</p>}
      <ul>
        {files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              onClick={() => props.onOpen(file)}
              aria-current={file.path === props.openPath}
              className="block w-full px-3 py-1.5 text-left hover:bg-zinc-100 aria-[current=true]:bg-blue-100 dark:hover:bg-zinc-800 dark:aria-[current=true]:bg-blue-950"
            >
              <span className="block truncate text-sm" title={file.path}>
                {file.path}
              </span>
              <span className="block text-[11px] text-zinc-500">
                {size(file.bytes)} · {ago(file.modified)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function FileList({ files, error, openPath, onOpen, onNew }: Props) {
  return (
    <aside className="flex min-h-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <span className="text-sm font-semibold">Files</span>
        <button
          type="button"
          onClick={onNew}
          className="rounded-md bg-blue-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-blue-700"
        >
          New script
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {error && (
          <p className="m-3 rounded-md bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
            Can't reach the MCP server's file API: {error}
          </p>
        )}
        {files === null && !error && <p className="p-3 text-xs text-zinc-500">Loading…</p>}
        {files && (
          <>
            <Section
              title="Scripts"
              files={files.filter((f) => f.kind === "script")}
              openPath={openPath}
              onOpen={onOpen}
            />
            <Section
              title="Meshes"
              files={files.filter((f) => f.kind === "mesh")}
              openPath={openPath}
              onOpen={onOpen}
            />
          </>
        )}
      </div>
    </aside>
  );
}
