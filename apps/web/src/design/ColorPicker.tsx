import { useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { SharedValue } from '@canvcode/canvas'
import { GEO_DEFAULT_FILL, normalizeColor, solidPaint, type Fill } from '@canvcode/nodes'
import { MIXED_LABEL, Slider, type ValueEditor } from './controls.tsx'
import { useDraft } from './useDraft.ts'
import { eyeDropperColor, hsvToHex, paintSummary, syncHsv, type Hsv } from './colorModel.ts'
import { UsedColorsContext } from './usedColorsContext.ts'
import { COLOR_PRESET_GROUPS } from './colorPresets.ts'
import { normalizeHexColor, parseNumber } from './parse.ts'
import type { FillChange } from './sections.ts'

// 色を選ぶ部品（MAI-81）。デザインパネルの色の項目（塗り・線・文字・付箋の地）は、どれもこのカラーピッカーを使う。
// - 見本を押すと、パネルの中にピッカーを開く：彩度・明度の四角、色相のスライダー、（塗りなら）不透明度のスライダー、
//   スポイト（EyeDropper API が使えるブラウザだけ）、「このキャンバスで使った色」、テンプレートの色（colorPresets.ts）
// - 四角・スライダーのドラッグは、離すまでを Undo 1 回にまとめる（ValueEditor の preview → end）。見本の色を押すのは 1 回の変更
// - 見本の横の欄に #rrggbb を打てる（#abc・abc も読む）
// - 塗り（PaintField）は、不透明度（0〜100 %）と塗りなしも選べる。不透明度は塗りだけに付ける（線・文字の色は不透明な色だけ。
//   ノード全体の不透明度はレイヤーの項目）
// ボタン・見本は pointerdown を止めて、キャンバス（編集中の文字）からフォーカスを奪わない

// EyeDropper API（Chromium 系だけ）。ないブラウザではスポイトのボタンを出さない
interface EyeDropperLike {
  open(): Promise<{ sRGBHex: string }>
}

function eyeDropperConstructor(): (new () => EyeDropperLike) | null {
  const ctor = (globalThis as { EyeDropper?: new () => EyeDropperLike }).EyeDropper
  return typeof ctor === 'function' ? ctor : null
}

// ---- ピッカー ----

export type ColorPickerChange = { color: string } | { opacity: number }

export function ColorPicker(props: {
  label: string
  // 今の色（#rrggbb）。混在・塗りなしなら null
  color: string | null
  // 塗りの不透明度（0〜1）。undefined なら不透明度のスライダーを出さない。null は混在
  opacity?: number | null
  // 1 回の変更（見本・スポイト）
  onSet(change: ColorPickerChange): void
  // 続けて変わる変更（四角・スライダーのドラッグ）。onEnd までが Undo 1 回
  onPreview(change: ColorPickerChange): void
  onEnd(commit: boolean): void
  onClose(): void
}) {
  const { label, color, opacity, onSet, onPreview, onEnd, onClose } = props
  const getUsedColors = useContext(UsedColorsContext)
  // 開いたときに集める（開いている間に色を変えても、一覧の並びは動かさない）
  const used = useMemo(() => getUsedColors(), [getUsedColors])
  const [picked, setHsv] = useState<Hsv>(() => syncHsv(null, color ?? '#ffffff') ?? { h: 0, s: 0, v: 1 })
  // 外から色が変わったら（Undo・欄に打つ・見本）、ピッカーもそれに合わせる（灰色なら色相はそのまま）
  const hsv = color ? (syncHsv(picked, color) ?? picked) : picked
  const square = useRef<HTMLDivElement>(null)
  const dragging = useRef<number | null>(null)
  const EyeDropper = eyeDropperConstructor()

  const previewHsv = (next: Hsv) => {
    setHsv(next)
    onPreview({ color: hsvToHex(next) })
  }
  const squareAt = (e: ReactPointerEvent<HTMLElement>): Hsv => {
    const rect = square.current!.getBoundingClientRect()
    const s = Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, rect.width)))
    const v = 1 - Math.min(1, Math.max(0, (e.clientY - rect.top) / Math.max(1, rect.height)))
    return { h: hsv.h, s, v }
  }
  const onSquareDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragging.current = e.pointerId
    previewHsv(squareAt(e))
  }
  const onSquareMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging.current !== e.pointerId) return
    previewHsv(squareAt(e))
  }
  const onSquareEnd = (e: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    if (dragging.current !== e.pointerId) return
    dragging.current = null
    onEnd(commit)
  }
  // ← → で彩度、↑ ↓ で明度を 1 % ずつ（Shift で 10 %）
  const onSquareKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.01
    const delta: Partial<Record<string, [number, number]>> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }
    const d = delta[e.key]
    if (!d) return
    e.preventDefault()
    const next = { h: hsv.h, s: Math.min(1, Math.max(0, hsv.s + d[0])), v: Math.min(1, Math.max(0, hsv.v + d[1])) }
    setHsv(next)
    onSet({ color: hsvToHex(next) })
  }

  const pickFromScreen = async () => {
    if (!EyeDropper) return
    try {
      const result = await new EyeDropper().open()
      const picked = eyeDropperColor(result.sRGBHex)
      if (picked) onSet({ color: picked })
    } catch {
      // Esc で取りやめたとき
    }
  }

  const current = color ? normalizeColor(color) : null
  return (
    <div
      className="design-color-popup"
      role="dialog"
      aria-label={`${label}のカラーピッカー`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div
        ref={square}
        className="design-color-square"
        role="slider"
        tabIndex={0}
        aria-label={`${label}の彩度と明度`}
        aria-valuetext={hsvToHex(hsv)}
        style={{ backgroundColor: hsvToHex({ h: hsv.h, s: 1, v: 1 }) }}
        onPointerDown={onSquareDown}
        onPointerMove={onSquareMove}
        onPointerUp={(e) => onSquareEnd(e, true)}
        onPointerCancel={(e) => onSquareEnd(e, false)}
        onKeyDown={onSquareKey}
      >
        <span className="design-color-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hsvToHex(hsv) }} />
      </div>
      <div className="design-color-row">
        {EyeDropper && (
          <button className="design-eyedropper" title="画面から色を取る（スポイト）" aria-label="スポイト" onPointerDown={(e) => e.preventDefault()} onClick={() => void pickFromScreen()}>
            <EyeDropperIcon />
          </button>
        )}
        <Slider
          label={`${label}の色相`}
          className="design-hue-slider"
          min={0}
          max={360}
          step={1}
          value={Math.round(hsv.h)}
          mixed={false}
          onPreview={(h) => previewHsv({ ...hsv, h })}
          onEnd={onEnd}
        />
      </div>
      {opacity !== undefined && (
        // 不透明度のスライダーの背景は、透明から今の色へ
        <div className="design-color-row" style={{ '--alpha-color': hsvToHex(hsv) } as CSSProperties}>
          <Slider
            label={`${label}の不透明度`}
            className="design-alpha-slider"
            min={0}
            max={100}
            step={1}
            value={Math.round((opacity ?? 1) * 100)}
            mixed={opacity === null}
            onPreview={(v) => onPreview({ opacity: v / 100 })}
            onEnd={onEnd}
          />
        </div>
      )}
      {used.length > 0 && <Swatches title="このキャンバスで使った色" colors={used.map((c) => ({ color: c, name: c }))} current={current} onPick={(c) => onSet({ color: c })} />}
      {COLOR_PRESET_GROUPS.map((group) => (
        <Swatches key={group.name} title={`テンプレート：${group.name}`} colors={group.colors} current={current} onPick={(c) => onSet({ color: c })} />
      ))}
    </div>
  )
}

