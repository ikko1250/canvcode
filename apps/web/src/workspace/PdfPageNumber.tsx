import { useEffect, useRef, useState } from 'react'
import { parsePageNumber } from '@canvcode/canvas'

// 画面の下の中央の「p.12 / 80」（MAI-92）。今のページの PDF の中での番号と総ページ数を出す。
// 押すか G で、その場で番号の入力欄（「p.[12] / 80」）に変わる。Enter でそのページへ移り、Esc か欄を離れると移らずに閉じる。
// 番号が範囲の外・数でない・そのページが消されているときは、移らずに欄のそばに注意を出し、欄は開いたままにする
export function PdfPageNumber(props: {
  page: number
  count: number
  editing: boolean
  onEdit(): void
  // そのページへ移る。ページが見つからなければ（消されていれば）false
  onJump(pageNumber: number): boolean
  // refocus：キャンバスにフォーカスを戻すか（Esc で閉じたとき。ほかを押して離れたときは戻さない）
  onClose(refocus: boolean): void
}) {
  const { page, count } = props
  if (!props.editing) {
    return (
      <button type="button" className="pdf-page-number" title="ページの番号を入れて移る（G）" aria-keyshortcuts="G" onClick={props.onEdit}>
        p.{page} / {count}
      </button>
    )
  }
  return <PageNumberInput {...props} />
}

function PageNumberInput(props: Parameters<typeof PdfPageNumber>[0]) {
  const { count } = props
  // 開いたときの番号から始める（入れている間にカメラが動いても変えない）
  const [value, setValue] = useState(() => String(props.page))
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const jump = () => {
    const pageNumber = parsePageNumber(value, count)
    if (pageNumber === null) return setError(`1〜${count} の番号を入れてください`)
    if (!props.onJump(pageNumber)) setError(`${pageNumber} ページは消されています`)
  }

  return (
    <div className="pdf-page-number editing">
      p.
      <input
        ref={input}
        value={value}
        inputMode="numeric"
        aria-label="ページの番号"
        aria-invalid={error !== null}
        // 総ページ数の桁数に合わせる
        style={{ width: `${String(count).length + 1}ch` }}
        onChange={(e) => {
          setValue(e.target.value)
          setError(null)
        }}
        onKeyDown={(e) => {
          // IME で変換を確定する Enter では移らない
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter') {
            e.preventDefault()
            jump()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            props.onClose(true)
          }
        }}
        onBlur={() => props.onClose(false)}
      />
      / {count}
      {error && (
        <div className="pdf-page-number-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
