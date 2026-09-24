import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createCodeEditor, quoteRange, type FileManager, type QuoteDraft, type Workspace } from '@canvcode/canvas'
import { MARKDOWN_CARD_CSS, SOURCE_LINE_ATTR, renderMarkdown } from '@canvcode/nodes/markdown'
import 'katex/dist/katex.min.css'
import { buildScrollMap, previewToSource, sourceToPreview, type ScrollAnchor, type ScrollMap } from './scrollSync.ts'

// 全画面のエディタ（MAI-9 の「5. 編集モードの挙動」、MAI-30、MAI-31）。Markdown は左に本文、右にプレビュー。
// Python は本文だけ（行番号とインデントを保つ折り返しは、カードと同じ）。
// カードの上での編集と同じく、本文は File に直接書く（少し待ってまとめて保存する）。Esc か Ctrl（⌘）+Enter で閉じる

type Mode = 'both' | 'source' | 'preview'

const MODES: { mode: Mode; label: string }[] = [
  { mode: 'source', label: '本文' },
  { mode: 'both', label: '両方' },
  { mode: 'preview', label: 'プレビュー' },
]

// プレビューを描き直すまでの時間（打つたびに描き直すと重いので）
const PREVIEW_DELAY_MS = 150

// こちらで動かしたスクロールが相手の scroll イベントとして返ってくるのを無視する時間（MAI-44）。
// 普通は次の scroll イベントで解けるが、イベントが来なかったときのための保険
const SCROLL_ECHO_MS = 200

type Pane = 'source' | 'preview'

