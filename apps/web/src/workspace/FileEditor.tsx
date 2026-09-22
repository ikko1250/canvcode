import { useEffect, useMemo, useRef, useState } from 'react'
import { createCodeEditor, quoteRange, type FileManager, type QuoteDraft, type Workspace } from '@canvcode/canvas'
import { MARKDOWN_CARD_CSS, renderMarkdown } from '@canvcode/nodes/markdown'
import 'katex/dist/katex.min.css'

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

export function FileEditor(props: {
  workspace: Workspace
  files: FileManager
  fileId: string
  // 開いたときに選んで見せる引用（引用ノートの「出典へ」。MAI-33）
  focus?: { quote: string; line: number } | null
  // 選んだ文字の引用をコピーする（Markdown のとき）
  onQuote?(draft: QuoteDraft): void
  // focus の文字列が見つからなかった（位置不明）
  onLost?(): void
  onClose(): void
}) {
  const { workspace, files, fileId, focus, onQuote, onLost, onClose } = props
  const file = workspace.getFile(fileId)
  const isCode = file?.kind === 'code'
  const [chosenMode, setMode] = useState<Mode>('both')
  // Python にはプレビューがない
  const mode: Mode = isCode ? 'source' : chosenMode
  const [text, setText] = useState<string | null>(null)
  const [previewText, setPreviewText] = useState('')
  const sourceRef = useRef<HTMLDivElement>(null)
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
  const html = useMemo(() => (isCode ? '' : renderMarkdown(debounced).html), [debounced, isCode])

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
        <button className="file-editor-close" onClick={onClose} title="閉じる（Esc）">
          ×
        </button>
      </header>
      <div className={`file-editor-body mode-${mode}`}>
        <div className="file-editor-source" ref={sourceRef} />
        <div
          className="file-editor-preview"
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
