import { useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { addStop, moveStop, removeStop, type PaintEditing } from '@canvcode/canvas'
import { colorWithAlpha, gradientAngle, normalizeAngle, sortStops, type GradientPaint, type GradientStop } from '@canvcode/nodes'
import { NumberField, type ValueEditor } from './controls.tsx'
import type { FillChange } from './sections.ts'

// グラデーションの編集（MAI-82）。塗りの項目（ColorPicker.tsx の PaintField）のピッカーの中に出す。
// - 止め色の帯：帯の上を押すとその位置に止め色を足し（そのままドラッグで動かせる）、印をドラッグで動かす、
//   印を選んで Delete・Backspace で消す（2 つより少なくはしない）、← → で 1 %（Shift で 10 %）動かす。ドラッグは Undo 1 回
// - 選んでいる止め色の位置（%）。色と不透明度は、下のカラーピッカー（PaintField が選んでいる止め色につなぐ）
// - 線形は角度（度。図形の箱の大きさで見た向き）、円形は中心（X・Y、箱に対する %）と半径（%）
// - 選んでいる止め色は、キャンバスのハンドル（packages/canvas の gradientHandles.ts）と共有する（session.paintEditing）

// 図形の上のハンドルとのつなぎ（DesignPanel が作る。1 つの図形を選んでいるときだけ）
export interface PaintEditingLink {
  // グラデーションの編集を始める（キャンバスにハンドルを出す）・終える
  begin(stop: number): void
  end(): void
  selectStop(stop: number): void
  // ポインタがキャンバスのグラデーションのハンドルの上か（そこを押してもピッカーを閉じない）
  ownsPointer(e: PointerEvent): boolean
}

export type { PaintEditing }

const STOP_STEP = 0.01

export function GradientEditor(props: {
  label: string
  paint: GradientPaint
  // 選んでいるノードの箱の大きさ（線形の角度を見せる。違えば混在）
  sizes: readonly { w: number; h: number }[]
  selected: number
  onSelect(index: number): void
  editor: ValueEditor<FillChange>
  onDone?: () => void
}) {
  const { label, paint, sizes, selected, onSelect, editor, onDone } = props
  const stop = paint.stops[selected] ?? paint.stops[0]
  const removed = removeStop(paint.stops, selected)
  const setStops = (stops: GradientStop[]) => editor.set({ change: 'stops', stops })

  // 数の項目（NumberField）に渡す、値の換算
  const numberEditor = (toChange: (value: number) => FillChange | null): ValueEditor<number> => ({
    set: (value) => {
      const change = toChange(value)
      if (change) editor.set(change)
    },
    preview: (value) => {
      const change = toChange(value)
      if (change) editor.preview(change)
    },
    end: (commit) => editor.end(commit),
  })
  const percent = (value: number) => Math.round(value * 1000) / 10

  const angles = sizes.length > 0 && paint.type === 'linear' ? sizes.map((size) => gradientAngle(paint, size)) : []
  const angle = angles.length > 0 && angles.every((a) => Math.abs(a - angles[0]) < 0.05) ? Math.round(angles[0] * 10) / 10 : null

  return (
    <div className="design-gradient" aria-label={`${label}のグラデーション`}>
      <GradientBar label={label} paint={paint} selected={selected} onSelect={onSelect} editor={editor} />
      <NumberField
        label="位置"
        value={{ kind: 'same', value: stop.position }}
        control={{ kind: 'number', min: 0, max: 100, step: 1, unit: '%', toDisplay: percent, fromDisplay: (v) => v / 100 }}
        editor={numberEditor((position) => {
          const moved = moveStop(paint.stops, selected, position)
          onSelect(moved.index)
          return { change: 'stops', stops: moved.stops }
        })}
        onDone={onDone}
      />
      {paint.type === 'linear' ? (
        <NumberField
          label="角度"
          value={angle === null ? { kind: 'mixed', values: angles } : { kind: 'same', value: angle }}
          control={{ kind: 'number', min: -360, max: 720, step: 1, unit: '°' }}
          editor={numberEditor((value) => ({ change: 'angle', angle: normalizeAngle(value) }))}
          onDone={onDone}
        />
      ) : (
        <>
          <NumberField
            label="中心 X"
            value={{ kind: 'same', value: paint.center.x }}
            control={{ kind: 'number', min: -100, max: 200, step: 1, unit: '%', toDisplay: percent, fromDisplay: (v) => v / 100 }}
            editor={numberEditor((x) => ({ change: 'radial', center: { x, y: paint.center.y } }))}
            onDone={onDone}
          />
          <NumberField
            label="中心 Y"
            value={{ kind: 'same', value: paint.center.y }}
            control={{ kind: 'number', min: -100, max: 200, step: 1, unit: '%', toDisplay: percent, fromDisplay: (v) => v / 100 }}
            editor={numberEditor((y) => ({ change: 'radial', center: { x: paint.center.x, y } }))}
            onDone={onDone}
          />
          <NumberField
            label="半径"
            value={{ kind: 'same', value: paint.radius }}
            control={{ kind: 'number', min: 0, max: 400, step: 1, unit: '%', toDisplay: percent, fromDisplay: (v) => v / 100 }}
            editor={numberEditor((radius) => ({ change: 'radial', radius }))}
            onDone={onDone}
          />
        </>
      )}
      <div className="design-gradient-actions">
        <button
          className="design-gradient-remove"
          disabled={!removed}
          title="選んでいる止め色を消す（Delete）"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            if (!removed) return
            setStops(removed.stops)
            onSelect(removed.index)
          }}
        >
          止め色を消す
        </button>
      </div>
    </div>
  )
}

