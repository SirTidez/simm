import CodeMirror from '@uiw/react-codemirror';
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

interface ConfigRawEditorProps {
  value: string;
  onChange: (value: string) => void;
}

// Colours come from the SIMM tokens so every built-in and custom theme applies.
const rawConfigEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    width: '100%',
    minWidth: '0',
    backgroundColor: 'var(--simm-sunken)',
    color: 'var(--simm-text)',
    fontSize: 'var(--simm-text-sm)',
    display: 'flex',
    flexDirection: 'column',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    flex: '1 1 auto',
    minHeight: '0',
    minWidth: '0',
    width: '100%',
    fontFamily: 'var(--simm-font-mono)',
    lineHeight: '1.6',
    overflowX: 'auto',
    overflowY: 'auto',
  },
  '.cm-content': {
    minHeight: '100%',
    padding: 'var(--simm-space-3) var(--simm-space-4)',
    caretColor: 'var(--simm-text)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--simm-text)',
  },
  '.cm-line': {
    padding: '0',
    overflowWrap: 'anywhere',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--simm-accent) 34%, transparent) !important',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--simm-hover)',
  },
  '.cm-gutters': {
    display: 'none',
  },
  '.raw-config-token--comment': {
    color: 'var(--simm-text-3)',
  },
  '.raw-config-token--section': {
    color: 'var(--simm-accent-text)',
    fontWeight: '600',
  },
  '.raw-config-token--key': {
    color: 'var(--simm-text)',
  },
  '.raw-config-token--operator': {
    color: 'var(--simm-text-3)',
  },
  '.raw-config-token--string': {
    color: 'var(--simm-warn-text)',
  },
  '.raw-config-token--boolean': {
    color: 'var(--simm-ok-text)',
  },
  '.raw-config-token--number': {
    color: 'var(--simm-info-text)',
  },
});

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
      theme="none"
      extensions={rawEditorExtensions}
      onChange={onChange}
      aria-label="Raw config content"
    />
  );
}
