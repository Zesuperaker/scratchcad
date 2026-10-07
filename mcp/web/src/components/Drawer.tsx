import { type ReactNode, useEffect } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Tailwind width classes for the panel. */
  width: string;
  /** Dim what's behind and close on a click there or Escape. */
  modal?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}

/** A panel that slides in from the left edge of its (relative) container. */
export function Drawer({ open, onClose, title, width, modal = false, actions, children }: Props) {
  useEffect(() => {
    if (!open || !modal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, modal, onClose]);

  return (
    <>
      {modal && (
        <div
          aria-hidden
          onClick={onClose}
          className={`absolute inset-0 z-20 bg-zinc-950/25 transition-opacity duration-200 ${
            open ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        />
      )}
      <section
        aria-label={title}
        aria-hidden={!open}
        inert={!open}
        className={`absolute inset-y-0 left-0 z-30 flex max-w-full flex-col border-r border-zinc-200 bg-white transition-transform duration-200 ease-out dark:border-zinc-800 dark:bg-zinc-900 ${width} ${
          open ? "translate-x-0 shadow-2xl" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="ml-auto flex items-center gap-2">
            {actions}
            <button
              type="button"
              onClick={onClose}
              aria-label={`Close ${title.toLowerCase()}`}
              className="rounded-md px-2 py-0.5 text-lg leading-none text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              ×
            </button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </section>
    </>
  );
}