export function FileEditor(props: {
  workspace: Workspace
  files: FileManager
  fileId: string
  // 開いたときに選んで見せる引用（引用ノートの「出典へ」。MAI-33）
  focus?: { quote: string; line: number } | null
  // 選んだ文字の引用をコピーする（Markdown のとき）
  onQuote?(draft: QuoteDraft): void
  // 選んでいる行を AI に渡す ID をコピーする（Markdown と Python）
  onReference?(lines: { fileId: string; startLine: number; endLine: number; snapshot: string }): void
  // focus の文字列が見つからなかった（位置不明）
  onLost?(): void
  onClose(): void
}) {
  const { workspace, files, fileId, focus, onQuote, onReference, onLost, onClose } = props
  const file = workspace.getFile(fileId)
  const isCode = file?.kind === 'code'
  const [chosenMode, setMode] = useState<Mode>('both')
  // Python にはプレビューがない
  const mode: Mode = isCode ? 'source' : chosenMode
  const [text, setText] = useState<string | null>(null)
  // エディタを作り直した回数。スクロールの見張りを付け直す目印（MAI-44）
  const [editorVersion, setEditorVersion] = useState(0)
  const [previewText, setPreviewText] = useState('')
  const sourceRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<ReturnType<typeof createCodeEditor> | null>(null)

  // 本文を読み込んでから、エディタを作る
  useEffect(() => {
    let cancelled = false
    void files.text(fileId).then((loaded) => {
      if (!cancelled) setText(loaded ?? '')
    })
    return () => {
      cancelled = true
    }
  }, [files, fileId])

  useEffect(() => {
    const parent = sourceRef.current
    if (text === null || !parent) return
    const editor = createCodeEditor({
      parent,
      doc: text,
      language: isCode ? 'python' : 'markdown',
      placeholder: isCode ? 'Python を書く…' : 'Markdown を書く…',
      onChange: (value) => {
        files.edit(fileId, value)
        setPreviewText(value)
      },
      onEscape: onClose,
      onModEnter: onClose,
    })
    setPreviewText(text)
    editorRef.current = editor
    setEditorVersion((n) => n + 1)
    editor.focus()
    // 外で本文が変わったら（衝突で「外の内容を使う」を選んだときなど）、エディタにも反映する
    const unlisten = files.onChange((changed) => {
      if (changed !== fileId) return
      const latest = files.get(fileId)
      if (latest && latest.text !== editor.text()) {
        editor.replace(latest.text)
        setPreviewText(latest.text)
      }
    })
    return () => {
      unlisten()
      editorRef.current = null
      editor.destroy()
      void files.flush(fileId)
    }
    // text は読み込んだときに一度だけ決まる（そのあとの変更はエディタが持つ）
  }, [files, fileId, onClose, text, isCode])

  // 引用ノートから開いたときは、引用した範囲を選んで見せる。見つからなければ、覚えていた行へ
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !focus) return
    const text = editor.text()
    const range = quoteRange(text, focus.quote, focus.line)
    if (range) {
      editor.select(range.from, range.to)
    } else {
      // 覚えていた行の頭
      const at = text.split('\n').slice(0, Math.max(0, focus.line - 1)).reduce((n, line) => n + line.length + 1, 0)
      editor.select(at, at)
      onLost?.()
    }
    // エディタを作ったあと（text が決まったあと）に一度だけ
  }, [focus, text, onLost])

  const quoteSelection = () => {
    const editor = editorRef.current
    if (!editor || !onQuote) return
    const selected = editor.selectedQuote()
    if (!selected) return
    onQuote({ fileId, locator: { kind: 'markdown', line: selected.line }, quote: selected.quote, figure: null })
    editor.focus()
  }

  const referenceSelection = () => {
    const editor = editorRef.current
    if (!editor || !onReference) return
    onReference({ fileId, ...editor.selectedLines() })
    editor.focus()
  }

  // Esc は、エディタの外（プレビュー側など）にフォーカスがあるときも閉じる
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(previewText), PREVIEW_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [previewText])
  const html = useMemo(() => (isCode ? '' : renderMarkdown(debounced, { sourceLines: true }).html), [debounced, isCode])

  // 本文とプレビューのスクロールを合わせる（MAI-44）。
  // 本文が変わった（プレビューを描き直した）ときと、どちらかの大きさが変わったときに、行と要素の高さ位置の対応表を作り直す。
  // スクロールのたびには、表を引いて相手の scrollTop を決めるだけ（DOM は計らない）
  const scrollMapRef = useRef<ScrollMap | null>(null)
  // 最後に人がスクロールした側。表を作り直したあとは、こちらに合わせてもう一方を動かす
  const masterRef = useRef<Pane>('source')
  // こちらで動かした分の scroll イベントを無視する（相手→こちら→相手…と往復しないように）
  const echoRef = useRef<{ pane: Pane; until: number } | null>(null)
  const syncEnabled = mode === 'both' && !isCode

  const panes = useCallback((): { scroller: HTMLElement; preview: HTMLElement } | null => {
    const editor = editorRef.current
    const preview = previewRef.current
    if (!editor || !preview) return null
    return { scroller: editor.view.scrollDOM, preview }
  }, [])

  // 相手を動かす。動かなかった（すでに同じ位置、端に当たった）ときは何もしない
  const moveTo = useCallback((pane: Pane, element: HTMLElement, top: number) => {
    const before = element.scrollTop
    element.scrollTop = top
    if (element.scrollTop === before) return
    echoRef.current = { pane, until: performance.now() + SCROLL_ECHO_MS }
  }, [])

  const follow = useCallback(
    (from: Pane) => {
      const map = scrollMapRef.current
      const found = panes()
      if (!map || !found) return
      if (from === 'source') moveTo('preview', found.preview, sourceToPreview(map, found.scroller.scrollTop))
      else moveTo('source', found.scroller, previewToSource(map, found.preview.scrollTop))
    },
    [panes, moveTo],
  )

  const rebuildScrollMap = useCallback(() => {
    const editor = editorRef.current
    const found = panes()
    if (!editor || !found) {
      scrollMapRef.current = null
      return
    }
    const { scroller, preview } = found
    const { view } = editor
    const doc = view.state.doc
    const paddingTop = view.documentPadding.top
    const previewTop = preview.getBoundingClientRect().top - preview.scrollTop
    const anchors: ScrollAnchor[] = []
    for (const element of preview.querySelectorAll<HTMLElement>(`[${SOURCE_LINE_ATTR}]`)) {
      const line = Number(element.getAttribute(SOURCE_LINE_ATTR))
      if (!Number.isInteger(line) || line < 1 || line > doc.lines) continue
      anchors.push({
        source: view.lineBlockAt(doc.line(line).from).top + paddingTop,
        preview: element.getBoundingClientRect().top - previewTop,
      })
    }
    scrollMapRef.current = buildScrollMap(
      anchors,
      scroller.scrollHeight - scroller.clientHeight,
      preview.scrollHeight - preview.clientHeight,
    )
    follow(masterRef.current)
  }, [panes, follow])

  // プレビューを描き直したら、表を作り直す（描いた直後の DOM で計る）
  useLayoutEffect(() => {
    if (syncEnabled) rebuildScrollMap()
  }, [html, syncEnabled, editorVersion, rebuildScrollMap])

  // 大きさが変わったら（折り返しの計り直し、画像や数式フォントの読み込み、窓の大きさ）、次のフレームで作り直す
  useEffect(() => {
    const editor = editorRef.current
    const preview = previewRef.current
    if (!syncEnabled || !editor || !preview) return
    let frame = 0
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        rebuildScrollMap()
      })
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(editor.view.contentDOM)
    observer.observe(preview)
    const body = preview.firstElementChild
    if (body) observer.observe(body)
    return () => {
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
    // エディタを作り直したら、見張る相手を付け直す
  }, [syncEnabled, editorVersion, rebuildScrollMap])

  // スクロールしたら相手を追わせる
  useEffect(() => {
    const found = panes()
    if (!syncEnabled || !found) return
    const handler = (pane: Pane) => () => {
      const echo = echoRef.current
      if (echo && echo.pane === pane) {
        echoRef.current = null
        if (performance.now() < echo.until) return
      }
      masterRef.current = pane
      follow(pane)
    }
    const onSource = handler('source')
    const onPreview = handler('preview')
    found.scroller.addEventListener('scroll', onSource, { passive: true })
    found.preview.addEventListener('scroll', onPreview, { passive: true })
    return () => {
      found.scroller.removeEventListener('scroll', onSource)
      found.preview.removeEventListener('scroll', onPreview)
    }
  }, [syncEnabled, editorVersion, panes, follow])

  return (
    <div className="file-editor" role="dialog" aria-label={file?.title}>
      <style>{MARKDOWN_CARD_CSS}</style>
      <header className="file-editor-header">
        <span className={isCode ? 'file-editor-type code' : 'file-editor-type'}>{isCode ? 'PY' : 'MD'}</span>
        <strong className="file-editor-title">{file?.title ?? ''}</strong>
        <span className="file-editor-path">{file?.path}</span>
        {!isCode && (
          <div className="file-editor-modes">
            {MODES.map(({ mode: m, label }) => (
              <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
                {label}
              </button>
            ))}
          </div>
        )}
        {!isCode && onQuote && (
          <button className="file-editor-quote" onMouseDown={(e) => e.preventDefault()} onClick={quoteSelection} title="選んだ文字の引用をコピーする。キャンバスに貼ると引用ノートになる">
            引用をコピー
          </button>
        )}
        {onReference && (
          <button
            className="file-editor-quote"
            onMouseDown={(e) => e.preventDefault()}
            onClick={referenceSelection}
            title="選んでいる行を指す ID をコピーする。AI に貼り付けると、AI がその行を読める"
          >
            AIに渡す
          </button>
        )}
        <button className="file-editor-close" onClick={onClose} title="閉じる（Esc）">
          ×
        </button>
      </header>
      <div className={`file-editor-body mode-${mode}`}>
        <div className="file-editor-source" ref={sourceRef} />
        <div
          className="file-editor-preview"
          ref={previewRef}
          onClick={(e) => {
            // プレビューの中のリンクは、新しいタブで開く
            const anchor = (e.target as HTMLElement).closest('a[href]')
            if (!anchor) return
            e.preventDefault()
            window.open((anchor as HTMLAnchorElement).href, '_blank', 'noopener,noreferrer')
          }}
        >
          <div className="md-card-body" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>
      {text === null && <div className="file-editor-loading">読み込み中…</div>}
    </div>
  )
}
