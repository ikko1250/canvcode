import { Fragment, useEffect, useRef, useState, type ComponentType, type CSSProperties, type HTMLAttributes, type ReactNode, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { SharedValue } from '@canvcode/canvas'
import { CornerDownLeft, CornerDownRight, CornerUpLeft, CornerUpRight, Scan } from 'lucide-react'
import { CORNER_RADIUS_MAX, cornerRadii, type CornerRadius, type LineHeight, type LineHeightUnit } from '@canvcode/nodes'
import { clampLineHeight, parseLineHeight, parseNumber } from './parse.ts'
import { useDraft } from './useDraft.ts'
import type { DesignIcon, FieldControl, SegmentOption, SelectOption } from './registry.ts'
import type { CornerRadiusChange, LineHeightChange } from './sections.ts'

// デザインパネルの入力部品（MAI-73）。数字・切り替えボタン・スライダー（色は ColorPicker.tsx）。
// 部品は値を直接書き換えず、ValueEditor を通して変える：
// - set：1 回の変更（Enter・ボタン）。Undo 1 回で戻る
// - preview → end：続けて変わる操作（スライダー・ラベルのドラッグ・色の選択）。end までが Undo 1 回にまとまる。
//   end(false) なら始める前の値に戻す（Esc）
// 値が違うノードを選んでいるとき（mixed）は「混在」と出す

export interface ValueEditor<T> {
  set(value: T): void
  preview(value: T): void
  end(commit: boolean): void
}

export const MIXED_LABEL = '混在'

interface FieldProps<T> {
  label: string
  // 行の左に名前の代わりに出すアイコン（registry.ts の DesignField.icon）
  icon?: DesignIcon
  value: SharedValue<T>
  editor: ValueEditor<T>
  // 入力を終えたら、キャンバスにフォーカスを戻す（Esc・Enter のあと）
  onDone?: () => void
}

// ---- 項目の名前 ----

// 行の左の名前。アイコンがあればアイコンを出し、名前はツールチップにする（入力の名前は各部品の aria-label）。
// 数字の項目は、ここを左右にドラッグして値を変える（props に pointer のハンドラーを渡す）
export function FieldLabel(props: { label: string; icon?: DesignIcon; title?: string } & Omit<HTMLAttributes<HTMLSpanElement>, 'title'>) {
  const { label, icon: Icon, title, className, ...rest } = props
  const classes = ['design-label', Icon ? 'icon' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <span className={classes} title={title ?? label} {...rest}>
      {Icon ? <Icon size={16} strokeWidth={1.75} aria-hidden /> : label}
    </span>
  )
}

// ---- 数字 ----

type NumberControl = Extract<FieldControl, { kind: 'number' }>

// extra は入力の右に並べるもの（角丸の「角ごと」のボタンなど）。className は行に足すクラス
export function NumberField(props: FieldProps<number> & { control: NumberControl; extra?: ReactNode; className?: string }) {
  const { label, icon, value, editor, control, onDone, extra, className } = props
  const toDisplay = control.toDisplay ?? ((v: number) => v)
  const fromDisplay = control.fromDisplay ?? ((v: number) => v)
  const step = control.step ?? 1
  const shown = value.kind === 'same' ? toDisplay(value.value) : null
  // 入力中の文字（null なら今の値を出す）
  const { draft, setDraft, take } = useDraft()
  const scrub = useRef<{ pointerId: number; x: number; start: number } | null>(null)

  const clamp = (v: number) => Math.min(control.max ?? Infinity, Math.max(control.min ?? -Infinity, v))
  const round = (v: number) => Number((Math.round(v / step) * step).toFixed(6))
  const toValue = (display: number) => fromDisplay(clamp(round(display)))

  const commitDraft = () => {
    const text = take()
    const parsed = text === null ? null : parseNumber(text)
    if (parsed !== null) editor.set(toValue(parsed))
  }
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitDraft()
      onDone?.()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setDraft(null)
      onDone?.()
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // ↑↓ で 1 刻み、Shift で 10 刻み
      e.preventDefault()
      const base = draft !== null ? parseNumber(draft) : shown
      if (base === null) return
      const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)
      setDraft(null)
      editor.set(toValue(base + delta))
    }
  }

  // ラベルを横にドラッグすると値が変わる（Figma と同じ）。1 ピクセルで 1 刻み、Shift で 10 刻み
  const onScrubDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    scrub.current = { pointerId: e.pointerId, x: e.clientX, start: shown ?? control.min ?? 0 }
  }
  const onScrubMove = (e: ReactPointerEvent<HTMLElement>) => {
    const s = scrub.current
    if (!s || s.pointerId !== e.pointerId) return
    const dx = e.clientX - s.x
    if (dx === 0) return
    editor.preview(toValue(s.start + dx * step * (e.shiftKey ? 10 : 1)))
  }
  const onScrubEnd = (e: ReactPointerEvent<HTMLElement>, commit: boolean) => {
    const s = scrub.current
    if (!s || s.pointerId !== e.pointerId) return
    scrub.current = null
    editor.end(commit)
  }

  const sliderValue = shown ?? control.min ?? 0
  // スライダーは数字の左に置く（数字の欄は右端にそろえる）
  const hasSlider = Boolean(control.slider && control.min !== undefined && control.max !== undefined)
  return (
    <div className={className ? `design-field ${className}` : 'design-field'}>
      <FieldLabel
        label={label}
        icon={icon}
        className="scrub"
        title={`${label}（左右にドラッグで変える）`}
        onPointerDown={onScrubDown}
        onPointerMove={onScrubMove}
        onPointerUp={(e) => onScrubEnd(e, true)}
        onPointerCancel={(e) => onScrubEnd(e, false)}
      />
      <div className={hasSlider ? 'design-control with-slider' : 'design-control'}>
        {hasSlider && (
          <Slider
            label={label}
            min={control.min!}
            max={control.sliderMax ?? control.max!}
            step={step}
            value={sliderValue}
            mixed={value.kind === 'mixed'}
            onPreview={(v) => editor.preview(toValue(v))}
            onEnd={(commit) => editor.end(commit)}
          />
        )}
        <span className="design-number">
          <input
            type="text"
            inputMode="decimal"
            aria-label={label}
            value={draft ?? (shown === null ? '' : String(shown))}
            placeholder={value.kind === 'mixed' ? MIXED_LABEL : ''}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={onKeyDown}
          />
          {control.unit && <span className="design-unit">{control.unit}</span>}
        </span>
        {extra}
      </div>
    </div>
  )
}

