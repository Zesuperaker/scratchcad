// Parameters are the top-level `let` lines of a script that assign a number,
// optionally followed by a comment with a range and a label. Comment lines
// starting with `// #` above them start a section:
//
//   // # Thread
//   let thread_length = 26.0; // [10, 60] Thread length (mm)
//   let blade_count = 29; // [3, 60] Number of blades
//
// The editor shows them as labelled sliders and rewrites only the number
// literal, so the rest of the line (and the user's formatting) is left alone.
// save_script uses checkParams() to tell the model what its sliders will look
// like. Both the server and the editor use this module.

export interface Param {
  name: string;
  value: number;
  /** Rhai is strict about int vs float, so the literal keeps its kind. */
  integer: boolean;
  min: number;
  max: number;
  step: number;
  /** Whether the script gave the range, rather than it being guessed. */
  ranged: boolean;
  /** What the user sees: the comment's label, or the name made readable. */
  label: string;
  /** The `// # Section` the parameter is under, or "" before any. */
  section: string;
  /** 1-based line number. */
  line: number;
  /** Offsets of the number literal in the script. */
  from: number;
  to: number;
}

const NUMBER = String.raw`-?\d+(?:\.\d+)?`;
const PARAM = new RegExp(
  String.raw`^(let\s+([A-Za-z_]\w*)\s*=\s*)(${NUMBER})\s*;[ \t]*` +
    String.raw`(?://[ \t]*(?:\[\s*(${NUMBER})\s*,\s*(${NUMBER})\s*\])?[ \t]*(.*?))?\s*$`,
);
const SECTION = /^\/\/\s*#\s*(.*?)\s*$/;

/** `thread_length` -> "Thread length". */
export function humanize(name: string): string {
  const words = name.replace(/_+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function parseParams(script: string): Param[] {
  const params: Param[] = [];
  let offset = 0;
  let section = "";
  script.split("\n").forEach((rawLine, index) => {
    const line = rawLine.replace(/\r$/, "");
    const heading = SECTION.exec(line);
    if (heading) section = heading[1]!;
    const match = PARAM.exec(line);
    if (match) {
      const [, prefix, name, literal, lo, hi, label] = match as unknown as string[];
      const value = Number(literal);
      const integer = !literal!.includes(".");
      const ranged = lo !== undefined && hi !== undefined;
      const [min, max] = ranged
        ? [Math.min(Number(lo), Number(hi)), Math.max(Number(lo), Number(hi))]
        : defaultRange(value);
      const from = offset + prefix!.length;
      params.push({
        name: name!,
        value,
        integer,
        min,
        max,
        step: stepFor(min, max, integer),
        ranged,
        label: label || humanize(name!),
        section,
        line: index + 1,
        from,
        to: from + literal!.length,
      });
    }
    offset += rawLine.length + 1;
  });
  return params;
}

/**
 * Keeps sliders still while they're dragged. A parameter without a range
 * gets one guessed from its value, which would move with every change and
 * leave the thumb in the middle; this takes that guess from `baseline` (the
 * script as it was opened or saved) instead, widened to fit the value.
 */
export function stableRanges(current: Param[], baseline: Param[]): Param[] {
  const before = new Map(baseline.map((p) => [p.name, p]));
  return current.map((param) => {
    const old = before.get(param.name);
    if (param.ranged || !old) return param;
    const min = Math.min(old.min, param.value);
    const max = Math.max(old.max, param.value);
    return { ...param, min, max, step: stepFor(min, max, param.integer) };
  });
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

/**
 * Problems with a script's parameters that would make its sliders hard to
 * use, written for the model (save_script returns them).
 */
export function checkParams(params: Param[]): string[] {
  if (params.length === 0) {
    return [
      "the script has no parameters, so the user gets no sliders: put the main dimensions in " +
        "top-level lines like `let width = 20.0; // [5, 50] Width (mm)`",
    ];
  }
  const notes: string[] = [];
  for (const p of params) {
    if (!p.ranged) {
      notes.push(`${p.name} has no [min, max] range, so its slider guesses 0 to twice the value`);
    } else if (p.value < p.min || p.value > p.max) {
      notes.push(`${p.name} = ${p.value} is outside its range [${p.min}, ${p.max}]`);
    } else if (p.min === p.max) {
      notes.push(`${p.name} has an empty range [${p.min}, ${p.max}]`);
    }
    if (p.label === humanize(p.name)) {
      notes.push(`${p.name} has no label: add one after the range, with units, e.g. "Width (mm)"`);
    }
  }
  return notes;
}

function defaultRange(value: number): [number, number] {
  if (value === 0) return [-10, 10];
  return value > 0 ? [0, value * 2] : [value * 2, 0];
}

function stepFor(min: number, max: number, integer: boolean): number {
  return integer ? 1 : niceStep((max - min) / 200);
}

/** The largest 1, 2 or 5 times a power of ten not above `raw`. */
export function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [5, 2, 1].map((m) => m * power).find((s) => s <= raw)!;
  return Number(step.toPrecision(1));
}
