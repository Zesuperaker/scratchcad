import { describe, expect, it } from "vitest";
import {
  checkParams,
  formatValue,
  humanize,
  niceStep,
  parseParams,
  setParam,
  stableRanges,
} from "../src/shared/params.ts";

const SCRIPT = `// region: center=[0, 0, 0] half_size=40
// # Thread
let thread_length = 26.0; // [10, 60] Thread length (mm)
let blade_count = 29; // [3, 60] Number of blades
// #   Body and head  
let offset = -2.5;
let flat = 0;  //   just a label
  let indented = 3.0;
let expr = 2.0 * 3.0;
let name = "bolt";
draw(sphere(#{ radius: thread_length }));
`;

describe("parseParams", () => {
  const params = parseParams(SCRIPT);

  it("finds top-level numeric lets only", () => {
    expect(params.map((p) => p.name)).toEqual(["thread_length", "blade_count", "offset", "flat"]);
  });

  it("reads range, label, kind, section and line", () => {
    expect(params[0]).toMatchObject({
      value: 26,
      integer: false,
      min: 10,
      max: 60,
      step: 0.2,
      ranged: true,
      label: "Thread length (mm)",
      section: "Thread",
      line: 3,
    });
    expect(params[1]).toMatchObject({ value: 29, integer: true, step: 1, min: 3, max: 60 });
    expect(params[3]).toMatchObject({
      label: "just a label",
      min: -10,
      max: 10,
      ranged: false,
      section: "Body and head",
    });
  });

  it("guesses a range around the value, and labels from the name", () => {
    expect(params[2]).toMatchObject({ min: -5, max: 0, label: "Offset", ranged: false });
    expect(parseParams("let a = 4.0; // [9, 1]")[0]).toMatchObject({ min: 1, max: 9 });
    expect(parseParams("let r = 5.0;")[0]).toMatchObject({ min: 0, max: 10, step: 0.05 });
  });

  it("points at the literal, with Windows line endings too", () => {
    for (const p of params) expect(Number(SCRIPT.slice(p.from, p.to))).toBe(p.value);
    const crlf = SCRIPT.replace(/\n/g, "\r\n");
    for (const p of parseParams(crlf)) expect(Number(crlf.slice(p.from, p.to))).toBe(p.value);
  });
});

describe("humanize", () => {
  it.each([
    ["thread_length", "Thread length"],
    ["M10", "M10"],
    ["__x__y", "X y"],
  ])("%s -> %s", (name, label) => {
    expect(humanize(name)).toBe(label);
  });
});

describe("stableRanges", () => {
  it("keeps a guessed range from the baseline while the value moves", () => {
    const baseline = parseParams("let r = 5.0;\nlet n = 3; // [1, 9] Count");
    const dragged = parseParams("let r = 8.0;\nlet n = 4; // [1, 9] Count");
    expect(dragged[0]).toMatchObject({ min: 0, max: 16 }); // what would move the thumb
    const stable = stableRanges(dragged, baseline);
    expect(stable[0]).toMatchObject({ value: 8, min: 0, max: 10, step: 0.05 });
    expect(stable[1]).toBe(dragged[1]); // explicit ranges come from the script
  });

  it("widens to fit a value typed outside the range, and leaves new parameters alone", () => {
    const baseline = parseParams("let r = 5.0;");
    const typed = parseParams("let r = 25.0;\nlet k = 2;");
    const stable = stableRanges(typed, baseline);
    expect(stable[0]).toMatchObject({ min: 0, max: 25 });
    expect(stable[1]).toBe(typed[1]);
  });
});

describe("setParam", () => {
  it("rewrites only the literal, keeping its kind", () => {
    const [length, count] = parseParams(SCRIPT);
    expect(setParam(SCRIPT, length!, 30)).toContain(
      "let thread_length = 30.0; // [10, 60] Thread length (mm)\n",
    );
    const more = setParam(SCRIPT, count!, 31.6);
    expect(more).toContain("let blade_count = 32; // [3, 60]");
    expect(parseParams(more)).toHaveLength(4);
  });
});

describe("formatValue", () => {
  it.each([
    [26, { integer: false, step: 0.2 }, "26.0"],
    [26.25, { integer: false, step: 0.01 }, "26.25"],
    [26.123456, { integer: false, step: 0.001 }, "26.123"],
    [0.1 + 0.2, { integer: false, step: 0.1 }, "0.3"],
    [-3, { integer: false, step: 5 }, "-3.0"],
    [7.4, { integer: true, step: 1 }, "7"],
  ])("%d -> %s", (value, param, expected) => {
    expect(formatValue(value, param)).toBe(expected);
  });
});

describe("niceStep", () => {
  it.each([
    [0.25, 0.2],
    [0.07, 0.05],
    [3, 2],
    [0.01, 0.01],
    [120, 100],
    [0, 1],
  ])("%d -> %d", (raw, step) => {
    expect(niceStep(raw)).toBe(step);
  });
});

describe("checkParams", () => {
  it("asks for parameters when there are none", () => {
    expect(checkParams([])).toEqual([expect.stringContaining("no parameters")]);
  });

  it("is quiet about well-formed parameters", () => {
    expect(checkParams(parseParams("let width = 20.0; // [5, 50] Width (mm)"))).toEqual([]);
  });

  it("names each problem", () => {
    const notes = checkParams(
      parseParams(
        [
          "let width = 20.0; // Width (mm)",
          "let depth = 80.0; // [5, 50] Depth (mm)",
          "let height = 5.0; // [5, 5] Height (mm)",
          "let wall = 2.0; // [1, 4]",
        ].join("\n"),
      ),
    );
    expect(notes).toEqual([
      "width has no [min, max] range, so its slider guesses 0 to twice the value",
      "depth = 80 is outside its range [5, 50]",
      "height has an empty range [5, 5]",
      'wall has no label: add one after the range, with units, e.g. "Width (mm)"',
    ]);
  });
});
