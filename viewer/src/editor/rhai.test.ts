import { describe, expect, it } from "vitest";
import { completions, parser, tokenize } from "./rhai";

const styles = (line: string) => tokenize(line).filter(([, style]) => style !== null);

describe("rhai tokenizer", () => {
  it("highlights a parameter line", () => {
    expect(styles("let r = 2.5; // [1, 5] Radius")).toEqual([
      ["let", "keyword"],
      ["r", "variable"],
      ["=", "operator"],
      ["2.5", "number"],
      ["// [1, 5] Radius", "comment"],
    ]);
  });

  it("knows shapes, math, atoms, maps and strings", () => {
    expect(styles('draw(sphere(#{ radius: sqrt(x) })); print("a\\"b");')).toEqual([
      ["draw", "builtin"],
      ["(", "bracket"],
      ["sphere", "builtin"],
      ["(", "bracket"],
      ["#{", "bracket"],
      ["radius", "variable"],
      ["sqrt", "builtin"],
      ["(", "bracket"],
      ["x", "atom"],
      [")", "bracket"],
      ["}", "bracket"],
      [")", "bracket"],
      [")", "bracket"],
      ["print", "variable"],
      ["(", "bracket"],
      ['"a\\"b"', "string"],
      [")", "bracket"],
    ]);
  });

  it("handles nested block comments, chars and backtick strings", () => {
    expect(styles("/* a /* b */ c */ 'x' `t` 1e3")).toEqual([
      ["/* a /* b */ c */", "comment"],
      ["'x'", "string"],
      ["`t`", "string"],
      ["1e3", "number"],
    ]);
    expect(styles("/* open")).toEqual([["/* open", "comment"]]);
  });

  it("skips characters it does not know", () => {
    expect(tokenize("@")).toEqual([["@", null]]);
  });
});

describe("completions", () => {
  it("offers every shape with a snippet", () => {
    const labels = completions.map((c) => c.label);
    for (const name of ["sphere", "difference", "extrude_z", "draw", "sqrt", "let"]) {
      expect(labels).toContain(name);
    }
  });
});

describe("parser state", () => {
  it("copies block comment depth", () => {
    const state = parser.startState!(4);
    state.blockComment = 2;
    const copy = parser.copyState!(state);
    expect(copy).toEqual({ blockComment: 2 });
    expect(copy).not.toBe(state);
  });
});