// ---- 角丸（MAI-84） ----

// スライダーは 0〜100 px（入力は CORNER_RADIUS_MAX まで）
const CORNER_RADIUS_CONTROL: NumberControl = { kind: 'number', min: 0, max: CORNER_RADIUS_MAX, step: 1, unit: 'px', slider: true, sliderMax: 100 }
const CORNER_CELL_CONTROL: NumberControl = { kind: 'number', min: 0, max: CORNER_RADIUS_MAX, step: 1, unit: 'px' }
const CORNER_LABELS = ['左上', '右上', '右下', '左下'] as const
const CORNER_ICONS = [CornerUpLeft, CornerUpRight, CornerDownRight, CornerDownLeft] as const

// 角丸の半径。4 つの角を一緒に変える入力と、角ごとの 4 つの入力に切り替えるボタン（Figma と同じ）。
// 一緒の入力は、角や選んだノードで値が違えば「混在」。角ごとの入力も、選んだノードでその角の値が違えば「混在」。
// 角ごとに出すかはパネルの見た目だけで、値は変えない（角の値が違うノードを選んだときは、はじめから角ごとに出す）
export function CornerRadiusField(props: Omit<FieldProps<CornerRadius>, 'editor'> & { editor: ValueEditor<CornerRadiusChange> }) {
  const { label, icon, value, editor, onDone } = props
  const all = (value.kind === 'same' ? [value.value] : value.values).map(cornerRadii)
  const [separate, setSeparate] = useState(() => all.some((radii) => radii.some((r) => r !== radii[0])))
  const shared = (values: number[]): SharedValue<number> =>
    values.every((v) => v === values[0]) ? { kind: 'same', value: values[0] } : { kind: 'mixed', values }
  const editorFor = (corner: number | null): ValueEditor<number> => ({
    set: (radius) => editor.set({ corner, radius }),
    preview: (radius) => editor.preview({ corner, radius }),
    end: (commit) => editor.end(commit),
  })
  const toggle = (
    <button
      title="角ごとに変える"
      aria-label="角ごとに変える"
      aria-pressed={separate}
      className={separate ? 'design-icon-button active' : 'design-icon-button'}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => setSeparate(!separate)}
    >
      <Scan size={16} strokeWidth={1.75} aria-hidden />
    </button>
  )
  return (
    <div className="design-corner-radius" data-testid="corner-radius-field">
      <NumberField
        label={label}
        icon={icon}
        value={shared(all.flat())}
        editor={editorFor(null)}
        control={CORNER_RADIUS_CONTROL}
        onDone={onDone}
        extra={toggle}
      />
      {separate && (
        <div className="design-corner-grid">
          {/* 2×2 に、角の位置どおりに並べる（左上・右上 / 左下・右下） */}
          {[0, 1, 3, 2].map((corner) => (
            <NumberField
              key={corner}
              className="design-corner-cell"
              label={CORNER_LABELS[corner]}
              icon={CORNER_ICONS[corner]}
              value={shared(all.map((radii) => radii[corner]))}
              editor={editorFor(corner)}
              control={CORNER_CELL_CONTROL}
              onDone={onDone}
            />
          ))}
        </div>
      )}
    </div>
  )
}


