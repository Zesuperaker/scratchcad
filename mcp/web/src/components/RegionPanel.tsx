import type { Region, Vec3 } from "../../../src/shared/region.ts";

interface Props {
  region: Region;
  recorded: boolean;
  clipped: boolean;
  previewDepth: number;
  exportDepth: number;
  canFit: boolean;
  onRegion: (region: Region) => void;
  onFit: () => void;
  onPreviewDepth: (depth: number) => void;
  onExportDepth: (depth: number) => void;
}

const DEPTHS = [4, 5, 6, 7, 8, 9, 10];
const input =
  "w-full rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-right font-mono text-xs " +
  "tabular-nums dark:border-zinc-700 dark:bg-zinc-950";
const small =
  "rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 disabled:opacity-50 " +
  "dark:border-zinc-700 dark:hover:bg-zinc-800";

function NumberInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5 text-[11px] text-zinc-500">
      {label}
      <input
        type="number"
        className={input}
        value={value}
        step="any"
        onChange={(e) => {
          const next = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(next)) onChange(next);
        }}
      />
    </label>
  );
}

function DepthSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (depth: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded border border-zinc-300 bg-white px-1 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-950"
      >
        {DEPTHS.map((d) => (
          <option key={d} value={d}>
            {d} ({2 ** d} cells)
          </option>
        ))}
      </select>
    </label>
  );
}

export function RegionPanel(props: Props) {
  const { region, onRegion } = props;
  const setCenter = (axis: number, value: number) => {
    const center = [...region.center] as Vec3;
    center[axis] = value;
    onRegion({ ...region, center });
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-zinc-500">
        Meshing covers the cube center ± half size. It is stored on the script's first line.
        {!props.recorded && " This script has none yet, so the default is used."}
      </p>
      {props.clipped && (
        <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          The shape reaches the edge of the region, so it is cut off. Grow the region.
        </p>
      )}
      <div className="grid grid-cols-4 gap-2">
        {["x", "y", "z"].map((axis, i) => (
          <NumberInput
            key={axis}
            label={`center ${axis}`}
            value={region.center[i]!}
            onChange={(v) => setCenter(i, v)}
          />
        ))}
        <NumberInput
          label="half size"
          value={region.halfSize}
          onChange={(v) => v > 0 && onRegion({ ...region, halfSize: v })}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={small}
          onClick={() => onRegion({ ...region, halfSize: region.halfSize * 2 })}
        >
          Grow ×2
        </button>
        <button
          type="button"
          className={small}
          onClick={() => onRegion({ ...region, halfSize: region.halfSize / 2 })}
        >
          Shrink ×½
        </button>
        <button type="button" className={small} disabled={!props.canFit} onClick={props.onFit}>
          Fit to mesh
        </button>
      </div>
      <div className="flex flex-col gap-1.5 border-t border-zinc-200 pt-3 dark:border-zinc-800">
        <DepthSelect
          label="Preview detail"
          value={props.previewDepth}
          onChange={props.onPreviewDepth}
        />
        <DepthSelect
          label="Export detail"
          value={props.exportDepth}
          onChange={props.onExportDepth}
        />
      </div>
    </div>
  );
}
