import { indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting } from "@codemirror/language";
import { type Diagnostic, lintGutter, setDiagnostics } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { offsetOf, type Problem } from "../lib/problems";
import { highlightStyle, rhai } from "./rhai";

interface Props {
  /** A new key starts a fresh editor state (new undo history), e.g. per file. */
  docKey: string;
  value: string;
  onChange: (value: string) => void;
  problems: Problem[];
  /** Moves the cursor to this spot and focuses the editor; a new `key` repeats it. */
  reveal?: { line: number; column: number; key: number } | null;
}

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--editor-bg)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  ".cm-gutters": {
    backgroundColor: "var(--editor-bg)",
    color: "var(--editor-muted)",
    borderRight: "1px solid var(--editor-border)",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--editor-active-line)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
    { backgroundColor: "var(--editor-selection)" },
  ".cm-cursor": { borderLeftColor: "currentColor" },
});

/**
 * A CodeMirror editor for Rhai. It is uncontrolled internally, but follows
 * `value` when it changes from outside (a parameter slider, a reload), by
 * applying only the changed span so the cursor and undo history survive.
 */
export function CodeEditor({ docKey, value, onChange, problems, reveal = null }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const valueRef = useRef(value);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    const state = EditorState.create({
      doc: valueRef.current,
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        rhai,
        syntaxHighlighting(highlightStyle),
        lintGutter(),
        theme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    const editor = new EditorView({ state, parent: host.current! });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [docKey]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    let start = 0;
    while (start < current.length && current[start] === value[start]) start++;
    let end = 0;
    while (
      end < current.length - start &&
      end < value.length - start &&
      current[current.length - 1 - end] === value[value.length - 1 - end]
    ) {
      end++;
    }
    editor.dispatch({
      changes: {
        from: start,
        to: current.length - end,
        insert: value.slice(start, value.length - end),
      },
    });
  }, [value]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const text = editor.state.doc.toString();
    const diagnostics: Diagnostic[] = problems
      .filter((p) => p.line !== undefined && p.severity !== "info")
      .map((p) => {
        const from = offsetOf(text, p.line!, p.column ?? 1);
        const lineEnd = editor.state.doc.lineAt(from).to;
        return { from, to: Math.max(from, lineEnd), severity: p.severity, message: p.message };
      });
    editor.dispatch(setDiagnostics(editor.state, diagnostics));
  }, [problems, docKey]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || !reveal) return;
    const at = offsetOf(editor.state.doc.toString(), reveal.line, reveal.column);
    editor.dispatch({ selection: { anchor: at }, scrollIntoView: true });
    editor.focus();
  }, [reveal]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