function Swatches(props: { title: string; colors: readonly { color: string; name: string }[]; current: string | null; onPick: (color: string) => void }) {
  const { title, colors, current, onPick } = props
  return (
    <div className="design-color-group">
      <div className="design-color-group-title">{title}</div>
      <div className="design-color-chips" role="group" aria-label={title}>
        {colors.map(({ color, name }) => {
          const value = normalizeColor(color)
          return (
            <button
              key={value}
              className={value === current ? 'design-color-chip selected' : 'design-color-chip'}
              title={name === color ? color : `${name}（${color}）`}
              aria-label={name === color ? color : `${name} ${color}`}
              data-color={value}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => onPick(value)}
            >
              <span style={{ background: color }} />
            </button>
          )
        })}
      </div>
    </div>
  )
}

function EyeDropperIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <path d="M10.5 2.5l3 3-1.5 1.5-1-1-5.5 5.5H4v-1.5L9.5 4.5l-1-1z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M4 12l-1.5 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

// ---- 開け閉め ----

// ピッカーを開いているか。項目の外を押したら閉じる（パネルの外を押したときの確定は DesignPanel が行う）
function usePickerOpen() {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])
  return { open, setOpen, rootRef }
}

// 見本。色のない（混在・塗りなし）ときは模様で見せる。不透明度のある色は、市松模様の上に重ねる
function SwatchButton(props: { label: string; color: string | null; state: 'color' | 'mixed' | 'none'; open: boolean; onToggle: () => void }) {
  const { label, color, state, open, onToggle } = props
  return (
    <button
      className={`design-swatch ${state === 'color' ? '' : state}`.trim()}
      aria-label={`${label}を選ぶ`}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={state === 'mixed' ? MIXED_LABEL : state === 'none' ? 'なし' : (color ?? '')}
      onPointerDown={(e) => e.preventDefault()}
      onClick={onToggle}
    >
      {state === 'color' && color && <span style={{ background: color }} />}
    </button>
  )
}

