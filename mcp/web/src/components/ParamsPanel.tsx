import { useState } from "react";
import { formatValue, type Param } from "../../../src/shared/params.ts";

interface Props {
  params: Param[];
  onChange: (param: Param, value: number) => void;
}

const fmt = (n: number) => Number(n.toPrecision(6)).toString();

function ParamRow({ param, onChange }: { param: Param; onChange: (value: number) => void }) {
  // The text box keeps its own draft so "-" or "1." can be typed on the way
  // to a number; it resyncs when the value changes elsewhere.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? formatValue(param.value, param);
  const id = `param-${param.name}`;

  return (
    <div className="flex flex-col gap-1" title={`${param.name} (line ${param.line} of the script)`}>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="min-w-0 text-sm leading-tight">
          {param.label}
        </label>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          value={shown}
          onChange={(e) => {
            setDraft(e.target.value);
            const value = Number(e.target.value);
            if (e.target.value.trim() !== "" && Number.isFinite(value)) onChange(value);
          }}
          onBlur={() => setDraft(null)}
          className="w-20 shrink-0 rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-right text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-950"
        />
      </div>
      <input
        type="range"
        aria-label={param.label}
        min={param.min}
        max={param.max}
        step={param.step}
        value={Math.min(Math.max(param.value, param.min), param.max)}
        onChange={(e) => {
          setDraft(null);
          onChange(Number(e.target.value));
        }}
        className="w-full accent-blue-600"
      />
      <div className="flex justify-between text-[11px] text-zinc-400 tabular-nums">
        <span>{fmt(param.min)}</span>
        <span>{fmt(param.max)}</span>
      </div>
    </div>
  );
}

/** The script's parameters as labelled sliders, grouped by `// # Section` lines. */
export function ParamsPanel({ params, onChange }: Props) {
  if (params.length === 0) {
    return (
      <p className="text-sm leading-relaxed text-zinc-500">
        This script has no adjustable dimensions yet. Ask the agent to add some, or open the script
        and add lines like{" "}
        <code className="font-mono text-xs">let width = 20.0; // [5, 50] Width (mm)</code>.
      </p>
    );
  }
  const sections: { title: string; params: Param[] }[] = [];
  for (const param of params) {
    const last = sections.at(-1);
    if (last && last.title === param.section) last.params.push(param);
    else sections.push({ title: param.section, params: [param] });
  }
  return (
    <div className="flex flex-col gap-5">
      {sections.map((section, i) => (
        <section key={`${i}-${section.title}`} className="flex flex-col gap-4">
          {section.title && (
            <h3 className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">
              {section.title}
            </h3>
          )}
          {section.params.map((param) => (
            <ParamRow key={param.name} param={param} onChange={(v) => onChange(param, v)} />
          ))}
        </section>
      ))}
    </div>
  );
}