// 止め色の帯。帯は今のグラデーション（市松模様の上）、印はその止め色
function GradientBar(props: { label: string; paint: GradientPaint; selected: number; onSelect(index: number): void; editor: ValueEditor<FillChange> }) {
  const { label, paint, selected, onSelect, editor } = props
  const bar = useRef<HTMLDivElement>(null)
  // ドラッグ中の止め色（並べ直すと番号が変わるので、並びと番号をここで追う）
  const drag = useRef<{ pointerId: number; stops: GradientStop[]; index: number; changed: boolean } | null>(null)

  const positionAt = (clientX: number) => {
    const rect = bar.current!.getBoundingClientRect()
    return Math.round(Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width))) * 1000) / 1000
  }
  const startDrag = (e: ReactPointerEvent<HTMLElement>, stops: GradientStop[], index: number, changed: boolean) => {
    e.preventDefault()
    e.stopPropagation()
    bar.current!.setPointerCapture(e.pointerId)
    drag.current = { pointerId: e.pointerId, stops, index, changed }
    onSelect(index)
  }
  // 帯の上を押す：そこに止め色を足して、そのままドラッグで動かせるようにする（足して動かすまでが Undo 1 回）
  const onBarDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const added = addStop(paint.stops, positionAt(e.clientX))
    editor.preview({ change: 'stops', stops: added.stops })
    startDrag(e, added.stops, added.index, true)
  }
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    const moved = moveStop(d.stops, d.index, positionAt(e.clientX))
    if (moved.stops[moved.index].position === d.stops[d.index].position) return
    d.stops = moved.stops
    d.index = moved.index
    d.changed = true
    editor.preview({ change: 'stops', stops: moved.stops })
    onSelect(moved.index)
  }
  const onEnd = (e: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    drag.current = null
    if (d.changed) editor.end(commit)
  }
  const onStopKey = (e: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      const removed = removeStop(paint.stops, index)
      if (!removed) return
      editor.set({ change: 'stops', stops: removed.stops })
      onSelect(removed.index)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const delta = (e.key === 'ArrowRight' ? 1 : -1) * STOP_STEP * (e.shiftKey ? 10 : 1)
      const moved = moveStop(paint.stops, index, Math.round((paint.stops[index].position + delta) * 1000) / 1000)
      editor.set({ change: 'stops', stops: moved.stops })
      onSelect(moved.index)
    }
  }

  const css = sortStops(paint.stops)
    .map((stop) => `${colorWithAlpha(stop.color, stop.opacity)} ${Math.round(stop.position * 1000) / 10}%`)
    .join(', ')
  return (
    <div
      ref={bar}
      className="design-gradient-bar"
      role="group"
      aria-label={`${label}の止め色`}
      title="押すと止め色を足す"
      data-testid="gradient-bar"
      onPointerDown={onBarDown}
      onPointerMove={onMove}
      onPointerUp={(e) => onEnd(e, true)}
      onPointerCancel={(e) => onEnd(e, false)}
    >
      <span className="design-gradient-fill" style={{ background: `linear-gradient(to right, ${css})` }} />
      {paint.stops.map((stop, index) => (
        <button
          key={index}
          className={index === selected ? 'design-gradient-stop selected' : 'design-gradient-stop'}
          style={{ left: `${stop.position * 100}%` }}
          aria-label={`止め色 ${index + 1}（${Math.round(stop.position * 100)}%）`}
          aria-pressed={index === selected}
          data-stop={index}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.currentTarget.focus({ preventScroll: true })
            startDrag(e, paint.stops, index, false)
          }}
          onKeyDown={(e) => onStopKey(e, index)}
        >
          <span style={{ background: colorWithAlpha(stop.color, stop.opacity) }} />
        </button>
      ))}
    </div>
  )
}
