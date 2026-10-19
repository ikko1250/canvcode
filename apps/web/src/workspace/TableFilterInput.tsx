import { useRef, useState } from 'react'

// 表のカードの絞り込みの値を尋ねる入力欄（パイメニュー「操作」の「フィルター › 含む…」など）。
// パイメニューを開いた位置（ウィンドウの座標）に出す。Enter か、ほかを押して離れると決め、Esc でやめる。空なら何もしない
export interface TableFilterRequest {
  nodeId: string
  col: number
  // 例：「売上」 ≧
  label: string
  value: string
  at: { x: number; y: number }
}

const WIDTH = 240

export function TableFilterInput(props: { request: TableFilterRequest; onCommit(value: string): void; onCancel(): void }) {
  const { request } = props
  const [value, setValue] = useState(request.value)
  // 閉じると blur も起きるので、2 回目は何もしない（Esc のあとの blur で決めてしまわないように）
  const done = useRef(false)
  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    if (commit && value.trim() !== '') props.onCommit(value.trim())
    else props.onCancel()
  }
  return (
    <div
      className="table-filter-input"
      role="dialog"
      aria-label="フィルター"
      style={{ left: Math.max(8, Math.min(request.at.x, window.innerWidth - WIDTH - 8)), top: Math.max(8, Math.min(request.at.y, window.innerHeight - 80)), width: WIDTH }}
    >
      <label>
        <span>{request.label}</span>
        <input
          autoFocus
          value={value}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            // IME で変換を確定する Enter では、決めない
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') finish(true)
            if (e.key === 'Escape') finish(false)
          }}
        />
      </label>
    </div>
  )
}
