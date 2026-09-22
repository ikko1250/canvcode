import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { tags } from '@lezer/highlight'

// CodeMirror の設定（MAI-9、MAI-30）。カードの上での編集と、全画面のエディタで同じものを使う。
// 本文の履歴（Undo）は CodeMirror 自身が持つ。キャンバスの履歴には入れない（MAI-11）

export interface CodeEditorOptions {
  parent: HTMLElement
  doc: string
  language: 'markdown' | 'python' | null
  onChange(text: string): void
  // Esc（編集を終える）と、Ctrl（⌘）+Enter（全画面で開く・閉じる）
  onEscape?(): void
  onModEnter?(): void
  placeholder?: string
  // 追加の見た目（全画面では文字を大きくするなど）
  theme?: Extension
}

export interface CodeEditorHandle {
  view: EditorView
  text(): string
  // 外で変わった本文に入れ替える（カーソルはできるだけ同じ位置に残す）
  replace(text: string): void
  focus(): void
  destroy(): void
}

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '700', color: '#1f2328' },
  { tag: tags.heading1, fontSize: '1.25em' },
  { tag: tags.heading2, fontSize: '1.12em' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.link, color: '#6d43bd' },
  { tag: tags.url, color: '#6d43bd' },
  { tag: tags.monospace, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: '#8a3b12' },
  { tag: tags.quote, color: '#655f65' },
  { tag: tags.processingInstruction, color: '#8c959f' },
  { tag: tags.keyword, color: '#cf222e' },
  { tag: tags.string, color: '#0a3069' },
  { tag: tags.comment, color: '#6e7781', fontStyle: 'italic' },
  { tag: tags.number, color: '#0550ae' },
])

const baseTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: '#ffffff', color: '#1f2328' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: "'Noto Sans JP', 'Noto Sans CJK JP', 'Hiragino Sans', 'Yu Gothic UI', 'Meiryo', sans-serif",
    lineHeight: '1.6',
  },
  '.cm-content': { padding: '12px 0' },
  '.cm-line': { padding: '0 16px' },
  '.cm-cursor': { borderLeftColor: '#2f6fed' },
})

export function createCodeEditor(options: CodeEditorOptions): CodeEditorHandle {
  const keys = keymap.of([
    {
      key: 'Escape',
      run: () => {
        options.onEscape?.()
        return options.onEscape !== undefined
      },
    },
    {
      key: 'Mod-Enter',
      run: () => {
        options.onModEnter?.()
        return options.onModEnter !== undefined
      },
    },
    indentWithTab,
    ...historyKeymap,
    ...defaultKeymap,
  ])
  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: options.doc,
      extensions: [
        keys,
        history(),
        EditorView.lineWrapping,
        syntaxHighlighting(highlight),
        baseTheme,
        options.theme ?? [],
        options.language === 'markdown' ? markdown() : [],
        options.placeholder ? placeholder(options.placeholder) : [],
        EditorView.updateListener.of((update) => {
          if (update.docChanged) options.onChange(update.state.doc.toString())
        }),
      ],
    }),
  })
  return {
    view,
    text: () => view.state.doc.toString(),
    replace(text) {
      const current = view.state.doc.toString()
      if (current === text) return
      const head = Math.min(view.state.selection.main.head, text.length)
      view.dispatch({ changes: { from: 0, to: current.length, insert: text }, selection: { anchor: head } })
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  }
}