// #rrggbb を打つ欄。確定（Enter・フォーカスを外す）で onCommit
function HexInput(props: { label: string; value: string | null; placeholder: string; onCommit: (color: string) => void; onDone?: () => void }) {
  const { label, value, placeholder, onCommit, onDone } = props
  const { draft, setDraft, take } = useDraft()
  const commitDraft = () => {
    const text = take()
    const color = text === null ? null : normalizeHexColor(text)
    if (color) onCommit(color)
  }
  return (
    <input
      type="text"
      className="design-hex"
      aria-label={label}
      spellCheck={false}
      value={draft ?? value ?? ''}
      placeholder={placeholder}
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
  )
}

// ---- 色（文字列）の項目 ----

export function ColorField(props: { label: string; value: SharedValue<string>; editor: ValueEditor<string>; onDone?: () => void }) {
  const { label, value, editor, onDone } = props
  const { open, setOpen, rootRef } = usePickerOpen()
  const current = value.kind === 'same' ? value.value : null
  const toColor = (change: ColorPickerChange) => ('color' in change ? change.color : null)
  return (
    <div className="design-field design-color-field" ref={rootRef}>
      <span className="design-label">{label}</span>
      <div className="design-control">
        <SwatchButton label={label} color={current} state={current ? 'color' : 'mixed'} open={open} onToggle={() => setOpen(!open)} />
        <HexInput label={label} value={current} placeholder={value.kind === 'mixed' ? MIXED_LABEL : ''} onCommit={(c) => editor.set(c)} onDone={onDone} />
        {open && (
          <ColorPicker
            label={label}
            color={current}
            onSet={(change) => {
              const color = toColor(change)
              if (color) editor.set(color)
            }}
            onPreview={(change) => {
              const color = toColor(change)
              if (color) editor.preview(color)
            }}
            onEnd={(commit) => editor.end(commit)}
            onClose={() => {
              setOpen(false)
              onDone?.()
            }}
          />
        )}
      </div>
    </div>
  )
}

// ---- 塗りの項目 ----

