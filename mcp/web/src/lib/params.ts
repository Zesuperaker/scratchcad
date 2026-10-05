// Parameters are the top-level `let` lines of a script that assign a number,
// optionally followed by a comment with a range and a label:
//
//   let thread_length = 26.0; // [10, 60] Thread length (mm)
//   let blade_count = 29; // [3, 60] Number of blades
//
// The editor shows them as sliders and rewrites only the number literal, so
// the rest of the line (and the user's formatting) is left alone.

export interface Param {
  name: string;
  value: number;
  /** Rhai is strict about int vs float, so the literal keeps its kind. */
  integer: boolean;
  min: number;
  max: number;
  step: number;
  label: string;
  /** Offsets of the number literal in the script. */
  from: number;
  to: number;
}

const NUMBER = String.raw`-?\d+(?:\.\d+)?`;
const PARAM = new RegExp(
  String.raw`^(let\s+([A-Za-z_]\w*)\s*=\s*)(${NUMBER})\s*;[ \t]*` +
    String.raw`(?://[ \t]*(?:\[\s*(${NUMBER})\s*,\s*(${NUMBER})\s*\])?[ \t]*(.*?))?\s*$`,
);

export function parseParams(script: string): Param[] {
  const params: Param[] = [];
  let offset = 0;
  for (const line of script.split("\n")) {
    const match = PARAM.exec(line);
    if (match) {
      const [, prefix, name, literal, lo, hi, label] = match as unknown as string[];
      const value = Number(literal);
      const integer = !literal!.includes(".");
      const [min, max] =
        lo !== undefined && hi !== undefined
          ? [Math.min(Number(lo), Number(hi)), Math.max(Number(lo), Number(hi))]
          : defaultRange(value);
      const from = offset + prefix!.length;
      params.push({
        name: name!,
        value,
        integer,
        min,
        max,
        step: integer ? 1 : niceStep((max - min) / 200),
        label: label ?? "",
        from,
        to: from + literal!.length,
      });
    }
    offset += line.length + 1;
  }
  return params;
}

/** The script with one parameter's literal replaced by `value`. */
export function setParam(script: string, param: Param, value: number): string {
  return script.slice(0, param.from) + formatValue(value, param) + script.slice(param.to);
}

/** A Rhai literal of the parameter's kind: `12` or `12.5` / `12.0`. */
export function formatValue(value: number, param: Pick<Param, "integer" | "step">): string {
  if (param.integer) return String(Math.round(value));
  const decimals = Math.max(1, Math.min(10, -Math.floor(Math.log10(param.step))));
  const text = value.toFixed(decimals).replace(/0+$/, "");
  return text.endsWith(".") ? `${text}0` : text;
}

function defaultRange(value: number): [number, number] {
  if (value === 0) return [-10, 10];
  return value > 0 ? [0, value * 2] : [value * 2, 0];
}

/** The largest 1, 2 or 5 times a power of ten not above `raw`. */
export function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [5, 2, 1].map((m) => m * power).find((s) => s <= raw)!;
  return Number(step.toPrecision(1));
}
