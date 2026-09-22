import { useEffect, useMemo, useRef, useState } from 'react'
import { createCodeEditor, type FileManager, type Workspace } from '@canvcode/canvas'
import { MARKDOWN_CARD_CSS, renderMarkdown } from '@canvcode/nodes/markdown'
import 'katex/dist/katex.min.css'

// 全画面のエディタ（MAI-9 の「5. 編集モードの挙動」、MAI-30）。左に本文、右にプレビュー。
// カードの上での編集と同じく、本文は File に直接書く（少し待ってまとめて保存する）。Esc か Ctrl（⌘）+Enter で閉じる

type Mode = 'both' | 'source' | 'preview'

const MODES: { mode: Mode; label: string }[] = [
  { mode: 'source', label: '本文' },
  { mode: 'both', label: '両方' },
  { mode: 'preview', label: 'プレビュー' },
]

// プレビューを描き直すまでの時間（打つたびに描き直すと重いので）
const PREVIEW_DELAY_MS = 150

export function FileEditor(props: { workspace: Workspace; files: FileManager; fileId: string; onClose(): void }) {
  const { workspace, files, fileId, onClose } = props
  const file = workspace.getFile(fileId)
  const [mode, setMode] = useState<Mode>('both')
  const [text, setText] = useState<string | null>(null)
  const [previewText, setPreviewText] = useState('')
  const sourceRef = useRef<HTMLDivElement>(null)

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
      language: 'markdown',
      placeholder: 'Markdown を書く…',
      onChange: (value) => {
        files.edit(fileId, value)
        setPreviewText(value)
      },
      onEscape: onClose,
      onModEnter: onClose,
    })
    setPreviewText(text)
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
      editor.destroy()
      void files.flush(fileId)
    }
    // text は読み込んだときに一度だけ決まる（そのあとの変更はエディタが持つ）
  }, [files, fileId, onClose, text])

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
  const html = useMemo(() => renderMarkdown(debounced).html, [debounced])

  return (
    <div className="file-editor" role="dialog" aria-label={file?.title}>
      <style>{MARKDOWN_CARD_CSS}</style>
      <header className="file-editor-header">
        <span className="file-editor-type">MD</span>
        <strong className="file-editor-title">{file?.title ?? ''}</strong>
        <span className="file-editor-path">{file?.path}</span>
        <div className="file-editor-modes">
          {MODES.map(({ mode: m, label }) => (
            <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
              {label}
            </button>
          ))}
        </div>
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
