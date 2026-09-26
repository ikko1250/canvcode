import { multiply, transformOf, type NodeRecord, type WorkspaceRecord, type Transaction } from '@canvcode/core'
import { cssFont, layoutText, type TextEditSpec } from '@canvcode/nodes'
import type { Editor } from './editor.ts'
import { stopUnlessZoom } from './documentEditor.ts'
import { isImeEvent } from './imeGuard.ts'

// 文字の編集モード（MAI-9、MAI-24）。
// 編集中は、ノードの位置・向き・倍率に合わせた textarea を編集用の DOM レイヤーに重ねる。
// 文字を打つたびに、同じトランザクションの中でノードを更新する（終えたときに 1 回の Undo になる）。
// フォント・行の高さ・折り返しの規則は、Canvas での描画（text/layout.ts）と同じにしてある。

export interface TextEditorOptions {
  // 今の Canvas の Editor（Canvas を移ると変わる）
  getEditor: () => Editor
  layer: HTMLElement
  getDpr(): number
  // 編集を始めた・終えたとき（シーンからノードを隠す・戻すため）
  onChange(editingId: string | null): void
}

interface Session {
  nodeId: string
  tx: Transaction<WorkspaceRecord>
  textarea: HTMLTextAreaElement
  // 窓ごとフォーカスを失ったときのカーソルの位置。窓に戻ったらここへ戻す（MAI-70）
  pendingSelection: { start: number; end: number } | null
}

// 打った文字のすぐ右にもカーソルを置けるよう、幅が伸びるテキストには少し余白を足す（fontSize に対する倍率）
const AUTO_WIDTH_SLACK_EM = 0.6

