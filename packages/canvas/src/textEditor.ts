import { multiply, transformOf, type NodeRecord, type WorkspaceRecord, type Transaction } from '@canvcode/core'
import {
  alignedTextTop,
  applyRunFormat,
  baseFormatOf,
  cleanFormat,
  cssFont,
  cssLetterSpacing,
  cssLineHeight,
  formatAt,
  formatOfCharAt,
  formatsInRange,
  headingShortcutDepth,
  indentList,
  isMarkdownHeadingFormat,
  layoutRichText,
  listOf,
  listShortcut,
  MARKDOWN_CODE_FONT,
  markdownHeadingFormat,
  markdownShortcutAt,
  normalizeRichText,
  paragraphIndexesInRange,
  paragraphText,
  plainTextOf,
  replaceRange,
  resolveFormat,
  resolveRichText,
  richTextFromPaste,
  richTextFromPlain,
  richTextLength,
  standardMarkdownOf,
  sliceRichText,
  textDecorations,
  toggledValue,
  type TextEditSpec,
  type TextParagraph,
  type TextRange,
  type TextRunFormat,
  type TextRunFormatPatch,
  type TextStyle,
  type TextToggleFormat,
  withList,
} from '@canvcode/nodes'
import type { Editor } from './editor.ts'
import { stopUnlessZoom } from './documentEditor.ts'
import { isImeEvent } from './imeGuard.ts'
import { domPointAt, readRichTextDom, renderRichTextDom, richTextHtml } from './richTextDom.ts'
import { TEXT_CLIPBOARD_MIME, parseTextClipboard, textClipboardData } from './textClipboard.ts'

// 文字の編集モード（MAI-9、MAI-24）。
// 編集中は、ノードの位置・向き・倍率に合わせた編集用の要素（contenteditable）を編集用の DOM レイヤーに重ねる。
// 文字を打つたびに、同じトランザクションの中でノードを更新する（終えたときに 1 回の Undo になる）。
// フォント・行の高さ・文字間・折り返しの規則は、Canvas での描画（text/layout.ts）と同じにしてある。
//
// 範囲ごとの書式（MAI-74）：
// - 要素の中は段落ごとの div と run ごとの span（richTextDom.ts）。文字を打つ・IME・段落の中での削除はブラウザに任せ、
//   そのたびに DOM を読んでノードに入れる。段落を分ける・つなぐ、範囲を消す・打ち替える、貼り付けは、
//   ここで文字のデータを変えてから DOM を書き直す（ブラウザが勝手に style を付けた要素を作らないように）
// - IME で変換している間は DOM を書き直さない（変換が壊れる）。変換を終えたときに整える
// - 書式は formatRange で範囲に当てる。デザインパネルからは updateNode で（範囲は selectedRange で読む）
// - DOM を書き直すとブラウザの Undo が使えなくなるので、編集中の Undo・Redo（Ctrl+Z など）はここで持つ
// 箇条書き・番号付きリスト（MAI-78。richText.ts の TextList）のキー操作：
// - Tab / Shift+Tab：選んでいる段落のうちリストの段落の階層を上げ下げする（編集中の Tab はフォーカス移動・キャンバスのショートカットに渡さない）
// - Enter：分けた段落はリストの属性を引き継ぐ（次の項目）。空の項目で Enter すると、階層を 1 つ上げ、一番外ならリストを抜ける
// - 段落の頭で Backspace：リストを外す（段落はつながない）
// - 段落の頭に「- 」「* 」「1. 」「1) 」と打つと、その文字を消してリストにする（Undo 1 回で打った文字に戻る）。IME の変換中は変えない
// 太字・斜体・下線・取り消し線（MAI-79）：
// - Ctrl（⌘）+B / I / U と Ctrl（⌘）+Shift+X で切り替える（toggleFormat。デザインパネル・編集中のツールバーのボタンも同じ）。
//   ブラウザの execCommand（<b> などを作る）には任せず、formatRange で文字のデータを変えて DOM を書き直す。
//   キーはこの要素の中でだけ扱う（キャンバス・ほかの画面のショートカットには渡さない）
// - 範囲を選んでいれば、範囲の文字がすべてオンならオフ、そうでなければオンにする。
//   カーソルだけなら、次に打つ文字の書式として覚えておき（pending）、カーソルが動いたら捨てる（一般的なエディタと同じ）
// - 下線・取り消し線は CSS の text-decoration を使わず、Canvas と同じ線（layout.ts の textDecorations）を、
//   編集用の要素に重ねた要素（decorations）に描く
// Markdown（richMarkdown.ts の「付箋の Markdown」）：
// - 閉じる記号を打つと、打った **太字**・*斜体*・~~取り消し線~~・`等幅`・[文字]{color=…} を書式にする（記号を消す。Undo 1 回で打った文字に戻る）。
//   段落の頭で「# 」〜「###### 」（全角の ＃ と空白も）と打つと、その段落を見出しの書式（太字と大きさ）にする。見出しの終わりの Enter で、次の段落は普通の文字に戻す
//   書式にした文字のあとに打つ文字は、記号の前の文字の書式に戻す（pending）。IME の変換中は変えない
// - 貼り付けた文字（アプリ内の形式がないとき）は Markdown として読む（書式もリストもなければ、そのままの文字）。
//   段落の途中に貼るときは、最初の行をリストとして読まない。Ctrl（⌘）+Shift+V なら書式なしの文字として貼る
// - コピーしたとき、ほかのアプリへ渡す文字（text/plain）は、太字・斜体・取り消し線・等幅・リストがあれば普通の Markdown、
//   なければプレーンテキスト（色・大きさなどは、アプリ内の形式と HTML で渡す）
// - 等幅の文字の中で打った記号は、書式にしない
// 範囲ごとの書式を持たない型（図形のラベルなど）も同じ要素で編集し、プレーンテキストとしてノードに入れる

export interface TextEditorOptions {
  // 今の Canvas の Editor（Canvas を移ると変わる）
  getEditor: () => Editor
  layer: HTMLElement
  getDpr(): number
  // 編集を始めた・終えたとき（シーンからノードを隠す・戻すため）
  onChange(editingId: string | null): void
}

// この属性を付けた要素（デザインパネル）にフォーカスが移っても、文字の編集を終えない（MAI-74）。
// 選んでいた範囲は覚えておき、その範囲に書式を当てられるようにする。フォーカスが戻れば、範囲も戻す
export const KEEP_TEXT_EDITING_ATTRIBUTE = 'data-keep-text-editing'

// 選んでいる範囲を、フォーカスがないあいだ見せる（CSS Custom Highlight API。使えないブラウザでは見せない）
export const TEXT_SELECTION_HIGHLIGHT = 'canvcode-text-selection'

