import { useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { SharedValue } from '@canvcode/canvas'
import { chartRowColor, parseChartNumber, parseChartTable, type ChartRow } from '@canvcode/nodes'
import { MIXED_LABEL, type ValueEditor } from './controls.tsx'
import { ColorPicker, SwatchButton, type ColorPickerChange } from './ColorPicker.tsx'
import { useDraft } from './useDraft.ts'
import type { ChartRowsChange } from './sections.ts'

// グラフのデータの表（MAI-88。デザインパネルの「グラフ」→「データ」）。
// - 行ごとに、色の見本（押すとカラーピッカー。「自動に戻す」でテンプレートの色の自動の割り当てに戻す）、ラベル、値、−（消す）
// - ラベル・値は打ち終えて（Enter・フォーカスを外す）から 1 回の変更（Undo 1 回）。Enter で次の行の同じ列へ、Esc で打った文字を捨ててキャンバスへ戻る
// - Alt+↑ / Alt+↓ で行を並べ替える（入力の中で）
// - CSV・TSV（表計算からのコピーなど）を表の中に貼り付けると、表をまるごと置き換える（1 列目ラベル・2 列目値、見出しの行は飛ばす。nodes の parseChartTable）。
//   「貼り付け」のボタンはクリップボードから読む。どちらも Undo 1 回
// - 複数のグラフを選んで、データが違えば「混在」と出す（＋・貼り付けは、どのグラフにも当たる）
// パネルの中なので、キー入力はキャンバスに渡らない（data-own-keys）

export function ChartDataField(props: { label: string; value: SharedValue<ChartRow[]>; editor: ValueEditor<ChartRowsChange>; onDone?: () => void }) {
  const { label, value, editor, onDone } = props
  const rows = value.kind === 'same' ? value.value : null
  const rootRef = useRef<HTMLDivElement>(null)
  // 貼り付けで表を置き換えたら、入力中の文字を捨てる（古い文字で、新しい行を上書きしないように）
  const [generation, setGeneration] = useState(0)
  const [pickerRow, setPickerRow] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  // 表の外を押したら、カラーピッカーを閉じる
  useEffect(() => {
    if (pickerRow === null) return
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setPickerRow(null)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [pickerRow])

  const replaceWith = (text: string): boolean => {
    const parsed = parseChartTable(text)
    if (!parsed) return false
    setGeneration((g) => g + 1)
    setPickerRow(null)
    setMessage(null)
    editor.set(parsed)
    return true
  }

  // 表の中に貼り付けた文字が表（タブか改行を含む）なら、表をまるごと置き換える。1 つの値の貼り付けは、そのままセルに入れる
  const onPaste = (e: ReactClipboardEvent<HTMLDivElement>) => {
    const text = e.clipboardData.getData('text/plain')
    if (!text.includes('\t') && !text.trim().includes('\n')) return
    if (replaceWith(text)) e.preventDefault()
  }

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (!replaceWith(text)) setMessage('クリップボードに表がありません（1 列目ラベル・2 列目値の CSV か TSV）')
    } catch {
      setMessage('クリップボードを読めませんでした。表の中で Ctrl+V で貼り付けてください')
    }
  }

  const focusCell = (row: number, column: 'label' | 'value') => {
    rootRef.current?.querySelector<HTMLInputElement>(`[data-chart-row="${row}"] [data-chart-column="${column}"]`)?.focus()
  }

  return (
    <div className="design-chart" data-testid="chart-data-field" ref={rootRef} onPaste={onPaste}>
      <div className="design-field design-chart-head">
        <span className="design-label">{label}</span>
        <div className="design-control">
          {rows === null && <span className="design-mixed">{MIXED_LABEL}</span>}
          <button
            className="design-chart-paste"
            title="クリップボードの表（CSV・TSV。1 列目ラベル・2 列目値）でデータを置き換える"
            onClick={() => void pasteFromClipboard()}
          >
            貼り付け
          </button>
          <button className="design-fill-toggle" title="行を足す" aria-label="行を足す" onClick={() => editor.set({ op: 'add' })}>
            +
          </button>
        </div>
      </div>
      {message && (
        <div className="design-chart-message" role="status">
          {message}
        </div>
      )}
      {rows && (
        <div className="design-chart-table" role="table" aria-label={label} key={generation}>
          {rows.map((row, index) => (
            <ChartRowView
              key={index}
              index={index}
              row={row}
              count={rows.length}
              editor={editor}
              pickerOpen={pickerRow === index}
              onTogglePicker={() => setPickerRow(pickerRow === index ? null : index)}
              onClosePicker={() => setPickerRow(null)}
              onNext={(column) => (index + 1 < rows.length ? focusCell(index + 1, column) : onDone?.())}
              onMoved={(to, column) => requestAnimationFrame(() => focusCell(to, column))}
              onDone={onDone}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ChartRowView(props: {
  index: number
  row: ChartRow
  count: number
  editor: ValueEditor<ChartRowsChange>
  pickerOpen: boolean
  onTogglePicker: () => void
  onClosePicker: () => void
  onNext: (column: 'label' | 'value') => void
  onMoved: (to: number, column: 'label' | 'value') => void
  onDone?: () => void
}) {
  const { index, row, count, editor, pickerOpen, onTogglePicker, onClosePicker, onNext, onMoved, onDone } = props
  const name = `行 ${index + 1}`
  const color = chartRowColor(row, index)
  const update = (patch: { label?: string; value?: number; color?: string | null }): ChartRowsChange => ({ op: 'update', index, patch })
  const toColor = (change: ColorPickerChange) => ('color' in change ? change.color : null)

  // Alt+↑ / Alt+↓ で行を並べ替える
  const onMoveKey = (e: ReactKeyboardEvent<HTMLInputElement>, column: 'label' | 'value', commit: () => void): boolean => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return false
    e.preventDefault()
    const to = index + (e.key === 'ArrowUp' ? -1 : 1)
    if (to < 0 || to >= count) return true
    commit()
    editor.set({ op: 'move', from: index, to })
    onMoved(to, column)
    return true
  }

  return (
    <>
      <div className={row.color ? 'design-chart-row' : 'design-chart-row auto'} role="row" data-chart-row={index} aria-label={name}>
        <SwatchButton label={`${name}の色`} color={color} state="color" open={pickerOpen} onToggle={onTogglePicker} />
        <CellInput
          label={`${name}のラベル`}
          column="label"
          text={row.label}
          onCommit={(text) => {
            if (text !== row.label) editor.set(update({ label: text }))
          }}
          onNext={() => onNext('label')}
          onMoveKey={(e, commit) => onMoveKey(e, 'label', commit)}
          onDone={onDone}
        />
        <CellInput
          label={`${name}の値`}
          column="value"
          numeric
          text={String(row.value)}
          onCommit={(text) => {
            const value = parseChartNumber(text)
            if (value !== null && value !== row.value) editor.set(update({ value }))
          }}
          onNext={() => onNext('value')}
          onMoveKey={(e, commit) => onMoveKey(e, 'value', commit)}
          onDone={onDone}
        />
        <button className="design-fill-toggle" title={`${name}を消す`} aria-label={`${name}を消す`} onClick={() => editor.set({ op: 'remove', index })}>
          −
        </button>
      </div>
      {pickerOpen && (
        <ColorPicker
          label={`${name}の色`}
          color={color}
          header={
            <div className="design-chart-auto">
              <span>{row.color ? '指定した色' : '自動の色'}</span>
              <button disabled={!row.color} onPointerDown={(e) => e.preventDefault()} onClick={() => editor.set(update({ color: null }))}>
                自動に戻す
              </button>
            </div>
          }
          onSet={(change) => {
            const next = toColor(change)
            if (next) editor.set(update({ color: next }))
          }}
          onPreview={(change) => {
            const next = toColor(change)
            if (next) editor.preview(update({ color: next }))
          }}
          onEnd={(commit) => editor.end(commit)}
          onClose={() => {
            onClosePicker()
            onDone?.()
          }}
        />
      )}
    </>
  )
}

// 表のセル。打っている間は値を変えず、Enter・フォーカスを外したときに確定する
function CellInput(props: {
  label: string
  column: 'label' | 'value'
  text: string
  numeric?: boolean
  onCommit: (text: string) => void
  onNext: () => void
  onMoveKey: (e: ReactKeyboardEvent<HTMLInputElement>, commit: () => void) => boolean
  onDone?: () => void
}) {
  const { label, column, text, numeric, onCommit, onNext, onMoveKey, onDone } = props
  const { draft, setDraft, take } = useDraft()
  const commit = () => {
    const next = take()
    if (next !== null) onCommit(next)
  }
  return (
    <input
      type="text"
      className={numeric ? 'design-chart-cell numeric' : 'design-chart-cell'}
      aria-label={label}
      title={numeric ? undefined : 'Alt+↑↓ で並べ替え'}
      data-chart-column={column}
      inputMode={numeric ? 'decimal' : undefined}
      value={draft ?? text}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (onMoveKey(e, commit)) return
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault()
          commit()
          onNext()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          setDraft(null)
          onDone?.()
        }
      }}
    />
  )
}
