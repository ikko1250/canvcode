import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { AlignEdge, Axis, Editor } from '@canvcode/canvas'

// 整列・等間隔・間隔のパレット（MAI-54）。2 つ以上のノードを選んでいるときに左端に出す。
// - 整列：全体を囲む箱の左・中央・右、上・中央・下に合わせる
// - 等間隔（3 つ以上）：両端はそのままに、間の隙間を等しくする
// - 間隔の指定：横・縦の間隔を数字で入れて「詰める」。既定は今の間隔の平均（PDF のページだけなら取り込んだときの間隔）。
//   等間隔に並べたあとは、キャンバスのピンクの棒（間隔のハンドル）をドラッグしても変えられる
// ボタンは pointerdown を止めて、キャンバスからフォーカスを奪わない。数字の入力は Enter で当てる

const ALIGNS: { edge: AlignEdge; title: string }[] = [
  { edge: 'left', title: '左揃え' },
  { edge: 'hcenter', title: '左右中央揃え' },
  { edge: 'right', title: '右揃え' },
  { edge: 'top', title: '上揃え' },
  { edge: 'vcenter', title: '上下中央揃え' },
  { edge: 'bottom', title: '下揃え' },
]

export function ArrangePalette(props: { editor: Editor; count: number; onDone?: () => void }) {
  const { editor, count, onDone } = props
  // 入力中の値（null なら既定値を出す）。選択が変わったら App が key で作り直すので、ここでは戻さない
  const [gapText, setGapText] = useState<{ x: string | null; y: string | null }>({ x: null, y: null })
  const defaults = { x: editor.defaultGap('x'), y: editor.defaultGap('y') }

  const apply = (axis: Axis) => {
    const text = gapText[axis]
    const value = text === null ? defaults[axis] : Number(text)
    if (value === null || !Number.isFinite(value)) return
    editor.spaceSelection(axis, Math.round(value))
    setGapText((prev) => ({ ...prev, [axis]: null }))
    onDone?.()
  }
  const onKeyDown = (axis: Axis) => (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      apply(axis)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setGapText((prev) => ({ ...prev, [axis]: null }))
      onDone?.()
    }
  }

  return (
    <div className="style-palette arrange" data-testid="arrange-palette">
      <div className="row">
        {ALIGNS.slice(0, 3).map((item) => (
          <button key={item.edge} title={item.title} onPointerDown={(e) => e.preventDefault()} onClick={() => editor.alignSelection(item.edge)}>
            <AlignEdgeIcon edge={item.edge} />
          </button>
        ))}
      </div>
      <div className="row">
        {ALIGNS.slice(3).map((item) => (
          <button key={item.edge} title={item.title} onPointerDown={(e) => e.preventDefault()} onClick={() => editor.alignSelection(item.edge)}>
            <AlignEdgeIcon edge={item.edge} />
          </button>
        ))}
      </div>
      <span className="separator" />
      <div className="row">
        <button
          title="横に等間隔（3 つ以上）"
          disabled={count < 3}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => editor.distributeSelection('x')}
        >
          <DistributeIcon axis="x" />
        </button>
        <button
          title="縦に等間隔（3 つ以上）"
          disabled={count < 3}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => editor.distributeSelection('y')}
        >
          <DistributeIcon axis="y" />
        </button>
      </div>
      <span className="separator" />
      {(['x', 'y'] as const).map((axis) => (
        <div className="row" key={axis}>
          <span className="value" title={axis === 'x' ? '横の間隔' : '縦の間隔'}>
            {axis === 'x' ? '横' : '縦'}
          </span>
          <input
            className="gap"
            type="number"
            step={1}
            aria-label={axis === 'x' ? '横の間隔' : '縦の間隔'}
            value={gapText[axis] ?? (defaults[axis] === null ? '' : String(defaults[axis]))}
            onChange={(e) => setGapText((prev) => ({ ...prev, [axis]: e.target.value }))}
            onKeyDown={onKeyDown(axis)}
          />
          <button title={axis === 'x' ? '横にこの間隔で詰める' : '縦にこの間隔で詰める'} onPointerDown={(e) => e.preventDefault()} onClick={() => apply(axis)}>
            詰める
          </button>
        </div>
      ))}
    </div>
  )
}

// 整列のアイコン：揃える辺（中央）の線と、長さの違う 2 本の棒
function AlignEdgeIcon(props: { edge: AlignEdge }) {
  const { edge } = props
  const horizontal = edge === 'left' || edge === 'hcenter' || edge === 'right'
  // 横方向の整列：縦線 1 本と横棒 2 本。縦方向は転置する
  const line = edge === 'left' || edge === 'top' ? 2 : edge === 'right' || edge === 'bottom' ? 14 : 8
  const bars: [number, number][] =
    edge === 'left' || edge === 'top' ? [[2, 12], [2, 8]] : edge === 'right' || edge === 'bottom' ? [[4, 14], [8, 14]] : [[3, 13], [5, 11]]
  const p = (x: number, y: number) => (horizontal ? { x, y } : { x: y, y: x })
  const a = p(line, 1)
  const b = p(line, 15)
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      {bars.map(([from, to], i) => {
        const at = 5 + i * 5
        const s = p(from, at)
        const e = p(to, at)
        return <line key={i} x1={s.x} y1={s.y} x2={e.x} y2={e.y} stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      })}
    </svg>
  )
}

// 等間隔のアイコン：軸に沿って並んだ 3 本の棒
function DistributeIcon(props: { axis: Axis }) {
  const p = (x: number, y: number) => (props.axis === 'x' ? { x, y } : { x: y, y: x })
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {[2, 8, 14].map((at) => {
        const s = p(at, 3)
        const e = p(at, 13)
        return <line key={at} x1={s.x} y1={s.y} x2={e.x} y2={e.y} stroke="currentColor" strokeWidth={at === 8 ? 3 : 1.5} strokeLinecap="round" />
      })}
    </svg>
  )
}