// ---- 行の高さ（MAI-76） ----

const LINE_HEIGHT_UNITS: { unit: LineHeightUnit; label: string; title: string }[] = [
  { unit: 'multiplier', label: '×', title: '文字の大きさに対する倍率' },
  { unit: 'px', label: 'px', title: 'ピクセル（文字の大きさによらない）' },
]

// 行の高さ。数字の入力と、単位（倍率・px）の切り替え。
// 「24px」と打てば px、「150%」なら倍率 1.5、単位のない数字は今の単位で読む。単位のボタンは、見た目を変えずに単位だけを変える。
// ↑↓ で倍率は 0.05・px は 1 刻み（Shift で 10 倍）
export function LineHeightField(props: Omit<FieldProps<LineHeight>, 'editor'> & { editor: ValueEditor<LineHeightChange> }) {
  const { label, icon, value, editor, onDone } = props
  const { draft, setDraft, take } = useDraft()
  const current = value.kind === 'same' ? value.value : null
  // 選んでいるノードがみな同じ単位なら、その単位（値が混在していても）
  const units = new Set((value.kind === 'same' ? [value.value] : value.values).map((v) => v.unit))
  const unit: LineHeightUnit | null = units.size === 1 ? [...units][0] : null
  const shown = current ? String(current.value) : ''

  const commitDraft = () => {
    const text = take()
    const parsed = text === null ? null : parseLineHeight(text, unit ?? 'multiplier')
    if (parsed) editor.set(parsed)
  }
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitDraft()
      onDone?.()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setDraft(null)
      onDone?.()
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const base = draft !== null ? parseLineHeight(draft, unit ?? 'multiplier') : current
      if (!base) return
      const step = (base.unit === 'px' ? 1 : 0.05) * (e.shiftKey ? 10 : 1)
      setDraft(null)
      editor.set(clampLineHeight({ unit: base.unit, value: base.value + (e.key === 'ArrowUp' ? step : -step) }))
    }
  }

  return (
    <div className="design-field">
      <FieldLabel label={label} icon={icon} />
      <div className="design-control">
        <span className="design-number">
          <input
            type="text"
            inputMode="decimal"
            aria-label={label}
            value={draft ?? shown}
            placeholder={value.kind === 'mixed' ? MIXED_LABEL : ''}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={onKeyDown}
          />
        </span>
        <div className="design-segmented" role="group" aria-label={`${label}の単位`}>
          {LINE_HEIGHT_UNITS.map((option) => (
            <button
              key={option.unit}
              title={option.title}
              aria-pressed={unit === option.unit}
              className={unit === option.unit ? 'active' : ''}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => editor.set({ convertTo: option.unit })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// スライダー。動かし始めてから離すまで（change が届くまで）の変更を 1 回の Undo にまとめる。
// キーボード（← →）では 1 回押すごとに change が届くので、1 回ずつ確定する。Esc で動かす前の値に戻す
export function Slider(props: {
  label: string
  min: number
  max: number
  step: number
  value: number
  mixed: boolean
  onPreview: (value: number) => void
  onEnd: (commit: boolean) => void
  // 見た目を変えるクラス（色相・不透明度のスライダーの背景など。MAI-81）
  className?: string
}) {
  const { label, min, max, step, value, mixed, onPreview, onEnd, className } = props
  const inputRef = useRef<HTMLInputElement>(null)
  const changing = useRef(false)
  const onEndRef = useRef(onEnd)
  useEffect(() => {
    onEndRef.current = onEnd
  })
  const end = (commit: boolean) => {
    if (!changing.current) return
    changing.current = false
    onEndRef.current(commit)
  }
  // React の onChange は input で呼ばれるので、確定の change はここで直接受ける
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    const onChange = () => {
      if (!changing.current) return
      changing.current = false
      onEndRef.current(true)
    }
    input.addEventListener('change', onChange)
    return () => input.removeEventListener('change', onChange)
  }, [])
  return (
    <input
      ref={inputRef}
      type="range"
      className={['design-slider', mixed ? 'mixed' : '', className ?? ''].filter(Boolean).join(' ')}
      aria-label={`${label}のスライダー`}
      min={min}
      max={max}
      step={step}
      value={value}
      // 溝の左から今の値までを色で埋める（styles.css の --fill。Firefox は ::-moz-range-progress）
      style={{ '--fill': `${max > min ? ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100 : 0}%` } as CSSProperties}
      onChange={(e) => {
        changing.current = true
        onPreview(Number(e.target.value))
      }}
      onPointerCancel={() => end(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          end(false)
        }
      }}
      onBlur={() => end(true)}
    />
  )
}

// ---- 色 ----
// 色・塗りの部品（ColorField・PaintField）とカラーピッカーは ColorPicker.tsx（MAI-81）

// ---- 切り替えボタン ----

// ボタンは pointerdown を止めて、キャンバス（や文字の編集）からフォーカスを奪わない
export function SegmentedField(props: FieldProps<string> & { options: readonly SegmentOption[] }) {
  const { label, icon, value, editor, options } = props
  return (
    <div className="design-field">
      <FieldLabel label={label} icon={icon} />
      <div className="design-control design-segmented" role="group" aria-label={label}>
        {options.map((option) => {
          const active = value.kind === 'same' && value.value === option.value
          const Icon = option.icon
          return (
            <button
              key={option.value}
              title={option.title}
              aria-pressed={active}
              className={active ? 'active' : ''}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => editor.set(option.value)}
            >
              {Icon ? <Icon /> : (option.label ?? option.value)}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ---- オン・オフのボタン（MAI-79） ----

export interface ToggleItem {
  id: string
  title: string
  icon: ComponentType
  // null は値がない（ボタンはオフに見せる）
  value: SharedValue<boolean> | null
  onToggle(): void
}

// 太字・斜体などのボタンを 1 行に並べる。オンなら押した見た目、混在なら薄く押した見た目（aria-pressed="mixed"）。
// 押してもフォーカスを奪わない（編集中の文字の選択がそのまま残る）
export function ToggleGroup(props: { label: string; icon?: DesignIcon; items: readonly ToggleItem[] }) {
  const { label, icon, items } = props
  return (
    <div className="design-field">
      <FieldLabel label={label} icon={icon} />
      <div className="design-control design-segmented" role="group" aria-label={label}>
        {items.map((item) => (
          <ToggleButton key={item.id} item={item} />
        ))}
      </div>
    </div>
  )
}

export function ToggleButton(props: { item: ToggleItem }) {
  const { item } = props
  const state = toggleState(item.value)
  const Icon = item.icon
  return (
    <button
      title={item.title}
      aria-label={item.title}
      aria-pressed={state}
      className={state === true ? 'active' : state === 'mixed' ? 'mixed' : ''}
      data-toggle={item.id}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => item.onToggle()}
    >
      <Icon />
    </button>
  )
}

function toggleState(value: SharedValue<boolean> | null): boolean | 'mixed' {
  if (!value) return false
  return value.kind === 'mixed' ? 'mixed' : value.value
}

// ---- 一覧から選ぶ（MAI-78） ----

// 混在しているときは「混在」を選べない見出しとして出す。選んだらキャンバス（編集中の文字）にフォーカスを戻す
export function SelectField(props: FieldProps<string> & { options: readonly SelectOption[] }) {
  const { label, icon, value, editor, options, onDone } = props
  const groups: { name: string | undefined; options: SelectOption[] }[] = []
  for (const option of options) {
    const last = groups.at(-1)
    if (last && last.name === option.group) last.options.push(option)
    else groups.push({ name: option.group, options: [option] })
  }
  const optionElements = (list: readonly SelectOption[]) =>
    list.map((option) => (
      <option key={option.value} value={option.value}>
        {option.label}
      </option>
    ))
  return (
    <div className="design-field">
      <FieldLabel label={label} icon={icon} />
      <div className="design-control">
        <select
          className="design-select"
          aria-label={label}
          value={value.kind === 'same' ? value.value : ''}
          onChange={(e) => {
            if (e.target.value === '') return
            editor.set(e.target.value)
            onDone?.()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onDone?.()
            }
          }}
        >
          {value.kind === 'mixed' && (
            <option value="" disabled>
              {MIXED_LABEL}
            </option>
          )}
          {groups.map((group, i) =>
            group.name ? (
              <optgroup key={group.name} label={group.name}>
                {optionElements(group.options)}
              </optgroup>
            ) : (
              <Fragment key={`_${i}`}>{optionElements(group.options)}</Fragment>
            ),
          )}
        </select>
      </div>
    </div>
  )
}
