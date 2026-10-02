import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { SharedValue } from '@canvcode/canvas'
import type { LineHeight, LineHeightUnit } from '@canvcode/nodes'
import { clampLineHeight, normalizeHexColor, parseLineHeight, parseNumber } from './parse.ts'
import type { FieldControl, SegmentOption } from './registry.ts'
import type { LineHeightChange } from './sections.ts'

// デザインパネルの入力部品（MAI-73）。数字・色・切り替えボタン・スライダー。
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
  value: SharedValue<T>
  editor: ValueEditor<T>
  // 入力を終えたら、キャンバスにフォーカスを戻す（Esc・Enter のあと）
  onDone?: () => void
}

// 入力欄に打っている途中の文字。確定（Enter・フォーカスを外す）までは値を変えない。
// Esc のあとフォーカスを外したときに、古い文字で確定しないよう、ref でも持つ
function useDraft() {
  const [draft, setState] = useState<string | null>(null)
  const ref = useRef<string | null>(null)
  const setDraft = (next: string | null) => {
    ref.current = next
    setState(next)
  }
  // 打っている文字を取り出して、空にする
  const take = (): string | null => {
    const text = ref.current
    setDraft(null)
    return text
  }
  return { draft, setDraft, take }
}

// ---- 数字 ----

type NumberControl = Extract<FieldControl, { kind: 'number' }>

export function NumberField(props: FieldProps<number> & { control: NumberControl }) {
  const { label, value, editor, control, onDone } = props
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
  return (
    <div className="design-field">
      <span
        className="design-label scrub"
        title={`${label}（左右にドラッグで変える）`}
        onPointerDown={onScrubDown}
        onPointerMove={onScrubMove}
        onPointerUp={(e) => onScrubEnd(e, true)}
        onPointerCancel={(e) => onScrubEnd(e, false)}
      >
        {label}
      </span>
      <div className="design-control">
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
        {control.slider && control.min !== undefined && control.max !== undefined && (
          <Slider
            label={label}
            min={control.min}
            max={control.max}
            step={step}
            value={sliderValue}
            mixed={value.kind === 'mixed'}
            onPreview={(v) => editor.preview(toValue(v))}
            onEnd={(commit) => editor.end(commit)}
          />
        )}
      </div>
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
  const { label, value, editor, onDone } = props
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
      <span className="design-label">{label}</span>
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
function Slider(props: {
  label: string
  min: number
  max: number
  step: number
  value: number
  mixed: boolean
  onPreview: (value: number) => void
  onEnd: (commit: boolean) => void
}) {
  const { label, min, max, step, value, mixed, onPreview, onEnd } = props
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
      className={mixed ? 'design-slider mixed' : 'design-slider'}
      aria-label={`${label}のスライダー`}
      min={min}
      max={max}
      step={step}
      value={value}
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


export function ColorField(props: FieldProps<string>) {
  const { label, value, editor, onDone } = props
  const { draft, setDraft, take } = useDraft()
  const pickerRef = useRef<HTMLInputElement>(null)
  const picking = useRef(false)
  const editorRef = useRef(editor)
  useEffect(() => {
    editorRef.current = editor
  })
  const current = value.kind === 'same' ? value.value : null

  // ブラウザの色の選択は、選んでいる間 input、閉じたときに change が届く。change までを 1 回の Undo にまとめる。
  // React の onChange は input で呼ばれるので、change はここで直接受ける
  useEffect(() => {
    const picker = pickerRef.current
    if (!picker) return
    const onChange = () => {
      if (!picking.current) return
      picking.current = false
      editorRef.current.end(true)
    }
    picker.addEventListener('change', onChange)
    picker.addEventListener('blur', onChange)
    return () => {
      picker.removeEventListener('change', onChange)
      picker.removeEventListener('blur', onChange)
    }
  }, [])

  const commitDraft = () => {
    const text = take()
    const color = text === null ? null : normalizeHexColor(text)
    if (color) editor.set(color)
  }

  return (
    <div className="design-field">
      <span className="design-label">{label}</span>
      <div className="design-control">
        <span className={value.kind === 'mixed' ? 'design-swatch mixed' : 'design-swatch'} style={current ? { background: current } : undefined}>
          <input
            ref={pickerRef}
            type="color"
            aria-label={`${label}を選ぶ`}
            value={(current && normalizeHexColor(current)) ?? '#000000'}
            onInput={(e) => {
              picking.current = true
              editor.preview(e.currentTarget.value)
            }}
            // 値は onInput で受ける（React の onChange は input と同じ）。制御された input の警告を出さないために置く
            onChange={() => {}}
          />
        </span>
        <input
          type="text"
          className="design-hex"
          aria-label={label}
          spellCheck={false}
          value={draft ?? current ?? ''}
          placeholder={value.kind === 'mixed' ? MIXED_LABEL : ''}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitDraft()
              onDone?.()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setDraft(null)
              onDone?.()
            }
          }}
        />
      </div>
    </div>
  )
}

// ---- 切り替えボタン ----

// ボタンは pointerdown を止めて、キャンバス（や文字の編集）からフォーカスを奪わない
export function SegmentedField(props: FieldProps<string> & { options: readonly SegmentOption[] }) {
  const { label, value, editor, options } = props
  return (
    <div className="design-field">
      <span className="design-label">{label}</span>
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
