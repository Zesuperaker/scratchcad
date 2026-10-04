import { describe, expect, it } from "vitest";
import { offsetOf, problem } from "./problems";

describe("problem", () => {
  it("reads Rhai's error position", () => {
    expect(problem("error", "script error: Script is incomplete (line 3, position 12)")).toEqual({
      severity: "error",
      message: "script error: Script is incomplete (line 3, position 12)",
      line: 3,
      column: 12,
    });
  });

  it("reads debug output's position", () => {
    expect(problem("info", "[line 1, position 1] hello")).toMatchObject({ line: 1, column: 1 });
  });

  it("leaves messages without a position alone", () => {
    expect(problem("warning", "the shape reaches the boundary")).toEqual({
      severity: "warning",
      message: "the shape reaches the boundary",
    });
  });
});

describe("offsetOf", () => {
  const text = "ab\ncde\nf";

  it.each([
    [1, 1, 0],
    [2, 2, 4],
    [2, 99, 6],
    [3, 1, 7],
    [3, 0, 7],
    [9, 1, 8],
  ])("line %d column %d -> %d", (line, column, offset) => {
    expect(offsetOf(text, line, column)).toBe(offset);
  });
});
