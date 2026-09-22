import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState, RangeSetBuilder, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, keymap, lineNumbers, placeholder, type DecorationSet, type ViewUpdate } from '@codemirror/view'
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
  // from〜to を選んで、画面の中ほどに見せる（引用ノートの「出典へ」。MAI-33）
  select(from: number, to: number): void
  // 選んでいる文字と、その始まりの行（1 から。前後の空白は除く）。何も選んでいなければ null
  selectedQuote(): { quote: string; line: number } | null
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

// 折り返した行も、元の行のインデントの位置から続ける（MAI-31：コードカードと同じ折り返し）。
// 行ごとに、行頭の空白の分だけ左の余白を増やし、1 行目だけ字下げを戻す
const TAB_SIZE = 4
const LINE_PADDING = 16
function indentWidth(text: string): number {
  let width = 0
  for (const char of text) {
    if (char === ' ') width++
    else if (char === '\t') width += TAB_SIZE - (width % TAB_SIZE)
    else break
  }
  return width
}

const hangingIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view)
    }
    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>()
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = view.state.doc.lineAt(pos)
          const indent = indentWidth(line.text)
          if (indent > 0) {
            builder.add(
              line.from,
              line.from,
              Decoration.line({ attributes: { style: `padding-left: calc(${indent}ch + ${LINE_PADDING}px); text-indent: -${indent}ch` } }),
            )
          }
          pos = line.to + 1
        }
      }
      return builder.finish()
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

const codeTheme = EditorView.theme({
  '.cm-scroller': { fontFamily: "ui-monospace, 'SFMono-Regular', Menlo, 'DejaVu Sans Mono', 'Noto Sans Mono CJK JP', monospace", fontSize: '13px' },
  '.cm-gutters': { backgroundColor: '#fbfcfd', color: '#8c959f', border: 'none' },
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
        // コードは、行番号とインデントを保つ折り返し、等幅フォント
        options.language === 'python' ? [python(), lineNumbers(), hangingIndent, codeTheme, EditorState.tabSize.of(TAB_SIZE)] : [],
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
    select(from, to) {
      const length = view.state.doc.length
      const anchor = Math.min(Math.max(0, from), length)
      view.dispatch({
        selection: { anchor, head: Math.min(Math.max(anchor, to), length) },
        effects: EditorView.scrollIntoView(anchor, { y: 'center' }),
      })
    },
    selectedQuote() {
      const { state } = view
      const { from, to } = state.selection.main
      const raw = state.sliceDoc(from, to)
      const quote = raw.trim()
      if (!quote) return null
      return { quote, line: state.doc.lineAt(from + (raw.length - raw.trimStart().length)).number }
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  }
}
