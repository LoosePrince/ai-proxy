import { useEffect, useRef } from 'react';
import { autocompletion, completeFromList } from '@codemirror/autocomplete';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';

interface Props {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  minHeight?: number;
}

const suggestions = completeFromList([
  ...['request', 'payload', 'model', 'variables', 'fetch', 'signal', 'provider', 'module', 'exports'].map((label) => ({ label, type: 'variable' })),
  ...['get', 'set', 'patch'].map((label) => ({ label, type: 'method' })),
  ...['status', 'contentType', 'body', 'actualModel'].map((label) => ({ label, type: 'property' })),
]);

export function ProviderScriptEditor({ value, onChange, disabled = false, minHeight = 360 }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return undefined;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        foldGutter(),
        history(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        javascript(),
        autocompletion({ override: [suggestions], activateOnTyping: true }),
        search(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, ...searchKeymap, indentWithTab]),
        EditorView.editable.of(!disabled),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
        EditorView.theme({
          '&': { minHeight: `${minHeight}px`, fontSize: '13px' },
          '.cm-scroller': { minHeight: `${minHeight}px`, fontFamily: 'var(--mono)' },
          '.cm-content': { padding: '14px 0' },
          '.cm-gutters': { backgroundColor: 'transparent', border: 'none' },
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    return () => view.destroy();
  }, [disabled, minHeight]);

  return <div ref={hostRef} className="provider-code-editor" aria-label="JavaScript 脚本编辑器" />;
}