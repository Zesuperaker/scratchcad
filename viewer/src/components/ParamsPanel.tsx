import { useState } from "react";
import { formatValue, type Param } from "../lib/params";

interface Props {
  params: Param[];
  onChange: (param: Param, value: number) => void;
}

function ParamRow({ param, onChange }: { param: Param; onChange: (value: number) => void }) {
  // The text box keeps its own draft so "-" or "1." can be typed on the way
  // to a number; it resyncs when the value changes elsewhere.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? formatValue(param.value, param);

  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1">
      <label htmlFor={`param-${param.name}`} className="min-w-0">
        <span className="block truncate font-mono text-xs">{param.name}</span>
        {param.label && (
          <span className="block truncate text-[11px] text-zinc-500">{param.label}</span>
        )}
      </label>
      <input
        id={`param-${param.name}`}
        type="text"
        inputMode="decimal"
        value={shown}
        onChange={(e) => {
          setDraft(e.target.value);
          const value = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(value)) onChange(value);
        }}
        onBlur={() => setDraft(null)}
        className="w-20 rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-right font-mono text-xs tabular-nums dark:border-zinc-700 dark:bg-zinc-950"
      />
      <input
        type="range"
        aria-label={param.name}
        min={param.min}
        max={param.max}
        step={param.step}
        value={Math.min(Math.max(param.value, param.min), param.max)}
        onChange={(e) => {
          setDraft(null);
          onChange(Number(e.target.value));
        }}
        className="col-span-2 w-full accent-blue-600"
      />
    </div>
  );
}

export function ParamsPanel({ params, onChange }: Props) {
  if (params.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-zinc-500">
        No parameters. Top-level lines like{" "}
        <code className="font-mono">let width = 20.0; // [5, 50] Width (mm)</code> show up here as
        sliders.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {params.map((param) => (
        <ParamRow key={param.name} param={param} onChange={(v) => onChange(param, v)} />
      ))}
    </div>
  );
}
