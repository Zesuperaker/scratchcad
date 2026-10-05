// Rhai syntax highlighting and completions for the shapes and math that
// Fidget's Rhai engine registers (fidget-rhai / fidget-shapes 0.5).
import { type Completion, snippetCompletion } from "@codemirror/autocomplete";
import {
  HighlightStyle,
  StreamLanguage,
  type StreamParser,
  StringStream,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";

const KEYWORDS = new Set([
  "let", "const", "if", "else", "switch", "while", "loop", "for", "in", "do", "until",
  "break", "continue", "return", "throw", "try", "catch", "fn", "private", "this",
]); // prettier-ignore
const ATOMS = new Set(["true", "false", "x", "y", "z"]);

const SHAPES: [name: string, template: string, detail: string][] = [
  ["sphere", "sphere(#{ radius: ${1.0}, center: [${0}, ${0}, ${0}] })", "3D"],
  ["box", "box(#{ lower: [${-1}, ${-1}, ${-1}], upper: [${1}, ${1}, ${1}] })", "3D"],
  ["circle", "circle(#{ radius: ${1.0}, center: [${0}, ${0}] })", "2D, infinite in z"],
  ["rectangle", "rectangle(#{ lower: [${-1}, ${-1}], upper: [${1}, ${1}] })", "2D, infinite in z"],
  ["union", "union([${a}, ${b}])", "combine shapes"],
  ["intersection", "intersection([${a}, ${b}])", "overlap of shapes"],
  ["difference", "difference(#{ shape: ${a}, cutout: ${b} })", "cut one shape from another"],
  ["inverse", "inverse(#{ shape: ${a} })", "inside out"],
  ["blend", "blend(#{ a: ${a}, b: ${b}, radius: ${0.1} })", "smooth union"],
  ["move", "move(#{ shape: ${a}, offset: [${0}, ${0}, ${0}] })", "translate"],
  ["scale", "scale(#{ shape: ${a}, scale: [${1}, ${1}, ${1}] })", "per-axis scale"],
  ["scale_uniform", "scale_uniform(#{ shape: ${a}, scale: ${2.0} })", "uniform scale"],
  ["rotate_x", "rotate_x(#{ shape: ${a}, angle: ${90.0} })", "degrees"],
  ["rotate_y", "rotate_y(#{ shape: ${a}, angle: ${90.0} })", "degrees"],
  ["rotate_z", "rotate_z(#{ shape: ${a}, angle: ${90.0} })", "degrees"],
  ["reflect_x", "reflect_x(#{ shape: ${a}, offset: ${0.0} })", "mirror"],
  ["reflect_y", "reflect_y(#{ shape: ${a}, offset: ${0.0} })", "mirror"],
  ["reflect_z", "reflect_z(#{ shape: ${a}, offset: ${0.0} })", "mirror"],
  ["extrude_z", "extrude_z(#{ shape: ${profile}, lower: ${-1.0}, upper: ${1.0} })", "2D to 3D"],
  ["loft_z", "loft_z(#{ a: ${p}, b: ${q}, lower: ${-1.0}, upper: ${1.0} })", "blend profiles"],
  ["revolve_y", "revolve_y(#{ shape: ${profile}, offset: ${0.0} })", "lathe about y"],
  ["repeat_x", "repeat_x(#{ shape: ${a}, radius: ${1.0}, offset: ${0.0} })", "pattern"],
  ["draw", "draw(${shape})", "output the shape"],
];
const MATH = [
  "min", "max", "abs", "sqrt", "square", "sin", "cos", "tan", "asin", "acos", "atan",
  "atan2", "exp", "ln", "floor", "ceil", "round", "remap", "vec2", "vec3", "axes",
]; // prettier-ignore

const BUILTINS = new Set([...SHAPES.map(([name]) => name), ...MATH]);

export const completions: Completion[] = [
  ...SHAPES.map(([name, template, detail]) =>
    snippetCompletion(template, { label: name, detail, type: "function" }),
  ),
  ...MATH.map((name) => ({ label: name, type: "function", detail: "math" })),
  ...[...KEYWORDS].map((name) => ({ label: name, type: "keyword" })),
];

interface State {
  blockComment: number; // nesting depth; Rhai block comments nest
}

function token(stream: StringStream, state: State): string | null {
  if (state.blockComment > 0) {
    while (!stream.eol()) {
      if (stream.match("/*")) state.blockComment++;
      else if (stream.match("*/")) {
        if (--state.blockComment === 0) break;
      } else stream.next();
    }
    return "comment";
  }
  if (stream.eatSpace()) return null;
  if (stream.match("//")) {
    stream.skipToEnd();
    return "comment";
  }
  if (stream.match("/*")) {
    state.blockComment = 1;
    return token(stream, state);
  }
  if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^`[^`]*`?/)) return "string";
  if (stream.match(/^'(?:[^'\\]|\\.)'/)) return "string";
  if (stream.match(/^\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/)) return "number";
  if (stream.match("#{")) return "bracket";
  const word = stream.match(/^[A-Za-z_]\w*/) as RegExpMatchArray | null;
  if (word) {
    const name = word[0];
    if (KEYWORDS.has(name)) return "keyword";
    if (ATOMS.has(name)) return "atom";
    if (BUILTINS.has(name)) return "builtin";
    return "variable";
  }
  if (stream.match(/^[-+*/%=<>!&|^]+/)) return "operator";
  if (stream.match(/^[()[\]{}]/)) return "bracket";
  stream.next();
  return null;
}

export const parser: StreamParser<State> = {
  name: "rhai",
  startState: () => ({ blockComment: 0 }),
  copyState: (state) => ({ ...state }),
  token,
  languageData: {
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
    closeBrackets: { brackets: ["(", "[", "{", '"'] },
    autocomplete: completions,
  },
};

export const rhai = StreamLanguage.define(parser);

// Colours come from CSS variables (see index.css), so they follow the theme.
export const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--code-keyword)" },
  { tag: tags.comment, color: "var(--code-comment)", fontStyle: "italic" },
  { tag: tags.string, color: "var(--code-string)" },
  { tag: tags.number, color: "var(--code-number)" },
  { tag: tags.atom, color: "var(--code-atom)" },
  { tag: tags.standard(tags.variableName), color: "var(--code-function)" },
  { tag: tags.operator, color: "var(--code-operator)" },
]);

/** For tests: the token names for each piece of a line. */
export function tokenize(line: string): [string, string | null][] {
  const stream = new StringStream(line, 4, 2);
  const state = parser.startState!(4);
  const out: [string, string | null][] = [];
  while (!stream.eol()) {
    stream.start = stream.pos;
    const style = token(stream, state);
    out.push([stream.current(), style]);
  }
  return out;
}