// 編集中の文字の範囲（デザインパネルの「混在」の表示などに使う）
export interface TextSelection {
  nodeId: string
  start: number
  end: number
  // カーソルだけのときに、次に打つ文字に当てる書式（MAI-79。Ctrl+B などで切り替えたもの）
  pending?: TextRunFormatPatch | null
  // 文字のデータが変わるたびに増える（書式だけを変えたときも、パネル・ツールバーの表示を描き直すため）
  revision?: number
}

interface Snapshot {
  paragraphs: TextParagraph[]
  selection: TextRange
}

interface Session {
  nodeId: string
  tx: Transaction<WorkspaceRecord>
  element: HTMLDivElement
  // 下線・取り消し線を描く要素（編集用の要素に重ねる。MAI-79）
  decorations: HTMLDivElement
  // 今の文字（DOM から読んだもの。ノードに入れたものと同じ）
  paragraphs: TextParagraph[]
  // 最後に分かった選択範囲（フォーカスを失っても覚えておく）
  selection: TextRange & { backward: boolean }
  // 窓ごとフォーカスを失ったときのカーソルの位置。窓に戻ったらここへ戻す（MAI-70）
  pendingSelection: TextRange | null
  // デザインパネルにフォーカスが移っている（編集は続いている）
  parked: boolean
  // カーソルの位置（at）で次に打つ文字に当てる書式（MAI-79）。カーソルが動いたら捨てる
  pending: { at: number; patch: TextRunFormatPatch } | null
  // IME の変換を始めたときの pending。確定した文字に当てる
  composePending: { at: number; patch: TextRunFormatPatch } | null
  revision: number
  composing: boolean
  undo: Snapshot[]
  redo: Snapshot[]
  // 続けて打った文字は、Undo 1 回にまとめる
  lastEdit: { kind: string; time: number } | null
}

// 打った文字のすぐ右にもカーソルを置けるよう、幅が伸びるテキストには少し余白を足す（fontSize に対する倍率）
const AUTO_WIDTH_SLACK_EM = 0.6
// この時間（ミリ秒）の中で続けた同じ種類の変更は、Undo 1 回にまとめる
const UNDO_GROUP_MS = 1000
const UNDO_LIMIT = 200

export class TextEditor {
  private readonly options: TextEditorOptions
  private session: Session | null = null
  private finishing = false
  // Ctrl（⌘）+Shift+V を押した（次の貼り付けを書式なしの文字にする）
  private plainPaste = false
  private selectionSnapshot: TextSelection | null = null
  private readonly selectionListeners = new Set<() => void>()

  constructor(options: TextEditorOptions) {
    this.options = options
  }

  get editingId(): string | null {
    return this.session?.nodeId ?? null
  }

