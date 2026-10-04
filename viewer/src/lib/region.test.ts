import { describe, expect, it } from "vitest";
import { formatRegion, parseRegion, regionAround, roundNice, setRegion } from "./region";

describe("parseRegion", () => {
  it.each([
    ["// region: center=[0, 0, 0] half_size=1", { center: [0, 0, 0], halfSize: 1 }],
    ["//region:center=[ -1.5 ,2,3e2] half_size=0.25  ", { center: [-1.5, 2, 300], halfSize: 0.25 }],
    ["// region: center=[1, 2] half_size=1", null],
    ["// region: center=[a, b, c] half_size=1", null],
    ["// region: center=[0, 0, 0]", null],
    ["let x = 1;", null],
  ])("%s", (line, region) => {
    expect(parseRegion(`${line}\ndraw(x);`)).toEqual(region);
  });

  it("reads a script that is only the region line", () => {
    expect(parseRegion("// region: center=[0, 0, 0] half_size=2")?.halfSize).toBe(2);
  });
});

describe("setRegion", () => {
  const region = { center: [0, 0, 1] as [number, number, number], halfSize: 2.5 };

  it("formats like the MCP server", () => {
    expect(formatRegion(region)).toBe("// region: center=[0, 0, 1] half_size=2.5");
  });

  it("adds a region line", () => {
    expect(setRegion("draw(x);\n", region)).toBe(`${formatRegion(region)}\ndraw(x);\n`);
  });

  it("replaces an existing region line, keeping the rest", () => {
    const old = "// region: center=[9, 9, 9] half_size=9\r\ndraw(x);\n";
    expect(setRegion(old, region)).toBe(`${formatRegion(region)}\r\ndraw(x);\n`);
    expect(setRegion("// region: center=[9, 9, 9] half_size=9", region)).toBe(formatRegion(region));
  });
});

describe("regionAround", () => {
  it("centers on the box and covers its largest half-extent with margin", () => {
    expect(regionAround([-10, 0, -2], [10, 4, 2])).toEqual({ center: [0, 2, 0], halfSize: 11 });
  });

  it("snaps float noise in the center away", () => {
    expect(regionAround([-12.5000048, -6.0000038, -7.5], [12.4999952, 5.9999962, 7.5])).toEqual({
      center: [0, 0, 0],
      halfSize: 13.8,
    });
    expect(regionAround([10.123, 0, 0], [20.123, 1, 1]).center).toEqual([15.12, 0.5, 0.5]);
  });

  it("never returns an empty region", () => {
    expect(regionAround([1, 1, 1], [1, 1, 1]).halfSize).toBeGreaterThan(0);
  });
});

describe("roundNice", () => {
  it.each([
    [0, "nearest", 0],
    [12.3456, "nearest", 12.3],
    [12.3456, "up", 12.4],
    [-0.012345, "nearest", -0.0123],
    [1234567, "nearest", 1230000],
  ] as const)("%d %s -> %d", (value, direction, expected) => {
    expect(roundNice(value, direction)).toBe(expected);
  });
});
