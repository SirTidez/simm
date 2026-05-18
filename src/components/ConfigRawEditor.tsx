import CodeMirror from '@uiw/react-codemirror';
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

interface ConfigRawEditorProps {
  value: string;
  onChange: (value: string) => void;
}

const rawConfigEditorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      width: '100%',
      minWidth: '0',
      backgroundColor: '#08111f',
      color: '#eef5ff',
      fontSize: '0.86rem',
      display: 'flex',
      flexDirection: 'column',
    },
    '.cm-scroller': {
      flex: '1 1 auto',
      minHeight: '0',
      minWidth: '0',
      width: '100%',
      fontFamily: '"Courier New", monospace',
      lineHeight: '1.55',
      overflowX: 'auto',
      overflowY: 'auto',
    },
    '.cm-content': {
      minHeight: '100%',
      padding: '0.78rem 0.92rem',
      caretColor: '#eef5ff',
    },
    '.cm-focused': {
      outline: 'none',
    },
    '.cm-line': {
      padding: '0',
      overflowWrap: 'anywhere',
    },
    '.cm-selectionBackground': {
      backgroundColor: 'rgba(96, 145, 216, 0.38) !important',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(52, 82, 124, 0.18)',
    },
    '.cm-gutters': {
      display: 'none',
    },
    '.raw-config-token--comment': {
      color: '#82a3c8',
    },
    '.raw-config-token--section': {
      color: '#7db5ff',
      fontWeight: '700',
    },
    '.raw-config-token--key': {
      color: '#cfe2ff',
    },
    '.raw-config-token--operator': {
      color: '#7894b8',
    },
    '.raw-config-token--string': {
      color: '#f5d493',
    },
    '.raw-config-token--boolean': {
      color: '#81d6ac',
    },
    '.raw-config-token--number': {
      color: '#b9a4ff',
    },
  },
  { dark: true }
);

function markRawToken(builder: RangeSetBuilder<Decoration>, from: number, to: number, className: string) {
  if (to > from) {
    builder.add(from, to, Decoration.mark({ class: className }));
  }
}

function addRawValueDecorations(builder: RangeSetBuilder<Decoration>, lineFrom: number, valueOffset: number, value: string) {
  const tokenPattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\btrue\b|\bfalse\b|-?\b\d+(?:\.\d+)?\b)/gi;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(value)) !== null) {
    const token = match[0];
    const from = lineFrom + valueOffset + match.index;
    const className = /^(true|false)$/i.test(token)
      ? 'raw-config-token--boolean'
      : /^-?\d/.test(token)
        ? 'raw-config-token--number'
        : 'raw-config-token--string';

    markRawToken(builder, from, from + token.length, className);
  }
}

function buildRawConfigDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  for (const { from, to } of view.visibleRanges) {
    let line = view.state.doc.lineAt(from);

    while (line.from <= to) {
      const text = line.text;
      const trimmedLine = text.trimStart();
      const leadingLength = text.length - trimmedLine.length;

      if (trimmedLine.startsWith('#') || trimmedLine.startsWith(';')) {
        markRawToken(builder, line.from + leadingLength, line.to, 'raw-config-token--comment');
      } else {
        const sectionMatch = text.match(/^(\s*)(\[[^\]]+\])/);
        if (sectionMatch) {
          const sectionStart = line.from + sectionMatch[1].length;
          markRawToken(builder, sectionStart, sectionStart + sectionMatch[2].length, 'raw-config-token--section');
        }

        const assignmentMatch = text.match(/^(\s*)([^=]+?)(\s*=\s*)(.*)$/);
        if (assignmentMatch) {
          const keyStart = line.from + assignmentMatch[1].length;
          const keyEnd = keyStart + assignmentMatch[2].trimEnd().length;
          const operatorStart = line.from + assignmentMatch[1].length + assignmentMatch[2].length;
          const operatorEnd = operatorStart + assignmentMatch[3].length;
          const valueOffset = assignmentMatch[1].length + assignmentMatch[2].length + assignmentMatch[3].length;

          markRawToken(builder, keyStart, keyEnd, 'raw-config-token--key');
          markRawToken(builder, operatorStart, operatorEnd, 'raw-config-token--operator');
          addRawValueDecorations(builder, line.from, valueOffset, assignmentMatch[4]);
        }
      }

      if (line.to >= view.state.doc.length) break;
      line = view.state.doc.line(line.number + 1);
    }
  }

  return builder.finish();
}

const rawConfigHighlighting = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildRawConfigDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildRawConfigDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  }
);

const rawEditorExtensions = [rawConfigEditorTheme, EditorView.lineWrapping, rawConfigHighlighting];

export function ConfigRawEditor({ value, onChange }: ConfigRawEditorProps) {
  return (
    <CodeMirror
      value={value}
      height="100%"
      width="100%"
      minWidth="0"
      maxHeight="100%"
      maxWidth="100%"
      basicSetup={false}
      extensions={rawEditorExtensions}
      onChange={onChange}
      aria-label="Raw config content"
    />
  );
}