  // tx を渡すと、そのトランザクションの続きとして編集する（作ってすぐ編集するとき。作成と編集が 1 回の Undo になる）
  start(nodeId: string, options: { tx?: Transaction<WorkspaceRecord>; selectAll?: boolean } = {}): boolean {
    const editor = this.options.getEditor()
    if (this.session) this.finish()
    const node = editor.getNode(nodeId)
    const type = node && editor.getType(node)
    if (!node || !type?.editText || node.locked) {
      if (options.tx && !options.tx.isDone) editor.finish(options.tx)
      return false
    }
    const spec = type.editText(node)
    const tx = options.tx ?? editor.begin('edit text')
    const element = document.createElement('div')
    element.setAttribute('contenteditable', 'true')
    element.setAttribute('role', 'textbox')
    element.setAttribute('aria-multiline', 'true')
    element.className = 'canvcode-text-editor'
    element.spellcheck = false
    element.setAttribute('autocomplete', 'off')
    Object.assign(element.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      margin: '0',
      padding: '0',
      border: 'none',
      outline: 'none',
      background: 'transparent',
      overflow: 'hidden',
      transformOrigin: '0 0',
      pointerEvents: 'auto',
      // Canvas での折り返し（text/layout.ts）と同じ規則にする
      wordBreak: 'normal',
      overflowWrap: 'anywhere',
      lineBreak: 'strict',
      boxSizing: 'content-box',
      userSelect: 'text',
      cursor: 'text',
    })
    element.addEventListener('beforeinput', (e) => this.onBeforeInput(e as InputEvent))
    element.addEventListener('input', (e) => this.onInput(e as InputEvent))
    element.addEventListener('keydown', (e) => this.onKeyDown(e))
    // Ctrl+Shift+V の印は、そのキーの貼り付けにだけ使う（貼り付けが起きなかったときに、あとの貼り付けまで残さない）
    element.addEventListener('keyup', () => {
      this.plainPaste = false
    })
    element.addEventListener('blur', (e) => this.onBlur(e))
    element.addEventListener('compositionstart', () => this.onCompositionStart())
    element.addEventListener('compositionend', () => this.onCompositionEnd())
    element.addEventListener('copy', (e) => this.onCopy(e, false))
    element.addEventListener('cut', (e) => this.onCopy(e, true))
    element.addEventListener('paste', (e) => this.onPaste(e))
    element.addEventListener('drop', (e) => e.preventDefault())
    element.addEventListener('dragstart', (e) => e.preventDefault())
    // キャンバスのポインタ操作（選択・ドラッグ）に渡さない
    element.addEventListener('pointerdown', (e) => e.stopPropagation())
    // ピンチと Ctrl（⌘）+ホイールはキャンバスのズームに渡す（止めると、ブラウザがページごと拡大してしまう）
    element.addEventListener('wheel', stopUnlessZoom, { passive: true })
    this.options.layer.appendChild(element)
    const decorations = document.createElement('div')
    decorations.className = 'canvcode-text-decorations'
    Object.assign(decorations.style, { position: 'absolute', left: '0', top: '0', transformOrigin: '0 0', pointerEvents: 'none' })
    this.options.layer.appendChild(decorations)
    const paragraphs = editParagraphs(spec)
    const length = richTextLength(paragraphs)
    this.session = {
      nodeId,
      tx,
      element,
      decorations,
      paragraphs,
      selection: { start: length, end: length, backward: false },
      pendingSelection: null,
      parked: false,
      pending: null,
      composePending: null,
      revision: 0,
      composing: false,
      undo: [],
      redo: [],
      lastEdit: null,
    }
    document.addEventListener('selectionchange', this.onSelectionChange)
    editor.setSelection([nodeId])
    this.options.onChange(nodeId)
    renderRichTextDom(element, paragraphs, spec.style)
    this.layout()
    element.focus({ preventScroll: true })
    if (options.selectAll) this.select(0, length)
    else this.select(length, length)
    return true
  }

  finish(): void {
    const session = this.session
    this.plainPaste = false
    if (!session || this.finishing) return
    this.finishing = true
    try {
      const editor = this.options.getEditor()
      const node = editor.getNode(session.nodeId)
      const spec = node ? editor.getType(node).editText?.(node) : undefined
      // 空のまま終えたテキストは消す（同じトランザクションなので、作ってすぐ消した場合は何も残らない）
      if (node && spec?.deleteIfEmpty && spec.text.trim() === '') session.tx.remove(node.id)
      if (!session.tx.isDone) editor.finish(session.tx)
      session.element.remove()
      session.decorations.remove()
      document.removeEventListener('selectionchange', this.onSelectionChange)
      document.removeEventListener('focusin', this.onFocusIn)
      if (session.pendingSelection) window.removeEventListener('focus', this.onWindowFocus)
      clearHighlight()
      this.session = null
      this.notifySelection()
      this.options.onChange(null)
    } finally {
      this.finishing = false
    }
  }

  // カメラやノードが変わったときに、編集用の要素の位置・大きさを合わせ直す
  layout(): void {
    const session = this.session
    if (!session) return
    const editor = this.options.getEditor()
    const entry = editor.index.get(session.nodeId)
    const node = entry?.node
    const spec = node ? editor.getType(node).editText?.(node) : undefined
    if (!entry || !spec) {
      this.finish()
      return
    }
    const { element } = session
    const camera = editor.session.get().camera
    applyEditorStyle(element, spec)
    const layout = layoutRichText(session.paragraphs, spec.style, spec.autoWidth ? null : spec.box.w)
    const slackEm = spec.style.fontSize * AUTO_WIDTH_SLACK_EM
    const width = Math.max(spec.autoWidth ? layout.width + slackEm : spec.box.w, spec.style.fontSize)
    // 幅が伸びるテキストの余白は右に付くので、中央揃え・右揃えでは Canvas の描画と同じ位置に文字が来るよう、その分だけ左へずらす（MAI-50）
    const slack = Math.max(0, width - spec.box.w)
    const offsetX = spec.style.align === 'center' ? -slack / 2 : spec.style.align === 'right' ? -slack : 0
    // 縦の揃え（上・上下の中央・下。MAI-115）：Canvas の描画と同じ文字の上端（alignedTextTop。箱の上端からの距離）。
    // 箱に収まる文字は、上の余白でその分だけ下げる。箱からあふれる文字（上下の中央・下揃え）は、要素ごと上へずらす
    // （Canvas と同じく上にはみ出す。編集を始めても文字の位置が動かない）
    const top = alignedTextTop({ y: 0, h: spec.box.h }, layout.height, spec.verticalAlign)
    const padding = Math.max(0, top)
    const shift = Math.min(0, top)
    // ノードのローカル座標（文字の箱の左上）→ 画面の CSS ピクセル
    const local = multiply(entry.worldMatrix, transformOf(spec.box.x + offsetX, spec.box.y + shift, 0))
    const z = camera.zoom
    const transform = `matrix(${local.a * z}, ${local.b * z}, ${local.c * z}, ${local.d * z}, ${(local.e - camera.x) * z}, ${(local.f - camera.y) * z})`
    element.style.transform = transform
    element.style.width = `${width}px`
    element.style.paddingTop = padding > 0 ? `${padding}px` : '0'
    if (spec.verticalAlign === 'top') element.style.height = `${Math.max(layout.height, spec.autoWidth ? 0 : spec.box.h)}px`
    else element.style.height = `${Math.max(layout.height, spec.box.h - padding)}px`
    // 下線・取り消し線（MAI-79）。文字は要素の幅の中でそろうので、その幅で Canvas と同じ線を出す
    session.decorations.style.transform = transform
    const lines = textDecorations(layout, spec.style, { x: 0, y: padding, w: width, h: layout.height }, 'top')
    session.decorations.replaceChildren(
      ...lines.map((line) => {
        const bar = document.createElement('div')
        bar.dataset.decoration = line.kind
        Object.assign(bar.style, {
          position: 'absolute',
          left: `${line.x}px`,
          top: `${line.y}px`,
          width: `${line.width}px`,
          height: `${line.thickness}px`,
          background: line.color,
        })
        return bar
      }),
    )
  }

  // 編集中のノードを、文字以外（文字の大きさ・揃えなど）や文字の書式で変える（パレット・デザインパネルから。MAI-52、MAI-74）。
  // 編集のトランザクションが開いたままなので、ほかから transact で変えることはできない（begin が投げる）。
  // 同じトランザクションで変え、編集用の要素をその場で合わせ直す。フォーカスと選んでいる範囲はそのまま。
  // 終えたときに、文字の編集と合わせて 1 回の Undo になる
  updateNode(update: (node: NodeRecord) => NodeRecord): boolean {
    const session = this.session
    if (!session) return false
    const editor = this.options.getEditor()
    const node = editor.getNode(session.nodeId)
    if (!node) return false
    const next = update(node)
    const spec = editor.getType(next).editText?.(next)
    if (spec) {
      const paragraphs = editParagraphs(spec)
      if (JSON.stringify(paragraphs) !== JSON.stringify(session.paragraphs)) {
        this.pushUndo('format')
        session.paragraphs = paragraphs
        session.revision++
      }
    }
    session.tx.put(next)
    session.tx.flush()
    // 書式（span の style）はノードの既定にもよるので、いつも書き直す
    this.rerender()
    this.layout()
    this.notifySelection()
    return true
  }

  // 選んでいる文字の範囲（空でないとき）。フォーカスがデザインパネルに移っていても、覚えている範囲を返す
  selectedRange(): TextRange | null {
    const session = this.session
    if (!session) return null
    const { start, end } = this.currentSelection()
    return start === end ? null : { start, end }
  }

  // 範囲（既定は選んでいる範囲。なければ文字全体）の文字に書式を当てる（MAI-74）。
  // patch の undefined の項目は、ノードの既定に戻す。範囲ごとの書式を持たない型では何もしない（false）
  formatRange(patch: TextRunFormatPatch, range: TextRange | null = this.selectedRange()): boolean {
    const session = this.session
    const spec = this.currentSpec()
    if (!session || !spec?.rich) return false
    const target = range ?? { start: 0, end: richTextLength(session.paragraphs) }
    this.edit('format', (paragraphs) => applyRunFormat(paragraphs, target.start, target.end, patch, baseFormat(spec.style)), this.currentSelection())
    return true
  }

  // 太字・斜体・下線・取り消し線を切り替える（MAI-79。Ctrl+B などと、デザインパネル・ツールバーのボタン）。
  // 範囲を選んでいれば、範囲の文字がすべてオンならオフに、そうでなければオンにする。
  // カーソルだけなら、次に打つ文字の書式として覚える（もう一度押せば戻す）。範囲ごとの書式を持たない型では何もしない（false）
  toggleFormat(key: TextToggleFormat): boolean {
    const session = this.session
    if (!session || !this.currentSpec()?.rich) return false
    const range = this.currentSelection()
    const value = toggledValue(this.formatsOf(range).map((format) => format[key]))
    if (range.start !== range.end) {
      // 続けて押しても、Undo は 1 回ずつ（toggle はまとめない）
      const base = baseFormat(this.currentSpec()!.style)
      this.edit('toggle', (paragraphs) => applyRunFormat(paragraphs, range.start, range.end, { [key]: value }, base), range)
      return true
    }
    session.pending = { at: range.start, patch: { ...session.pending?.patch, [key]: value } }
    this.notifySelection()
    return true
  }

  // 選んでいる範囲の文字の書式（既定に重ねた実際の値。同じ書式の続きは 1 つ）。
  // カーソルだけなら、そこで次に打つ文字の書式（pending を含む）。デザインパネル・ツールバーのオン・オフの表示に使う
  // （描画の中で呼ばれるので、DOM の選択は読み直さず、覚えている範囲を使う。範囲は selectionchange で追っている）
  selectionFormats(): Required<TextRunFormat>[] {
    const session = this.session
    return session ? this.formatsOf(session.selection) : []
  }

  private formatsOf({ start, end }: TextRange): Required<TextRunFormat>[] {
    const session = this.session
    const spec = this.currentSpec()
    if (!session || !spec) return []
    const base = baseFormat(spec.style)
    if (start !== end) return formatsInRange(session.paragraphs, start, end).map((format) => resolveFormat(base, format))
    return [resolveFormat(base, this.typingFormat(start))]
  }

  // offset で次に打つ文字の書式（pending を重ねる）
  private typingFormat(offset: number): TextRunFormat | undefined {
    const session = this.session!
    const format = formatAt(session.paragraphs, offset)
    const pending = session.pending
    return pending && pending.at === offset ? cleanFormat({ ...format, ...pending.patch }) : format
  }

  // 編集用の要素にフォーカスを戻す（デザインパネルで値を入れ終えたときなど）。選んでいた範囲も戻す
  focus(): boolean {
    const session = this.session
    if (!session) return false
    const { start, end, backward } = session.selection
    session.element.focus({ preventScroll: true })
    this.unpark()
    if (backward) this.select(end, start)
    else this.select(start, end)
    return true
  }

  // 編集中の文字の範囲の購読（React の useSyncExternalStore 用）
  subscribeSelection = (listener: () => void): (() => void) => {
    this.selectionListeners.add(listener)
    return () => this.selectionListeners.delete(listener)
  }

  getSelectionSnapshot = (): TextSelection | null => this.selectionSnapshot

  // ---- 文字の変更 ----

  private currentSpec(): TextEditSpec<object> | undefined {
    const session = this.session
    if (!session) return undefined
    const editor = this.options.getEditor()
    const node = editor.getNode(session.nodeId)
    return node ? editor.getType(node).editText?.(node) : undefined
  }

  // 今の文字をノードに入れる
  private commit(paragraphs: TextParagraph[]): void {
    const session = this.session
    if (!session) return
    const editor = this.options.getEditor()
    const node = editor.getNode(session.nodeId)
    const spec = node ? editor.getType(node).editText?.(node) : undefined
    if (!node || !spec) return
    session.paragraphs = paragraphs
    session.revision++
    const props = spec.rich ? spec.rich.update(paragraphs) : spec.update(plainTextOf(paragraphs))
    session.tx.put({ ...node, props })
    session.tx.flush()
    this.layout()
    this.notifySelection()
  }

  // 文字のデータを変え、DOM を書き直して、範囲を selection にする
  private edit(kind: string, change: (paragraphs: TextParagraph[]) => TextParagraph[], selection: TextRange): void {
    const session = this.session
    if (!session) return
    const next = change(session.paragraphs)
    if (JSON.stringify(next) !== JSON.stringify(session.paragraphs)) {
      this.pushUndo(kind)
      this.commit(next)
    }
    this.rerender()
    this.select(selection.start, selection.end)
  }

  // 選んでいる範囲を inserted で置き換える。カーソルは入れたものの後ろ
  private replaceSelection(kind: string, inserted: (paragraphs: TextParagraph[], range: TextRange) => TextParagraph[]): void {
    const session = this.session
    const spec = this.currentSpec()
    if (!session || !spec) return
    const range = this.currentSelection()
    const parts = inserted(session.paragraphs, range)
    const caret = range.start + richTextLength(parts)
    this.edit(kind, (paragraphs) => replaceRange(paragraphs, range.start, range.end, parts, spec.rich ? baseFormat(spec.style) : undefined), {
      start: caret,
      end: caret,
    })
  }

  // DOM を読み直して、ノードに入れる。normalize なら、ブラウザが変えた DOM を書き出した形に整える
  private syncFromDom(normalize: boolean): void {
    const session = this.session
    const spec = this.currentSpec()
    if (!session || !spec) return
    const selection = window.getSelection()
    const inside = selection && selection.rangeCount > 0 && session.element.contains(selection.anchorNode)
    const points = inside ? [{ node: selection.anchorNode!, offset: selection.anchorOffset }, { node: selection.focusNode!, offset: selection.focusOffset }] : []
    const read = readRichTextDom(session.element, points)
    let paragraphs = normalizeRichText(read.paragraphs, spec.rich ? baseFormat(spec.style) : undefined)
    if (!spec.rich) paragraphs = richTextFromPlain(plainTextOf(paragraphs))
    if (JSON.stringify(paragraphs) !== JSON.stringify(session.paragraphs)) this.commit(paragraphs)
    const [anchor, focus] = read.offsets
    if (anchor !== null && anchor !== undefined && focus !== null && focus !== undefined) this.rememberSelection(anchor, focus)
    if (normalize && session.element.innerHTML !== richTextHtml(document, session.paragraphs, spec.style)) this.rerender()
  }

  // DOM を今の文字で書き直す（IME で変換している間は書き直さない）
  private rerender(): void {
    const session = this.session
    const spec = this.currentSpec()
    if (!session || !spec || session.composing) return
    renderRichTextDom(session.element, session.paragraphs, spec.style)
    if (document.activeElement === session.element) {
      const { start, end, backward } = session.selection
      if (backward) this.select(end, start)
      else this.select(start, end)
    }
    this.updateHighlight()
  }

  // ---- 選択範囲 ----

  // anchor から focus までを選ぶ（anchor > focus なら後ろ向き）
  private select(anchor: number, focus: number): void {
    const session = this.session
    if (!session) return
    this.rememberSelection(anchor, focus)
    if (document.activeElement !== session.element) {
      this.updateHighlight()
      return
    }
    const selection = window.getSelection()
    if (!selection) return
    const a = domPointAt(session.element, anchor)
    const f = domPointAt(session.element, focus)
    selection.setBaseAndExtent(a.node, a.offset, f.node, f.offset)
  }

  private rememberSelection(anchor: number, focus: number): void {
    const session = this.session
    if (!session) return
    const length = richTextLength(session.paragraphs)
    const a = Math.max(0, Math.min(length, anchor))
    const f = Math.max(0, Math.min(length, focus))
    session.selection = { start: Math.min(a, f), end: Math.max(a, f), backward: f < a }
    // カーソルが動いたら、次に打つ文字の書式（MAI-79）を捨てる
    if (session.pending && (a !== session.pending.at || f !== session.pending.at)) session.pending = null
    this.notifySelection()
  }

  // 今の選択範囲。フォーカスがあれば DOM から読み、なければ覚えているもの
  private currentSelection(): TextRange {
    const session = this.session!
    if (document.activeElement === session.element && !session.composing) this.readDomSelection()
    return { start: session.selection.start, end: session.selection.end }
  }

  private readDomSelection(): void {
    const session = this.session
    const selection = window.getSelection()
    if (!session || !selection || selection.rangeCount === 0 || !session.element.contains(selection.anchorNode)) return
    const read = readRichTextDom(session.element, [
      { node: selection.anchorNode!, offset: selection.anchorOffset },
      { node: selection.focusNode!, offset: selection.focusOffset },
    ])
    const [anchor, focus] = read.offsets
    if (anchor !== null && anchor !== undefined && focus !== null && focus !== undefined) this.rememberSelection(anchor, focus)
  }

  private readonly onSelectionChange = (): void => {
    const session = this.session
    if (!session || session.composing || document.activeElement !== session.element) return
    this.readDomSelection()
  }

  private notifySelection(): void {
    const session = this.session
    const next: TextSelection | null = session
      ? { nodeId: session.nodeId, start: session.selection.start, end: session.selection.end, pending: session.pending?.patch ?? null, revision: session.revision }
      : null
    const prev = this.selectionSnapshot
    if (
      prev === next ||
      (prev &&
        next &&
        prev.nodeId === next.nodeId &&
        prev.start === next.start &&
        prev.end === next.end &&
        prev.revision === next.revision &&
        JSON.stringify(prev.pending) === JSON.stringify(next.pending))
    )
      return
    this.selectionSnapshot = next
    for (const listener of this.selectionListeners) listener()
  }

  // フォーカスがないあいだ、選んでいる範囲を見せる
  private updateHighlight(): void {
    const session = this.session
    if (!session || !session.parked || session.selection.start === session.selection.end) {
      clearHighlight()
      return
    }
    const registry = highlightRegistry()
    if (!registry) return
    const range = document.createRange()
    const a = domPointAt(session.element, session.selection.start)
    const b = domPointAt(session.element, session.selection.end)
    range.setStart(a.node, a.offset)
    range.setEnd(b.node, b.offset)
    registry.set(TEXT_SELECTION_HIGHLIGHT, new (globalThis as unknown as { Highlight: new (range: Range) => unknown }).Highlight(range))
  }

  // ---- Undo（編集中だけ） ----

  private pushUndo(kind: string): void {
    const session = this.session
    if (!session) return
    const now = Date.now()
    const last = session.lastEdit
    session.lastEdit = { kind, time: now }
    if (last && last.kind === kind && kind !== 'paragraph' && kind !== 'list' && kind !== 'toggle' && now - last.time < UNDO_GROUP_MS) return
    session.undo.push({ paragraphs: session.paragraphs, selection: { start: session.selection.start, end: session.selection.end } })
    if (session.undo.length > UNDO_LIMIT) session.undo.shift()
    session.redo = []
  }

  private undoRedo(direction: 'undo' | 'redo'): void {
    const session = this.session
    if (!session) return
    const from = direction === 'undo' ? session.undo : session.redo
    const to = direction === 'undo' ? session.redo : session.undo
    const snapshot = from.pop()
    if (!snapshot) return
    to.push({ paragraphs: session.paragraphs, selection: { start: session.selection.start, end: session.selection.end } })
    session.lastEdit = null
    this.commit(snapshot.paragraphs)
    this.rerender()
    this.select(snapshot.selection.start, snapshot.selection.end)
  }

  // ---- 入力 ----

  private onBeforeInput(e: InputEvent): void {
    const session = this.session
    const spec = this.currentSpec()
    if (!session || !spec) return
    // IME の変換はブラウザに任せる（変換を終えたときに DOM を読む）
    if (e.isComposing || session.composing || e.inputType === 'insertCompositionText') return
    const range = this.currentSelection()
    const collapsed = range.start === range.end
    const type = e.inputType
    if (type === 'insertParagraph' || type === 'insertLineBreak') {
      e.preventDefault()
      // 空のリストの項目で Enter：階層を 1 つ上げる。一番外なら、リストを抜ける（MAI-78）
      const at = collapsed && spec.rich ? this.paragraphAt(range.start) : null
      const list = at && listOf(at.paragraph)
      if (at && list && paragraphText(at.paragraph) === '') {
        this.edit('list', (paragraphs) => (list.level > 0 ? indentList(paragraphs, range, -1) : paragraphs.map((p, i) => (i === at.index ? withList(p, undefined) : p))), range)
        return
      }
      // 新しい段落は、分けた段落の属性を引き継ぐ（箇条書きなど。MAI-78）。見出しの終わりで分けたら、次の段落は見出しの書式にしない
      const plainNext = at && spec.rich ? this.afterHeading(at, range.start) : null
      this.replaceSelection('paragraph', (paragraphs, r) => {
        const at = sliceRichText(paragraphs, r.start, r.start)[0]
        return [
          { ...at, runs: [] },
          { ...at, runs: plainNext ? [plainNext] : [] },
        ]
      })
      return
    }
    if (type === 'insertText' || type === 'insertReplacementText') {
      if (collapsed && type === 'insertText' && spec.rich && ((e.data === ' ' && this.convertToList(range.start)) || ((e.data === ' ' || e.data === '\u3000') && this.convertToHeading(range.start, e.data)))) {
        e.preventDefault()
        return
      }
      if (collapsed && type === 'insertText' && e.data && spec.rich && this.convertMarkdownShortcut(range.start, e.data)) {
        e.preventDefault()
        return
      }
      // カーソルの位置で書式を切り替えていれば（MAI-79）、その書式で入れる
      const pending = session.pending
      if (collapsed && pending && pending.at === range.start && type === 'insertText' && e.data) {
        e.preventDefault()
        const text = e.data
        this.replaceSelection('typing', (paragraphs, r) => richTextFromPlain(text, cleanFormat({ ...formatAt(paragraphs, r.start), ...pending.patch })))
        return
      }
      if (collapsed) {
        this.pushUndo('typing')
        return
      }
      // 範囲を打ち替える：最初の文字の書式で（ブラウザに任せると、消した文字の style を付けた要素を作ることがある）
      e.preventDefault()
      const text = e.data ?? e.dataTransfer?.getData('text/plain') ?? ''
      this.replaceSelection('typing', (paragraphs, r) => richTextFromPlain(text, formatOfCharAt(paragraphs, r.start)))
      return
    }
    if (type.startsWith('delete')) {
      if (type === 'deleteByCut' || type === 'deleteByDrag') {
        e.preventDefault()
        return
      }
      const backward = type.includes('Backward')
      if (!collapsed) {
        e.preventDefault()
        this.replaceSelection('delete', () => [])
        return
      }
      // リストの段落の頭で Backspace：リストを外す（段落はつながない。MAI-78）
      if (backward && spec.rich && type === 'deleteContentBackward') {
        const at = this.paragraphAt(range.start)
        if (at.start === range.start && listOf(at.paragraph)) {
          e.preventDefault()
          this.edit('list', (paragraphs) => paragraphs.map((p, i) => (i === at.index ? withList(p, undefined) : p)), range)
          return
        }
      }
      // 段落の境目をまたぐ削除（段落をつなぐ）は、ここで行う
      const boundary = this.atParagraphBoundary(range.start, backward)
      if (boundary) {
        e.preventDefault()
        const start = backward ? range.start - 1 : range.start
        this.edit('delete', (paragraphs) => replaceRange(paragraphs, start, start + 1, [], spec.rich ? baseFormat(spec.style) : undefined), { start, end: start })
        return
      }
      this.pushUndo('delete')
      return
    }
    if (type === 'historyUndo' || type === 'historyRedo') {
      e.preventDefault()
      this.undoRedo(type === 'historyUndo' ? 'undo' : 'redo')
      return
    }
    // 太字などのブラウザの書式（<b> などを作る）と、ドロップ・貼り付け（paste で行う）は使わない
    if (type.startsWith('format') || type.startsWith('insertFrom')) e.preventDefault()
  }

  // offset のある段落と、その頭の位置
  private paragraphAt(offset: number): { index: number; paragraph: TextParagraph; start: number } {
    const { paragraphs } = this.session!
    const index = paragraphIndexesInRange(paragraphs, offset, offset)[0]
    let start = 0
    for (let i = 0; i < index; i++) start += paragraphText(paragraphs[i]).length + 1
    return { index, paragraph: paragraphs[index], start }
  }

  // 段落の頭に「- 」などを打った：打った文字を消してリストにする（MAI-78）。変えなければ false。
  // Undo で、空白まで打った文字に戻れるようにする
  private convertToList(caret: number): boolean {
    const session = this.session!
    const spec = this.currentSpec()
    if (!spec?.rich) return false
    const at = this.paragraphAt(caret)
    if (listOf(at.paragraph)) return false
    const list = listShortcut(paragraphText(at.paragraph).slice(0, caret - at.start))
    if (!list) return false
    const base = baseFormat(spec.style)
    const typed = replaceRange(session.paragraphs, caret, caret, richTextFromPlain(' ', formatAt(session.paragraphs, caret)), base)
    this.pushUndo('typing')
    session.undo.push({ paragraphs: typed, selection: { start: caret + 1, end: caret + 1 } })
    session.redo = []
    session.lastEdit = null
    const removed = replaceRange(session.paragraphs, at.start, caret, [], base)
    this.commit(removed.map((p, i) => (i === at.index ? withList(p, list) : p)))
    this.rerender()
    this.select(at.start, at.start)
    return true
  }

  // 段落の頭に「# 」などを打った：記号を消して、段落を見出しの書式にする（richMarkdown.ts の markdownHeadingFormat）。変えなければ false。
  // リストの段落では変えない。Undo で、空白まで打った文字に戻れるようにする
  private convertToHeading(caret: number, space: string): boolean {
    const session = this.session!
    const spec = this.currentSpec()
    if (!spec?.rich) return false
    const at = this.paragraphAt(caret)
    if (listOf(at.paragraph)) return false
    const depth = headingShortcutDepth(paragraphText(at.paragraph).slice(0, caret - at.start))
    if (depth === 0) return false
    const base = baseFormat(spec.style)
    const heading = markdownHeadingFormat(depth, base)
    const typed = replaceRange(session.paragraphs, caret, caret, richTextFromPlain(space, formatAt(session.paragraphs, caret)), base)
    this.pushUndo('typing')
    session.undo.push({ paragraphs: typed, selection: { start: caret + 1, end: caret + 1 } })
    session.redo = []
    session.lastEdit = null
    const removed = replaceRange(session.paragraphs, at.start, caret, [], base)
    // 段落の文字（空なら、そこで打つ文字の書式）を見出しの書式にする
    const formatted = removed.map((paragraph, i) =>
      i === at.index
        ? {
            ...paragraph,
            runs: paragraph.runs.map((run) => {
              const format = cleanFormat({ ...run.format, ...heading })
              return format ? { text: run.text, format } : { text: run.text }
            }),
          }
        : paragraph,
    )
    this.commit(normalizeRichText(formatted, base))
    this.rerender()
    this.select(at.start, at.start)
    return true
  }

  // 見出しの書式の段落の終わりで Enter を押したときの、次の段落の空の run（見出しの書式を外したもの）。見出しでなければ null
  private afterHeading(at: { paragraph: TextParagraph; start: number }, caret: number): TextParagraph['runs'][number] | null {
    const spec = this.currentSpec()
    if (!spec?.rich) return null
    const text = paragraphText(at.paragraph)
    if (text === '' || caret !== at.start + text.length) return null
    const base = baseFormat(spec.style)
    const runs = at.paragraph.runs.filter((run) => run.text !== '')
    if (!runs.every((run) => isMarkdownHeadingFormat(resolveFormat(base, run.format), base))) return null
    const format = cleanFormat({ ...formatAt(this.session!.paragraphs, caret), fontWeight: undefined, fontSize: undefined, bold: undefined })
    return format ? { text: '', format } : { text: '' }
  }

  // 閉じる記号を打った：**太字** などの記号を消して、中身を書式にする（richMarkdown.ts の markdownShortcutAt）。変えなければ false。
  // Undo で、記号まで打った文字に戻れるようにする。書式にした文字のあとに打つ文字は、開く記号の前の文字の書式に戻す
  private convertMarkdownShortcut(caret: number, typed: string): boolean {
    if (!/^[*~`}]$/.test(typed)) return false
    const session = this.session!
    const spec = this.currentSpec()
    if (!spec?.rich || this.typingFormat(caret)?.fontFamily === MARKDOWN_CODE_FONT) return false
    const at = this.paragraphAt(caret)
    const shortcut = markdownShortcutAt(paragraphText(at.paragraph).slice(0, caret - at.start) + typed)
    if (!shortcut) return false
    const base = baseFormat(spec.style)
    const typedParagraphs = replaceRange(session.paragraphs, caret, caret, richTextFromPlain(typed, this.typingFormat(caret)), base)
    const offset = (n: number) => at.start + n
    const before = formatAt(typedParagraphs, offset(shortcut.start))
    let next = applyRunFormat(typedParagraphs, offset(shortcut.innerStart), offset(shortcut.innerEnd), shortcut.format, base)
    next = replaceRange(next, offset(shortcut.innerEnd), offset(shortcut.end), [], base)
    next = replaceRange(next, offset(shortcut.start), offset(shortcut.innerStart), [], base)
    this.pushUndo('typing')
    session.undo.push({ paragraphs: typedParagraphs, selection: { start: caret + 1, end: caret + 1 } })
    session.redo = []
    session.lastEdit = null
    this.commit(next)
    this.rerender()
    const end = offset(shortcut.innerEnd) - (shortcut.innerStart - shortcut.start)
    this.select(end, end)
    const patch: TextRunFormatPatch = {}
    for (const key of Object.keys(shortcut.format) as (keyof TextRunFormat)[]) (patch as Record<string, unknown>)[key] = before?.[key]
    session.pending = { at: end, patch }
    this.notifySelection()
    return true
  }

  // Tab / Shift+Tab：選んでいる段落のうち、リストの段落の階層を上げ下げする（MAI-78）
  private indentSelection(delta: number): void {
    const session = this.session
    if (!session || !this.currentSpec()?.rich) return
    const range = this.currentSelection()
    const indexes = paragraphIndexesInRange(session.paragraphs, range.start, range.end)
    if (!indexes.some((i) => listOf(session.paragraphs[i]))) return
    this.edit('list', (paragraphs) => indentList(paragraphs, range, delta), range)
  }

  // offset が、削除の向きで段落の境目にあるか（後ろ向きなら段落の頭、前向きなら段落の終わり）
  private atParagraphBoundary(offset: number, backward: boolean): boolean {
    const session = this.session!
    let start = 0
    for (const [i, paragraph] of session.paragraphs.entries()) {
      const length = paragraph.runs.reduce((sum, run) => sum + run.text.length, 0)
      if (backward && offset === start) return i > 0
      if (!backward && offset === start + length) return i < session.paragraphs.length - 1
      start += length + 1
    }
    return false
  }

  private onInput(e: InputEvent): void {
    const session = this.session
    if (!session) return
    this.syncFromDom(!(e.isComposing || session.composing))
  }

  private onCompositionStart(): void {
    const session = this.session
    if (!session) return
    this.readDomSelection()
    this.pushUndo('compose')
    // カーソルの位置で書式を切り替えていれば（MAI-79）、確定した文字に当てる
    const { start, end } = session.selection
    session.composePending = session.pending && start === end && session.pending.at === start ? session.pending : null
    session.composing = true
  }

  private onCompositionEnd(): void {
    const session = this.session
    if (!session) return
    session.composing = false
    // 確定した文字を読み、DOM を整える（変換の途中の input では書き直していない）
    this.syncFromDom(true)
    const pending = session.composePending
    session.composePending = null
    const spec = this.currentSpec()
    const caret = session.selection.end
    if (pending && spec?.rich && caret > pending.at) {
      // Undo は変換を始めたときに積んである（変換の前の文字に戻る）
      this.commit(applyRunFormat(session.paragraphs, pending.at, caret, pending.patch, baseFormat(spec.style)))
      this.rerender()
      this.select(caret, caret)
    }
  }

  // ---- クリップボード ----

  private onCopy(e: ClipboardEvent, cut: boolean): void {
    const session = this.session
    const spec = this.currentSpec()
    if (!session || !spec || !e.clipboardData) return
    const range = this.currentSelection()
    e.preventDefault()
    if (range.start === range.end) return
    const slice = sliceRichText(session.paragraphs, range.start, range.end)
    const base = baseFormat(spec.style)
    const data = textClipboardData(resolveRichText(slice, base))
    // ほかのアプリへ渡す文字：太字・斜体・取り消し線・等幅・リストがあれば普通の Markdown、なければプレーンテキスト
    e.clipboardData.setData('text/plain', (spec.rich ? standardMarkdownOf(slice, base) : null) ?? data.plain)
    if (spec.rich) {
      e.clipboardData.setData(TEXT_CLIPBOARD_MIME, data.json)
      e.clipboardData.setData('text/html', data.html)
    }
    if (cut) this.replaceSelection('delete', () => [])
  }

  private onPaste(e: ClipboardEvent): void {
    const session = this.session
    const spec = this.currentSpec()
    if (!session || !spec || !e.clipboardData) return
    e.preventDefault()
    const plainOnly = this.plainPaste
    this.plainPaste = false
    const data = e.clipboardData
    const rich = spec.rich && !plainOnly ? parseTextClipboard({ json: data.getData(TEXT_CLIPBOARD_MIME), html: data.getData('text/html') }) : null
    if (rich) {
      this.replaceSelection('paste', () => rich)
      return
    }
    const text = data.getData('text/plain')
    if (!text) return
    if (!spec.rich) {
      this.replaceSelection('paste', () => richTextFromPlain(text))
      return
    }
    // 文字は Markdown として読む（書式もリストもなければ、そのままの文字。Ctrl+Shift+V なら書式なし）。書式のない所は、貼った位置で打つ文字の書式にする。
    // 段落の途中に貼るときは、最初の行をリストとして読まない（その段落の続きになる）。段落の頭に貼った最初の行がリストなら、その段落をリストにする。
    // リストでない段落は、貼った位置の段落の属性（リストなど。MAI-78）を引き継ぐ（Enter と同じ）
    const range = this.currentSelection()
    const at = this.paragraphAt(range.start)
    const atStart = range.start === at.start
    const base = baseFormat(spec.style)
    const typing = formatAt(session.paragraphs, range.start)
    const read = plainOnly ? richTextFromPlain(text) : richTextFromPaste(text, { base, inlineFirstLine: !atStart })
    const pasted = read.map((paragraph) => ({
      ...paragraph,
      runs: paragraph.runs.map((run) => {
        const format = cleanFormat({ ...typing, ...run.format })
        return format ? { text: run.text, format } : { text: run.text }
      }),
    }))
    const firstList = atStart ? listOf(pasted[0]!) : undefined
    const { runs: _runs, ...attributes } = sliceRichText(session.paragraphs, range.start, range.start)[0]
    const parts = pasted.map((paragraph) => ({ ...attributes, ...paragraph }))
    const caret = range.start + richTextLength(parts)
    this.edit(
      'paste',
      (paragraphs) => {
        const next = replaceRange(paragraphs, range.start, range.end, parts, base)
        return firstList ? next.map((paragraph, i) => (i === at.index ? withList(paragraph, firstList) : paragraph)) : next
      },
      { start: caret, end: caret },
    )
  }

  // ---- フォーカス ----

  // ページの中でフォーカスが移ったら編集を終える。
  // 別のアプリ（Shift+Space で窓を出す入力ツールなど）に窓ごとフォーカスを取られただけなら、編集を続ける（MAI-70）。
  // デザインパネルに移ったときも、編集を続ける（MAI-74）
  private onBlur(e: FocusEvent): void {
    const session = this.session
    if (!session || this.finishing) return
    const related = e.relatedTarget
    if (related instanceof Element && related.closest(`[${KEEP_TEXT_EDITING_ATTRIBUTE}]`)) {
      session.parked = true
      document.addEventListener('focusin', this.onFocusIn)
      this.updateHighlight()
      return
    }
    if (document.hasFocus()) {
      this.finish()
      return
    }
    session.pendingSelection = { start: session.selection.start, end: session.selection.end }
    window.addEventListener('focus', this.onWindowFocus)
  }

  // デザインパネルにフォーカスがあるあいだ、フォーカスがほかへ移ったら編集を終える。編集用の要素に戻れば続ける
  private readonly onFocusIn = (e: FocusEvent): void => {
    const session = this.session
    if (!session) return
    const target = e.target
    if (target === session.element) {
      this.unpark()
      return
    }
    if (target instanceof Element && target.closest(`[${KEEP_TEXT_EDITING_ATTRIBUTE}]`)) return
    this.finish()
  }

  private unpark(): void {
    const session = this.session
    if (!session?.parked) return
    session.parked = false
    document.removeEventListener('focusin', this.onFocusIn)
    clearHighlight()
  }

  // 窓に戻ったら、編集用の要素にフォーカスとカーソルを戻す（ツールから送られた文字が元の位置に入るように）
  private readonly onWindowFocus = (): void => {
    window.removeEventListener('focus', this.onWindowFocus)
    const session = this.session
    const selection = session?.pendingSelection
    if (!session || !selection) return
    session.pendingSelection = null
    session.element.focus({ preventScroll: true })
    this.select(selection.start, selection.end)
  }

  private onKeyDown(e: KeyboardEvent): void {
    // IME で変換している間の Esc・Enter は、変換の操作なので編集を終えない
    if (isImeEvent(e)) return
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault()
      e.stopPropagation()
      this.finish()
      return
    }
    const mod = e.ctrlKey || e.metaKey
    // Ctrl（⌘）+Shift+V：次の貼り付けを書式なしの文字にする（貼り付けそのものは paste イベントで行う）
    this.plainPaste = mod && e.shiftKey && !e.altKey && (e.key.toLowerCase() === 'v' || e.code === 'KeyV')
    // Tab はフォーカスを移さず、キャンバスのショートカットにも渡さない。リストの段落なら階層を上げ下げする（MAI-78）
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      this.indentSelection(e.shiftKey ? -1 : 1)
      return
    }
    // 太字・斜体・下線・取り消し線（MAI-79）。ブラウザの書式（execCommand）にもキャンバスのショートカットにも渡さない
    const toggle = mod && !e.altKey ? toggleFormatOfKey(e) : null
    if (toggle) {
      e.preventDefault()
      e.stopPropagation()
      if (!e.repeat) this.toggleFormat(toggle)
      return
    }
    const key = e.key.toLowerCase()
    if (mod && !e.altKey && (key === 'z' || key === 'y')) {
      e.preventDefault()
      e.stopPropagation()
      this.undoRedo(key === 'y' || e.shiftKey ? 'redo' : 'undo')
    }
  }
}

// 書式を切り替えるキー（Ctrl（⌘）を押しているとき）：B・I・U、Shift+X。
// 英字の配列でない（key が英字でない）ときは、キーの場所（code）で見る
export function toggleFormatOfKey(e: Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey'>): TextToggleFormat | null {
  const letter = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : ''
  if (e.shiftKey) return letter === 'x' ? 'strikethrough' : null
  return letter === 'b' ? 'bold' : letter === 'i' ? 'italic' : letter === 'u' ? 'underline' : null
}

// 編集する文字。範囲ごとの書式を持たない型は、プレーンテキストを 1 つの書式の段落にする
function editParagraphs(spec: TextEditSpec<object>): TextParagraph[] {
  return spec.rich ? normalizeRichText(spec.rich.paragraphs, baseFormat(spec.style)) : richTextFromPlain(spec.text)
}

// ノードの既定の書式（run が持たない値）
function baseFormat(style: TextStyle): Required<TextRunFormat> {
  return baseFormatOf(style)
}

function applyEditorStyle(element: HTMLElement, spec: TextEditSpec<object>): void {
  const { style } = spec
  element.style.font = cssFont(style)
  element.style.lineHeight = cssLineHeight(style)
  // 文字間（MAI-77）。em は要素ごとの文字の大きさで換算するので、段落・run の要素にも付ける（richTextDom.ts）
  element.style.letterSpacing = cssLetterSpacing(style)
  element.style.color = style.color
  element.style.caretColor = style.color
  element.style.textAlign = style.align
  // 幅が伸びるテキストは折り返さない
  element.style.whiteSpace = spec.autoWidth ? 'pre' : 'pre-wrap'
}

function highlightRegistry(): Map<string, unknown> | null {
  const css = (globalThis as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS
  return css?.highlights && 'Highlight' in globalThis ? css.highlights : null
}

function clearHighlight(): void {
  highlightRegistry()?.delete(TEXT_SELECTION_HIGHLIGHT)
}
