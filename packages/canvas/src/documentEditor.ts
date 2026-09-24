import { CODE_CARD_METRICS } from '@canvcode/nodes'
import { createCodeEditor, type CodeEditorHandle } from './codeEditor.ts'
import type { Editor } from './editor.ts'
import type { FileManager } from './files.ts'

// カードの上での本文の編集（MAI-9 の「5. 編集モードの挙動」、MAI-30）。
// ダブルクリック（または選んで Enter）で、カードの位置と倍率に合わせた CodeMirror を編集用の DOM レイヤーに重ねる。
// 本文は File に直接書く（少し待ってまとめて保存する）。キャンバスの履歴には入れない。
// Esc かカードの外をクリックで終える。Ctrl（⌘）+Enter で全画面のエディタに切り替える。

export interface DocumentEditorOptions {
  getEditor: () => Editor
  layer: HTMLElement
  files: FileManager
  // キャンバス側で Space を押しているときは、カード上のドラッグをパンに渡す
  isSpaceHeld?: () => boolean
  // 編集を始めた・終えたとき（カードの本文を隠す・戻すため）
  onChange(editingId: string | null): void
  // 全画面のエディタで開く
  onFullscreen(fileId: string): void
  // 選んだ文字を引用する（帯の「引用」ボタン。Markdown のとき。MAI-33）。line は選んだ範囲の始まりの行（1 から）
  onQuote?(request: { nodeId: string; fileId: string; quote: string; line: number; clientX: number; clientY: number }): void
  // 選んでいる行を AI に渡す（帯の「AIに渡す」ボタン。Markdown と Python）
  onReference?(request: { nodeId: string; fileId: string; startLine: number; endLine: number; snapshot: string }): void
}

interface Session {
  nodeId: string
  fileId: string
  host: HTMLDivElement
  editor: CodeEditorHandle
  // カードの高さの決め方（layout() で最新にする）。'auto' なら、エディタも中身の高さに合わせて伸ばし、中でスクロールしない
  sizing: 'auto' | 'fixed'
  unlisten: () => void
}

// 編集するときの最小の高さ（ワールド座標）。短い本文でも打ちやすいように
const MIN_EDIT_HEIGHT = 220
// 名前の帯の高さ。Markdown・コードのカードの帯（HEADER_H = 36）と同じ
const HEADER_H = CODE_CARD_METRICS.headerHeight
const EDITABLE_CARDS = new Set(['markdown-card', 'code-card'])

export class DocumentEditor {
  private readonly options: DocumentEditorOptions
  private session: Session | null = null

  constructor(options: DocumentEditorOptions) {
    this.options = options
  }

  get editingId(): string | null {
    return this.session?.nodeId ?? null
  }

  // 編集できるノード（本文を持つ File のカード）か
  canEdit(nodeId: string): boolean {
    const editor = this.options.getEditor()
    const node = editor.getNode(nodeId)
    if (!node || node.locked || !EDITABLE_CARDS.has(node.type)) return false
    const ref = editor.workspace.referenceOf(node)
    return ref !== null && editor.workspace.getFile(ref.targetId) !== undefined
  }

  async start(nodeId: string): Promise<boolean> {
    if (this.session) this.finish()
    const editor = this.options.getEditor()
    const node = editor.getNode(nodeId)
    if (!node || !this.canEdit(nodeId)) return false
    const fileId = editor.workspace.referenceOf(node)!.targetId
    const kind = editor.workspace.getFile(fileId)!.kind
    if (editor.workspace.targetStatus(fileId) !== 'ok') return false
    const text = await this.options.files.text(fileId)
    if (text === null || this.options.getEditor() !== editor || !editor.getNode(nodeId)) return false

    const host = document.createElement('div')
    host.className = 'canvcode-document-editor'
    Object.assign(host.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      transformOrigin: '0 0',
      pointerEvents: 'auto',
      display: 'flex',
      flexDirection: 'column',
      background: '#ffffff',
      // 枠は border ではなく outline（箱の外側）で描く。border だと中身が枠の太さだけ内側へずれ、描いたカードの文字と合わなくなる（MAI-55）
      outline: '2px solid #2f6fed',
      borderRadius: '10px',
      boxSizing: 'border-box',
      overflow: 'hidden',
      boxShadow: '0 4px 18px rgba(0, 0, 0, 0.12)',
    })
    const header = document.createElement('div')
    Object.assign(header.style, {
      flexShrink: '0',
      // 下の線も含めてカードの帯（HEADER_H）と同じ高さにする（MAI-55）
      height: `${HEADER_H}px`,
      boxSizing: 'border-box',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 12px',
      background: kind === 'markdown' ? 'rgba(245, 231, 197, 0.55)' : '#eef2f7',
      borderBottom: '1px solid rgba(80, 66, 45, 0.16)',
      font: "600 13px 'Noto Sans JP', sans-serif",
      color: '#2b2930',
    })
    const title = document.createElement('span')
    title.textContent = editor.workspace.getFile(fileId)?.title ?? ''
    const hint = document.createElement('span')
    hint.textContent = 'Esc で終える ／ Ctrl+Enter で全画面'
    Object.assign(hint.style, { fontWeight: '400', fontSize: '11px', color: '#8c959f', marginLeft: 'auto', marginRight: '8px' })
    header.append(title, hint)
    // Markdown は、選んだ文字を引用できる（MAI-33）
    const quoteButton = kind === 'markdown' && this.options.onQuote ? headerButton('引用', '選んだ文字を引用する', 'canvcode-quote-button') : null
    // 選んでいる行を、AI に渡す ID にしてコピーする
    const refButton = this.options.onReference
      ? headerButton('AIに渡す', '選んでいる行を指す ID をコピーする（AI に貼り付けると、AI がその行を読めます）', 'canvcode-ref-button')
      : null
    if (refButton) header.append(refButton)
    if (quoteButton) header.append(quoteButton)
    const body = document.createElement('div')
    Object.assign(body.style, { flex: '1', minHeight: '0' })
    host.append(header, body)
    // キャンバスのポインタ操作に渡さない。
    // ホイールは、カードの高さが固定（sizing: 'fixed'）のときだけエディタの中のスクロールに使い、キャンバスのパンに渡さない。
    // 高さを中身に合わせているとき（'auto'）は、ブラウザ既定のエディタ内スクロールを止めつつ、
    // イベントは伝播させてキャンバスのパン・ズームに渡す（止めると、見切れているカードへ動けなくなる。MAI-45）。
    // Ctrl（⌘）+ホイールとトラックパッドのピンチ（ブラウザは ctrlKey 付きの wheel として送る）は、
    // いつもキャンバスのズームに渡す。止めてしまうと、ブラウザがページごと拡大してしまう
    host.addEventListener('pointerdown', (e) => {
      if (e.button === 1 || (e.button === 0 && this.options.isSpaceHeld?.())) return
      e.stopPropagation()
    })
    host.addEventListener(
      'wheel',
      (e) => {
        if (this.session?.host !== host) return
        if (this.session.sizing === 'fixed') stopUnlessZoom(e)
        else e.preventDefault()
      },
      { passive: false },
    )
    host.addEventListener('dblclick', (e) => e.stopPropagation())
    this.options.layer.appendChild(host)

