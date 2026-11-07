import { useRef, useState } from 'react'
import { filterCompares, isComparableValue, type TableColumnKind, type TableFilterOp } from '@canvcode/nodes'

// 表のカードの絞り込みの値を尋ねる入力欄（パイメニュー「操作」の「フィルター › 含む…」など）。
// パイメニューを開いた位置（ウィンドウの座標）に出す。Enter か、ほかを押して離れると決め、Esc でやめる。空なら何もしない。
// 数・日付の列では、入力欄に値の例を出す。大小を比べる条件で、数・日付として読めない値は決めない
// （Enter なら注意を出して入力欄に残し、離れたらやめる。MAI-94）
export interface TableFilterRequest {
  nodeId: string
  col: number
  op: TableFilterOp
  // 列の種類（数・日付・文字）
  kind: TableColumnKind
  // 例：「売上」 ≧
  label: string
  value: string
  at: { x: number; y: number }
}

const WIDTH = 240

const PLACEHOLDERS: Partial<Record<TableColumnKind, string>> = {
  number: '例：1,000',
  date: '例：2012・2026-11・2026-01-01',
}

const WARNINGS: Partial<Record<TableColumnKind, string>> = {
  number: '数として読めません（例：1,000）',
  date: '日付として読めません（例：2012・2026-11・2026-01-01）',
}

export function TableFilterInput(props: { request: TableFilterRequest; onCommit(value: string): void; onCancel(): void }) {
  const { request } = props
  const [value, setValue] = useState(request.value)
  const [warning, setWarning] = useState<string | null>(null)
  // 閉じると blur も起きるので、2 回目は何もしない（Esc のあとの blur で決めてしまわないように）
  const done = useRef(false)
  // 決められない値か（大小を比べる条件で、列の種類として読めない）
  const problem = (text: string) => (text !== '' && filterCompares(request.op) && !isComparableValue(text, request.kind) ? (WARNINGS[request.kind] ?? null) : null)
  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    const text = value.trim()
    if (commit && text !== '' && !problem(text)) props.onCommit(text)
    else props.onCancel()
  }
  return (
    <div
      className="table-filter-input"
      role="dialog"
      aria-label="フィルター"
      style={{ left: Math.max(8, Math.min(request.at.x, window.innerWidth - WIDTH - 8)), top: Math.max(8, Math.min(request.at.y, window.innerHeight - 100)), width: WIDTH }}
    >
      <label>
        <span>{request.label}</span>
        <input
          autoFocus
          value={value}
          placeholder={PLACEHOLDERS[request.kind]}
          aria-invalid={warning ? true : undefined}
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            setValue(e.target.value)
            setWarning(null)
          }}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            // IME で変換を確定する Enter では、決めない
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') {
              const warn = problem(value.trim())
              if (warn) setWarning(warn)
              else finish(true)
            }
            if (e.key === 'Escape') finish(false)
          }}
        />
      </label>
      {warning && (
        <p className="table-filter-warning" role="alert">
          {warning}
        </p>
      )}
    </div>
  )
}
