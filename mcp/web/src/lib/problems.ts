// Turns scratchcad error messages into editor diagnostics. Rhai errors end
// with "(line 3, position 12)"; print/debug output starts with
// "[line 3, position 12]".

export interface Problem {
  severity: "error" | "warning" | "info";
  message: string;
  /** 1-based, when the message names a position in the script. */
  line?: number;
  column?: number;
}

const POSITION = /[([]line (\d+), position (\d+)[)\]]/;

export function problem(severity: Problem["severity"], message: string): Problem {
  const match = POSITION.exec(message);
  if (!match) return { severity, message };
  return { severity, message, line: Number(match[1]), column: Number(match[2]) };
}

/** Offset of a 1-based line/column in `text`, clamped to the document. */
export function offsetOf(text: string, line: number, column: number): number {
  let offset = 0;
  for (let i = 1; i < line; i++) {
    const next = text.indexOf("\n", offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  const end = text.indexOf("\n", offset);
  const lineEnd = end === -1 ? text.length : end;
  return Math.min(offset + Math.max(column - 1, 0), lineEnd);
}
