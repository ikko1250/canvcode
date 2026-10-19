import { useEffect, useRef, useState } from 'react'
import type { CanvasView } from '@canvcode/canvas'

// PDF の単語検索の入力欄（Ctrl+F。試作）。今の Canvas にある PDF のページから探し、一致したところを塗る。
// Enter で次、Shift+Enter で前へ移り、Esc で閉じる。件数はサーバーが数え、位置を出したページから正しい件数に直る
type Status = 'idle' | 'searching' | 'ok' | 'nopdf' | 'pending' | 'textless' | 'error'

const DEBOUNCE_MS = 250

// focusRequest は、開いているときにもう一度 Ctrl+F を押したら増える（入力欄に戻って、文字を選ぶ）
export function PdfSearchBar(props: { view: CanvasView; focusRequest: number; onClose(): void }) {
  const { view } = props
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [total, setTotal] = useState(0)
  // いま見せている 1 件（0 から）。まだ移っていなければ null
  const [current, setCurrent] = useState<number | null>(null)
  const input = useRef<HTMLInputElement>(null)
  // 次に移る先を決める 1 件。Enter を続けて押したとき、前の移動（カメラの動き）を待たずに数えられるよう ref でも持つ
  const target = useRef<number | null>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [props.focusRequest])

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      view.clearSearch()
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      view
        .searchPdf(q, () => !controller.signal.aborted && setTotal(view.searchTotal), controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return
          setStatus(result.status)
          setTotal(result.total)
        })
        .catch((error) => {
          if (controller.signal.aborted) return
          console.error('PDF search failed', error)
          setStatus('error')
        })
    }, DEBOUNCE_MS)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [view, query])

  // 閉じたらハイライトを消す
  useEffect(() => () => view.clearSearch(), [view])

  const move = async (step: 1 | -1) => {
    const count = view.searchTotal
    if (status !== 'ok' || count === 0) return
    const from = target.current
    const next = from === null ? (step === 1 ? 0 : count - 1) : (from + step + count) % count
    target.current = next
    const shown = await view.showSearchHit(next)
    // 待っている間に、さらに移っていれば、そちらに任せる
    if (shown === null || target.current !== next) return
    target.current = shown
    setCurrent(shown)
    setTotal(view.searchTotal)
  }

  return (
    <div className="pdf-search" role="search">
      <input
        ref={input}
        value={query}
        placeholder="PDF の中を検索"
        onChange={(e) => {
          setQuery(e.target.value)
          target.current = null
          setCurrent(null)
          setTotal(0)
          setStatus(e.target.value.trim() ? 'searching' : 'idle')
        }}
        onKeyDown={(e) => {
          // IME で変換を確定する Enter では移らない
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter') {
            e.preventDefault()
            void move(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            props.onClose()
          }
        }}
      />
      <span className="pdf-search-count">{label(status, total, current)}</span>
      <button title="前へ（Shift+Enter）" disabled={status !== 'ok' || total === 0} onClick={() => void move(-1)}>
        ↑
      </button>
      <button title="次へ（Enter）" disabled={status !== 'ok' || total === 0} onClick={() => void move(1)}>
        ↓
      </button>
      <button title="閉じる（Esc）" onClick={props.onClose}>
        ×
      </button>
    </div>
  )
}

function label(status: Status, total: number, current: number | null): string {
  switch (status) {
    case 'idle':
      return ''
    case 'searching':
      return '検索中…'
    case 'nopdf':
      return 'この Canvas に PDF がありません'
    case 'pending':
      return '文字を取り出しています。少し待ってから探してください'
    case 'textless':
      return '文字のない PDF です'
    case 'error':
      return '検索できませんでした'
    case 'ok':
      if (total === 0) return '見つかりません'
      return current === null ? `${total} 件` : `${Math.min(current + 1, total)} / ${total}`
  }
}
