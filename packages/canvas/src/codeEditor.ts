import { defaultKeymap, history, historyKeymap, indentWithTab, insertNewlineAndIndent } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorState, Prec, RangeSetBuilder, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, drawSelection, keymap, lineNumbers, placeholder, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { getCM, vim } from '@replit/codemirror-vim'
import { tags } from '@lezer/highlight'
import { CODE_CARD_METRICS, CODE_FONT_FAMILY } from '@canvcode/nodes'
import { linesOfSelection } from '@canvcode/core'
import { registerVimKeymap, setVimHandlers, vimModeOf, type VimHandlers, type VimMode } from './vimKeymap.ts'

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
  // vim モード（MAI-60。全画面エディタだけ）。vim モードでは Esc を vim に渡し、onEscape は呼ばない。
  // Ctrl（⌘）+Enter で onModEnter を呼ぶのはノーマルモードのときだけ
  vim?: boolean
  // :w / :q / :wq / ZZ / Space x で呼ぶ
  vimCommands?: VimHandlers
  // vim のモードが変わった（vim をオフにしたら null）
  onVimModeChange?(mode: VimMode | null): void
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
  // 選んでいる行の範囲（1 から、終わりの行を含む）と、その行の中身。何も選んでいなければカーソルのある行（AI に渡す参照）
  selectedLines(): { startLine: number; endLine: number; snapshot: string }
  // vim モードを切り替える（エディタは作り直さない）
  setVim(on: boolean): void
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
// 本文の左の余白（行番号との間。コードカードと同じ。MAI-55）
const LINE_PADDING = CODE_CARD_METRICS.gutterGap
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

// コードの見た目。文字の大きさ・行の高さ・余白・行番号の位置をコードカードの描画（nodes/code/codeCard.ts）と同じにして、
// カードの上で編集を始めても文字がずれないようにする（MAI-55）。
// 行番号は、左端の余白 paddingX の右に桁数ぶんの幅で右揃え、本文はその gutterGap（LINE_PADDING）だけ右から始める
const codeTheme = EditorView.theme({
  '.cm-scroller': { fontFamily: CODE_FONT_FAMILY, fontSize: `${CODE_CARD_METRICS.fontSize}px`, lineHeight: `${CODE_CARD_METRICS.lineHeight}px` },
  '.cm-content': { padding: `${CODE_CARD_METRICS.paddingY}px 0` },
  '.cm-line': { padding: `0 ${CODE_CARD_METRICS.paddingX}px 0 ${LINE_PADDING}px` },
  '.cm-gutters': { backgroundColor: CODE_CARD_METRICS.background, color: CODE_CARD_METRICS.lineNumberColor, border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: `0 0 0 ${CODE_CARD_METRICS.paddingX}px`, minWidth: '0' },
})

// vim モード（MAI-60）。vim の拡張は、ほかのキーの割り当てより前に置く（パッケージの README）。
// basicSetup を使っていないので、visual モードの選択を描くために drawSelection も入れる
function vimExtension(): Extension {
  registerVimKeymap()
  return [
    // 日本語入力の変換中のキー（確定の Enter、取り消しの Esc など）は vim に渡さず、IME に任せる
    Prec.highest(EditorView.domEventHandlers({ keydown: (event, view) => event.isComposing || view.composing })),
    vim(),
    drawSelection(),
  ]
}

function modeFromEvent(event: { mode: string; subMode?: string }): VimMode {
  if (event.mode === 'visual') return event.subMode === 'linewise' ? 'visual line' : event.subMode === 'blockwise' ? 'visual block' : 'visual'
  if (event.mode === 'insert' || event.mode === 'replace') return event.mode
  return 'normal'
}

export function createCodeEditor(options: CodeEditorOptions): CodeEditorHandle {
  const vimCompartment = new Compartment()
  let vimOn = options.vim === true
  const keys = keymap.of([
    {
      key: 'Escape',
      run: () => {
        // vim モードの Esc は vim のもの（ここまで来たら、何もしない）
        if (vimOn) return false
        options.onEscape?.()
        return options.onEscape !== undefined
      },
    },
    {
      key: 'Mod-Enter',
      run: (target) => {
        const mode = vimOn ? vimModeOf(target) : null
        // 挿入モードは、ただ改行する（閉じない）。visual モードでは何もしない
        if (mode === 'insert' || mode === 'replace') return insertNewlineAndIndent(target)
        if (mode !== null && mode !== 'normal') return true
        options.onModEnter?.()
        return options.onModEnter !== undefined
      },
    },
    // vim の挿入モード以外では、Tab で本文を変えない（visual モードの Tab は vim の割り当て）
    { key: 'Tab', run: (target) => vimOn && vimModeOf(target) !== 'insert', shift: (target) => vimOn && vimModeOf(target) !== 'insert' },
    indentWithTab,
    ...historyKeymap,
    ...defaultKeymap,
  ])
  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: options.doc,
      extensions: [
        vimCompartment.of(vimOn ? vimExtension() : []),
        keys,
        history(),
        EditorView.lineWrapping,
        syntaxHighlighting(highlight),
        // 見た目は、先に並べたものほど優先される（CodeMirror はテーマのスタイルを逆順に差し込む）。
        // 呼び出し側のテーマ → 言語ごとのテーマ → 共通のテーマの順にする（MAI-55）
        options.theme ?? [],
        options.language === 'markdown' ? markdown() : [],
        // コードは、行番号とインデントを保つ折り返し、等幅フォント
        options.language === 'python' ? [python(), lineNumbers(), hangingIndent, codeTheme, EditorState.tabSize.of(TAB_SIZE)] : [],
        baseTheme,
        options.placeholder ? placeholder(options.placeholder) : [],
        EditorView.updateListener.of((update) => {
          if (update.docChanged) options.onChange(update.state.doc.toString())
        }),
      ],
    }),
  })
  if (options.vimCommands) setVimHandlers(view, options.vimCommands)
  // vim のモードの変化を知らせる。vim の拡張を入れ直すと、中の CodeMirror 5 互換の入れ物も作り直されるので、付け直す
  const watchVimMode = () => {
    const cm = getCM(view)
    if (!vimOn || !cm) {
      options.onVimModeChange?.(null)
      return
    }
    cm.on('vim-mode-change', (event: { mode: string; subMode?: string }) => options.onVimModeChange?.(modeFromEvent(event)))
    options.onVimModeChange?.(vimModeOf(view))
  }
  watchVimMode()
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
    selectedLines() {
      const { from, to } = view.state.selection.main
      return linesOfSelection(view.state.doc.toString(), from, to)
    },
    setVim(on) {
      if (on === vimOn) return
      vimOn = on
      view.dispatch({ effects: vimCompartment.reconfigure(on ? vimExtension() : []) })
      watchVimMode()
    },
    focus: () => view.focus(),
    destroy: () => {
      setVimHandlers(view, null)
      view.destroy()
    },
  }
}