export class TextEditor {
  private readonly options: TextEditorOptions
  private session: Session | null = null
  private finishing = false

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
    const textarea = document.createElement('textarea')
    textarea.value = spec.text
    textarea.spellcheck = false
    textarea.setAttribute('autocomplete', 'off')
    Object.assign(textarea.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      margin: '0',
      padding: '0',
      border: 'none',
      outline: 'none',
      background: 'transparent',
      resize: 'none',
      overflow: 'hidden',
      transformOrigin: '0 0',
      pointerEvents: 'auto',
      // Canvas での折り返し（text/layout.ts）と同じ規則にする
      wordBreak: 'normal',
      overflowWrap: 'anywhere',
      lineBreak: 'strict',
      boxSizing: 'content-box',
    })
    textarea.addEventListener('input', () => this.onInput())
    textarea.addEventListener('keydown', (e) => this.onKeyDown(e))
    textarea.addEventListener('blur', () => this.onBlur())
    // キャンバスのポインタ操作（選択・ドラッグ）に渡さない
    textarea.addEventListener('pointerdown', (e) => e.stopPropagation())
    // ピンチと Ctrl（⌘）+ホイールはキャンバスのズームに渡す（止めると、ブラウザがページごと拡大してしまう）
    textarea.addEventListener('wheel', stopUnlessZoom, { passive: true })
    this.options.layer.appendChild(textarea)
    this.session = { nodeId, tx, textarea, pendingSelection: null }
    editor.setSelection([nodeId])
    this.options.onChange(nodeId)
    this.layout()
    textarea.focus({ preventScroll: true })
    if (options.selectAll) textarea.select()
    else textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    return true
  }

  finish(): void {
    const session = this.session
    if (!session || this.finishing) return
    this.finishing = true
    try {
      const editor = this.options.getEditor()
      const node = editor.getNode(session.nodeId)
      const spec = node ? editor.getType(node).editText?.(node) : undefined
      // 空のまま終えたテキストは消す（同じトランザクションなので、作ってすぐ消した場合は何も残らない）
      if (node && spec?.deleteIfEmpty && spec.text.trim() === '') session.tx.remove(node.id)
      if (!session.tx.isDone) editor.finish(session.tx)
      session.textarea.remove()
      if (session.pendingSelection) window.removeEventListener('focus', this.onWindowFocus)
      this.session = null
      this.options.onChange(null)
    } finally {
      this.finishing = false
    }
  }

  // カメラやノードが変わったときに、textarea の位置・大きさを合わせ直す
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
    const { textarea } = session
    const camera = editor.session.get().camera
    applyTextStyle(textarea, spec)
    const layout = layoutText(textarea.value, spec.style, spec.autoWidth ? null : spec.box.w)
    const width = Math.max(spec.autoWidth ? layout.width + spec.style.fontSize * AUTO_WIDTH_SLACK_EM : spec.box.w, spec.style.fontSize)
    // 幅が伸びるテキストの余白は右に付くので、中央揃え・右揃えでは Canvas の描画と同じ位置に文字が来るよう、その分だけ左へずらす（MAI-50）
    const slack = Math.max(0, width - spec.box.w)
    const offsetX = spec.style.align === 'center' ? -slack / 2 : spec.style.align === 'right' ? -slack : 0
    // ノードのローカル座標（文字の箱の左上）→ 画面の CSS ピクセル
    const local = multiply(entry.worldMatrix, transformOf(spec.box.x + offsetX, spec.box.y, 0))
    const z = camera.zoom
    textarea.style.transform = `matrix(${local.a * z}, ${local.b * z}, ${local.c * z}, ${local.d * z}, ${(local.e - camera.x) * z}, ${(local.f - camera.y) * z})`
    textarea.style.width = `${width}px`
    if (spec.verticalAlign === 'middle') {
      // 上下の中央に置く：上の余白で文字の高さの分だけずらす
      const padding = Math.max(0, (spec.box.h - layout.height) / 2)
      textarea.style.paddingTop = `${padding}px`
      textarea.style.height = `${Math.max(layout.height, spec.box.h - padding)}px`
    } else {
      textarea.style.paddingTop = '0'
      textarea.style.height = `${Math.max(layout.height, spec.autoWidth ? 0 : spec.box.h)}px`
    }
  }

  // 編集中のノードを、文字以外（文字の大きさ・揃えなど）で変える（パレットから。MAI-52）。
  // 編集のトランザクションが開いたままなので、ほかから transact で変えることはできない（begin が投げる）。
  // 同じトランザクションで変え、textarea をその場で合わせ直す。フォーカスとカーソルはそのまま。
  // 終えたときに、文字の編集と合わせて 1 回の Undo になる
  updateNode(update: (node: NodeRecord) => NodeRecord): boolean {
    const session = this.session
    if (!session) return false
    const editor = this.options.getEditor()
    const node = editor.getNode(session.nodeId)
    if (!node) return false
    session.tx.put(update(node))
    session.tx.flush()
    this.layout()
    return true
  }

  private onInput(): void {
    const session = this.session
    if (!session) return
    const editor = this.options.getEditor()
    const node = editor.getNode(session.nodeId)
    const spec = node ? editor.getType(node).editText?.(node) : undefined
    if (!node || !spec) return
    session.tx.put({ ...node, props: spec.update(session.textarea.value) })
    session.tx.flush()
    this.layout()
  }

  // ページの中でフォーカスが移ったら編集を終える。
  // 別のアプリ（Shift+Space で窓を出す入力ツールなど）に窓ごとフォーカスを取られただけなら、編集を続ける（MAI-70）
  private onBlur(): void {
    const session = this.session
    if (!session || this.finishing) return
    if (document.hasFocus()) {
      this.finish()
      return
    }
    const { textarea } = session
    session.pendingSelection = { start: textarea.selectionStart, end: textarea.selectionEnd }
    window.addEventListener('focus', this.onWindowFocus)
  }

  // 窓に戻ったら、textarea にフォーカスとカーソルを戻す（ツールから送られた文字が元の位置に入るように）
  private readonly onWindowFocus = (): void => {
    window.removeEventListener('focus', this.onWindowFocus)
    const session = this.session
    const selection = session?.pendingSelection
    if (!session || !selection) return
    session.pendingSelection = null
    session.textarea.focus({ preventScroll: true })
    session.textarea.setSelectionRange(selection.start, selection.end)
  }

  private onKeyDown(e: KeyboardEvent): void {
    // IME で変換している間の Esc・Enter は、変換の操作なので編集を終えない
    if (isImeEvent(e)) return
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault()
      e.stopPropagation()
      this.finish()
    }
  }
}

function applyTextStyle(textarea: HTMLTextAreaElement, spec: TextEditSpec<object>): void {
  const { style } = spec
  textarea.style.font = cssFont(style)
  textarea.style.lineHeight = String(style.lineHeight)
  textarea.style.color = style.color
  textarea.style.caretColor = style.color
  textarea.style.textAlign = style.align
  // 幅が伸びるテキストは折り返さない
  textarea.style.whiteSpace = spec.autoWidth ? 'pre' : 'pre-wrap'
}