// 最後に「塗りなし」にした塗り。＋で塗りを足すときは、これに戻す（なければ図形の既定の色）。
// 選び直すとパネルの項目は作り直されるので、項目の外（このタブの間）で覚えておく
let lastRemovedFill: Fill = null

export function PaintField(props: {
  label: string
  value: SharedValue<Fill>
  editor: ValueEditor<FillChange>
  // 不透明度・塗りなしを選べるか（選んでいるノードのすべてが持てるとき）
  canOpacity: boolean
  canNone: boolean
  onDone?: () => void
}) {
  const { label, value, editor, canOpacity, canNone, onDone } = props
  const { open, setOpen, rootRef } = usePickerOpen()
  const summary = paintSummary(value)
  const toChange = (change: ColorPickerChange): FillChange =>
    'color' in change ? { change: 'color', color: change.color } : { change: 'opacity', opacity: change.opacity }

  const state = summary.allNone ? 'none' : summary.preview ? 'color' : 'mixed'
  const showOpacity = canOpacity && !summary.anyNone
  return (
    <div className="design-field design-color-field design-paint-field" ref={rootRef}>
      <span className="design-label">{label}</span>
      <div className="design-control">
        <SwatchButton label={label} color={summary.preview} state={state} open={open} onToggle={() => setOpen(!open)} />
        <HexInput
          label={label}
          value={summary.color}
          placeholder={summary.allNone ? 'なし' : value.kind === 'mixed' ? MIXED_LABEL : ''}
          onCommit={(c) => editor.set({ change: 'color', color: c })}
          onDone={onDone}
        />
        {showOpacity && <OpacityInput label={`${label}の不透明度`} value={summary.opacity} onCommit={(o) => editor.set({ change: 'opacity', opacity: o })} onDone={onDone} />}
        {canNone &&
          (summary.allNone ? (
            <button className="design-fill-toggle" title="塗りを足す" aria-label="塗りを足す" onPointerDown={(e) => e.preventDefault()} onClick={() => editor.set(lastRemovedFill ?? solidPaint(GEO_DEFAULT_FILL))}>
              +
            </button>
          ) : (
            <button className="design-fill-toggle" title="塗りなしにする" aria-label="塗りなしにする" onPointerDown={(e) => e.preventDefault()} onClick={() => {
                if (value.kind === 'same' && value.value) lastRemovedFill = value.value
                editor.set(null)
              }}>
              −
            </button>
          ))}
        {open && (
          <ColorPicker
            label={label}
            color={summary.color}
            opacity={canOpacity ? summary.opacity : undefined}
            onSet={(change) => editor.set(toChange(change))}
            onPreview={(change) => editor.preview(toChange(change))}
            onEnd={(commit) => editor.end(commit)}
            onClose={() => {
              setOpen(false)
              onDone?.()
            }}
          />
        )}
      </div>
    </div>
  )
}

// 不透明度（0〜100 %）を打つ欄。↑↓ で 1 %、Shift で 10 %
function OpacityInput(props: { label: string; value: number | null; onCommit: (opacity: number) => void; onDone?: () => void }) {
  const { label, value, onCommit, onDone } = props
  const { draft, setDraft, take } = useDraft()
  const shown = value === null ? '' : String(Math.round(value * 100))
  const toOpacity = (percent: number) => Math.min(100, Math.max(0, Math.round(percent))) / 100
  const commitDraft = () => {
    const text = take()
    const parsed = text === null ? null : parseNumber(text)
    if (parsed !== null) onCommit(toOpacity(parsed))
  }
  return (
    <span className="design-number design-opacity">
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        value={draft ?? shown}
        placeholder={value === null ? MIXED_LABEL : ''}
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
          } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && value !== null) {
            e.preventDefault()
            const base = draft !== null ? (parseNumber(draft) ?? value * 100) : value * 100
            setDraft(null)
            onCommit(toOpacity(base + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)))
          }
        }}
      />
      <span className="design-unit">%</span>
    </span>
  )
}