    const code = createCodeEditor({
      parent: body,
      doc: text,
      language: kind === 'markdown' ? 'markdown' : 'python',
      placeholder: kind === 'markdown' ? 'Markdown を書く…' : 'Python を書く…',
      onChange: (value) => this.options.files.edit(fileId, value),
      onEscape: () => this.finish(),
      onModEnter: () => {
        this.finish()
        this.options.onFullscreen(fileId)
      },
    })
    // 外で本文が変わったら（衝突で「外の内容を使う」を選んだときなど）、エディタにも反映する
    const unlisten = this.options.files.onChange((changed) => {
      if (changed !== fileId || !this.session) return
      const latest = this.options.files.get(fileId)
      if (latest && latest.text !== code.text()) code.replace(latest.text)
    })
    quoteButton?.addEventListener('click', () => {
      const selected = code.selectedQuote()
      if (!selected) {
        hint.textContent = '引用する文字を選んでから押してください'
        return
      }
      const rect = quoteButton.getBoundingClientRect()
      this.options.onQuote?.({ nodeId, fileId, ...selected, clientX: rect.left, clientY: rect.bottom + 4 })
    })
    refButton?.addEventListener('click', () => {
      this.options.onReference?.({ nodeId, fileId, ...code.selectedLines() })
    })
    this.session = { nodeId, fileId, host, editor: code, sizing: sizingOf(node.props), unlisten }
    editor.setSelection([nodeId])
    this.options.onChange(nodeId)
    this.layout()
    code.focus()
    return true
  }

  finish(): void {
    const session = this.session
    if (!session) return
    this.session = null
    session.unlisten()
    session.editor.destroy()
    session.host.remove()
    void this.options.files.flush(session.fileId)
    this.options.onChange(null)
  }

  // カードの位置と倍率に合わせる（カメラやカードが動いたときに呼ぶ）
  layout(): void {
    const session = this.session
    if (!session) return
    const editor = this.options.getEditor()
    const entry = editor.index.get(session.nodeId)
    if (!entry) {
      this.finish()
      return
    }
    const camera = editor.session.get().camera
    const m = entry.worldMatrix
    const z = camera.zoom
    const { host } = session
    host.style.transform = `matrix(${m.a * z}, ${m.b * z}, ${m.c * z}, ${m.d * z}, ${(m.e - camera.x) * z}, ${(m.f - camera.y) * z})`
    host.style.width = `${entry.localBounds.w}px`
    const height = Math.max(entry.localBounds.h, MIN_EDIT_HEIGHT)
    const sizing = sizingOf(editor.getNode(session.nodeId)?.props)
    session.sizing = sizing
    const { dom, scrollDOM } = session.editor.view
    if (sizing === 'auto') {
      // 中身の高さに合わせて伸ばす（カードより短くはしない）。中にスクロールバーを出さない
      host.style.height = 'auto'
      host.style.minHeight = `${height}px`
      dom.style.height = 'auto'
      scrollDOM.style.overflow = 'visible'
    } else {
      host.style.height = `${height}px`
      host.style.minHeight = ''
      dom.style.height = ''
      scrollDOM.style.overflow = ''
    }
  }
}

// カードの高さの決め方。Markdown・コードのカードは sizing を持つ（既定は 'auto'）
function sizingOf(props: unknown): 'auto' | 'fixed' {
  return (props as { sizing?: unknown } | undefined)?.sizing === 'fixed' ? 'fixed' : 'auto'
}

export function stopUnlessZoom(e: WheelEvent): void {
  if (!e.ctrlKey && !e.metaKey) e.stopPropagation()
}

// 名前の帯のボタン。押しても、エディタの選択を失わないようにする
function headerButton(label: string, title: string, className: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.textContent = label
  button.title = title
  button.className = className
  Object.assign(button.style, {
    font: "600 11px 'Noto Sans JP', sans-serif",
    padding: '2px 10px',
    marginLeft: '6px',
    border: '1px solid rgba(80, 66, 45, 0.3)',
    borderRadius: '6px',
    background: '#ffffff',
    color: '#2b2930',
    cursor: 'pointer',
  })
  button.addEventListener('mousedown', (e) => e.preventDefault())
  return button
}
