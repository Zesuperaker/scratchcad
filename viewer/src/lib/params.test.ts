import { describe, expect, it } from "vitest";
import { formatValue, niceStep, parseParams, setParam } from "./params";

const SCRIPT = `// region: center=[0, 0, 0] half_size=40
let thread_length = 26.0; // [10, 60] Thread length (mm)
let blade_count = 29; // [3, 60] Number of blades
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

  it("reads range, label and kind", () => {
    expect(params[0]).toMatchObject({
      value: 26,
      integer: false,
      min: 10,
      max: 60,
      step: 0.2,
      label: "Thread length (mm)",
    });
    expect(params[1]).toMatchObject({ value: 29, integer: true, step: 1, min: 3, max: 60 });
    expect(params[3]).toMatchObject({ label: "just a label", min: -10, max: 10 });
  });

  it("defaults the range around the value", () => {
    expect(params[2]).toMatchObject({ min: -5, max: 0, label: "" });
    expect(parseParams("let a = 4.0; // [9, 1]")[0]).toMatchObject({ min: 1, max: 9 });
    expect(parseParams("let r = 5.0;")[0]).toMatchObject({ min: 0, max: 10, step: 0.05 });
  });

  it("points at the literal", () => {
    for (const p of params) {
      expect(Number(SCRIPT.slice(p.from, p.to))).toBe(p.value);
    }
  });
});

describe("setParam", () => {
  it("rewrites only the literal, keeping its kind", () => {
    const [length, count] = parseParams(SCRIPT);
    const longer = setParam(SCRIPT, length!, 30);
    expect(longer).toContain("let thread_length = 30.0; // [10, 60] Thread length (mm)\n");
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
  ])("%d -> %d", (raw, step) => {
    expect(niceStep(raw)).toBe(step);
  });
});
