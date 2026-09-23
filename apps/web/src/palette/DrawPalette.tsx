import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { DrawStyle } from '@canvcode/canvas'
import {
  DRAW_COLORS,
  DRAW_OPACITY_STOPS,
  DRAW_SIZES,
  drawOpacityAngleFromPoint,
  drawOpacityFromAngle,
  drawOpacityToAngle,
  snapDrawOpacity,
} from '@canvcode/nodes'

// フリーハンドの色・太さ・透過率のパレット（MAI-27、MAI-49）。
// 選んでいる色をもう一度クリックすると、その色のまわりにリングのスライダーが出る。
// リングをなぞって透過率を決める。100 / 75 / 50 / 25 / 0 % に吸い付き、⌘（Ctrl）を押している間は自由

const SIZE_LABELS = ['細', '中', '太']

export function DrawPalette(props: { style: DrawStyle; onChange: (patch: Partial<DrawStyle>) => void }) {
  const { style, onChange } = props
  const [ringOpen, setRingOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 外をクリックするか Esc でリングを閉じる
  useEffect(() => {
    if (!ringOpen) return
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return
      setRingOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRingOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [ringOpen])

  const percent = Math.round(style.opacity * 100)

  return (
    <div className="style-palette" ref={rootRef}>
      {DRAW_COLORS.map((color) => {
        const active = style.color === color
        return (
          <span key={color} className={active && ringOpen ? 'swatch-slot ring-open' : 'swatch-slot'}>
            <button
              className={active ? 'swatch active' : 'swatch'}
              style={{ background: color }}
              title={active ? `${color}（もう一度クリックで透過率）` : color}
              aria-pressed={active}
              onClick={() => {
                if (active) setRingOpen((open) => !open)
                else {
                  onChange({ color })
                  setRingOpen(false)
                }
              }}
            />
            {active && ringOpen && (
              <>
                <OpacityRing
                  color={color}
                  opacity={style.opacity}
                  onChange={(opacity) => onChange({ opacity })}
                  onDragging={setDragging}
                />
                <span className={dragging ? 'opacity-label dragging' : 'opacity-label'} aria-live="polite">
                  {percent}%
                </span>
              </>
            )}
          </span>
        )
      })}
      <span className="separator" />
      {DRAW_SIZES.map((size, i) => (
        <button key={size} className={style.size === size ? 'active' : ''} onClick={() => onChange({ size })}>
          {SIZE_LABELS[i]}
        </button>
      ))}
    </div>
  )
}

// リングの寸法（px）。色のアイコン（22px）のすぐ外側に沿わせる
const RING_SIZE = 40
const RING_RADIUS = 15
const RING_WIDTH = 4
const HIT_WIDTH = 14
const KNOB_RADIUS = 4.5
const TRACK_COLOR = 'rgba(0, 0, 0, 0.14)'

function polar(angleDeg: number, radius = RING_RADIUS): { x: number; y: number } {
  const a = (angleDeg * Math.PI) / 180
  return { x: RING_SIZE / 2 + radius * Math.sin(a), y: RING_SIZE / 2 - radius * Math.cos(a) }
}

// 弧のパス（真上を 0 度として、from から to へ時計回り）
function arcPath(fromDeg: number, toDeg: number): string {
  const from = polar(fromDeg)
  const to = polar(toDeg)
  const large = toDeg - fromDeg > 180 ? 1 : 0
  return `M ${from.x} ${from.y} A ${RING_RADIUS} ${RING_RADIUS} 0 ${large} 1 ${to.x} ${to.y}`
}

function OpacityRing(props: {
  color: string
  opacity: number
  onChange: (opacity: number) => void
  onDragging: (dragging: boolean) => void
}) {
  const { color, opacity, onChange, onDragging } = props
  const svgRef = useRef<SVGSVGElement>(null)
  const pointerId = useRef<number | null>(null)

  const apply = (e: ReactPointerEvent) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const angle = drawOpacityAngleFromPoint(e.clientX - (rect.left + rect.width / 2), e.clientY - (rect.top + rect.height / 2))
    const next = snapDrawOpacity(drawOpacityFromAngle(angle), e.metaKey || e.ctrlKey)
    if (next !== opacity) onChange(next)
  }

  const startAngle = drawOpacityToAngle(0)
  const endAngle = drawOpacityToAngle(1)
  const valueAngle = drawOpacityToAngle(opacity)
  const knob = polar(valueAngle)

  return (
    <svg
      ref={svgRef}
      className="opacity-ring"
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      role="slider"
      aria-label="透過率"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(opacity * 100)}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        pointerId.current = e.pointerId
        e.currentTarget.setPointerCapture(e.pointerId)
        onDragging(true)
        apply(e)
      }}
      onPointerMove={(e) => {
        if (pointerId.current !== e.pointerId) return
        apply(e)
      }}
      onPointerUp={(e) => {
        if (pointerId.current !== e.pointerId) return
        pointerId.current = null
        onDragging(false)
      }}
      onPointerCancel={() => {
        pointerId.current = null
        onDragging(false)
      }}
    >
      {/* 当たり判定用の太い透明な弧 */}
      <path d={arcPath(startAngle, endAngle)} fill="none" stroke="transparent" strokeWidth={HIT_WIDTH} pointerEvents="stroke" />
      <path d={arcPath(startAngle, endAngle)} fill="none" stroke={TRACK_COLOR} strokeWidth={RING_WIDTH} strokeLinecap="round" pointerEvents="none" />
      {opacity > 0 && (
        <path d={arcPath(startAngle, valueAngle)} fill="none" stroke={color} strokeWidth={RING_WIDTH} strokeLinecap="round" pointerEvents="none" />
      )}
      {/* 吸い付き先の印 */}
      {DRAW_OPACITY_STOPS.map((stop) => {
        const p = polar(drawOpacityToAngle(stop))
        return <circle key={stop} cx={p.x} cy={p.y} r={1.1} fill="#ffffff" pointerEvents="none" />
      })}
      <circle cx={knob.x} cy={knob.y} r={KNOB_RADIUS} fill="#ffffff" stroke={color} strokeWidth={2} pointerEvents="none" />
    </svg>
  )
}
