import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { OWN_KEYS_ATTRIBUTE } from '@canvcode/canvas'
import { defaultPlotSpec, PLOT_KIND_LABELS, PLOT_KINDS, plotTable, plotUsesX, type PlotSpec, type PlotTable } from '@canvcode/nodes'
import { fetchPlotStyles, renderPlot, type PlotStyle, type RenderedPlot } from './plotClient.ts'

// CSV からグラフを作る・作り方を変えるダイアログ（plot.ts）。
// - 種類・横の軸の列・値の列・スタイル（style.py）・タイトル・軸の名前・大きさを選ぶと、少し待ってサーバーが描いたプレビューを出す
// - 「置く」（作り方を変えるときは「描き直す」）で、描いた PNG を画像のノードにする（どこに置くかは呼んだ側が決める）
// - 「Claude におまかせ」で、表を添えて Claude のパネルを開き、列と種類とスタイルを選ばせる
// - 中のキー入力はキャンバスに渡さない（data-own-keys）。Esc でやめる

const PREVIEW_DELAY_MS = 400

const SIZES: { label: string; width: number; height: number }[] = [
  { label: '横長（1280×800）', width: 1280, height: 800 },
  { label: '16:9（1600×900）', width: 1600, height: 900 },
  { label: '正方形（1000×1000）', width: 1000, height: 1000 },
  { label: '縦長（800×1100）', width: 800, height: 1100 },
]

// スタイルに大きさ（style.py の size）があれば、その大きさにする（スタイルを選ぶと、大きさもそのスタイルのものになる）
function withStyleSize<T extends Partial<PlotSpec>>(spec: T, style: PlotStyle | undefined): T {
  return style?.size ? { ...spec, width: style.size[0], height: style.size[1] } : spec
}

export interface PlotDialogProps {
  // 表の File の名前（見出しに出す）
  title: string
  fileId: string
  // 表の File の本文とパス
  loadTable(): Promise<{ text: string; path?: string }>
  // 作り方を変えるときの今の作り方（新しく作るときは null）
  initial: PlotSpec | null
  // 新しく作るときの 1 行目の扱い（表のカードと同じ）
  header: boolean
  onPlace(spec: PlotSpec, plot: RenderedPlot): Promise<void>
  onAskClaude: (() => void) | null
  onOpenStyleFile(): void
  onClose(): void
}

export function PlotDialog(props: PlotDialogProps) {
  const { fileId, loadTable, initial, onPlace, onClose } = props
  const [table, setTable] = useState<{ text: string; path?: string } | null>(null)
  const [styles, setStyles] = useState<PlotStyle[] | null>(null)
  const [spec, setSpec] = useState<PlotSpec | null>(initial)
  const [preview, setPreview] = useState<{ spec: PlotSpec; plot: RenderedPlot; url: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [placing, setPlacing] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 表とスタイルを読む。読めたら、新しく作るときは既定の作り方を決める
  useEffect(() => {
    let alive = true
    loadTable()
      .then((t) => alive && setTable(t))
      .catch((e: unknown) => alive && setError(`表を読めませんでした：${e instanceof Error ? e.message : String(e)}`))
    fetchPlotStyles()
      .then((s) => alive && setStyles(s))
      .catch((e: unknown) => {
        if (!alive) return
        setStyles([])
        setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [loadTable])

  // 新しく作るときは、表とスタイルを読めたら既定の作り方から始める（変えるまでは spec は null）
  const header = spec?.header ?? initial?.header ?? props.header
  const parsed: PlotTable | null = useMemo(() => (table ? plotTable(table.text, table.path, header) : null), [table, header])
  // （spec が null の間は header も props.header のままなので、parsed も変わらない）
  const defaults = useMemo(
    () => (parsed && styles ? withStyleSize(defaultPlotSpec(fileId, parsed, props.header, styles[0]?.name ?? ''), styles[0]) : null),
    [parsed, styles, fileId, props.header],
  )
  const current = spec ?? defaults

  // 作り方が変わったら、少し待ってプレビューを描く（前の頼みはやめる）。描いた作り方は previewed に覚え、同じなら描かない
  const previewed = useRef<PlotSpec | null>(null)
  useEffect(() => {
    if (!current || !styles || styles.length === 0 || current.y.length === 0 || previewed.current === current) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      renderPlot(current, controller.signal)
        .then((plot) => {
          previewed.current = current
          setError(null)
          setPreview({ spec: current, plot, url: URL.createObjectURL(plot.blob) })
        })
        .catch((e: unknown) => {
          if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e))
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }, PREVIEW_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
      setLoading(false)
    }
  }, [current, styles])
  // 前のプレビューの画像を捨てる（閉じたときも）
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview.url)
  }, [preview])

  // 表示される前に Esc を受ける（キャンバスまで届かないように）
  useLayoutEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const update = (change: Partial<PlotSpec>) => setSpec((s) => (s ?? defaults ? { ...(s ?? defaults)!, ...change } : null))
  const toggleY = (index: number) => {
    if (!current) return
    const y = current.y.includes(index) ? current.y.filter((c) => c !== index) : [...current.y, index].sort((a, b) => a - b)
    update({ y })
  }

  const place = async () => {
    if (!current || placing) return
    setPlacing(true)
    setError(null)
    try {
      const plot = preview && preview.spec === current ? preview.plot : await renderPlot(current)
      await onPlace(current, plot)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPlacing(false)
    }
  }

  const style = styles?.find((s) => s.name === current?.style)
  const usesX = current ? plotUsesX(current.kind) : true
  const size = SIZES.findIndex((s) => s.width === current?.width && s.height === current?.height)
  return (
    <div className="dialog-backdrop" onPointerDown={onClose}>
      <div
        ref={rootRef}
        className="dialog plot-dialog"
        role="dialog"
        aria-label="グラフを作る"
        tabIndex={-1}
        {...{ [OWN_KEYS_ATTRIBUTE]: '' }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h2>
          {initial ? 'グラフを編集' : 'グラフを作る'}
          <span className="plot-dialog-file">{props.title}</span>
        </h2>
        <div className="plot-dialog-body">
          <div className="plot-dialog-form">
            <label className="plot-field">
              <span>種類</span>
              <div className="plot-kinds" role="radiogroup" aria-label="種類">
                {PLOT_KINDS.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    role="radio"
                    aria-checked={current?.kind === kind}
                    className={current?.kind === kind ? 'active' : ''}
                    disabled={!current}
                    onClick={() => update({ kind })}
                  >
                    {PLOT_KIND_LABELS[kind]}
                  </button>
                ))}
              </div>
            </label>
            <label className="plot-field">
              <span>{current?.kind === 'pie' ? 'ラベルの列' : '横の軸'}</span>
              <select
                aria-label="横の軸"
                value={current?.x ?? ''}
                disabled={!current || !parsed || !usesX}
                onChange={(e) => update({ x: e.target.value === '' ? null : Number(e.target.value) })}
              >
                <option value="">行の番号</option>
                {parsed?.columns.map((c) => (
                  <option key={c.index} value={c.index}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="plot-field">
              <span>{current?.kind === 'pie' ? '値の列（最初の 1 つ）' : '値の列'}</span>
              <div className="plot-columns" role="group" aria-label="値の列">
                {parsed?.columns.map((c) => (
                  <label key={c.index} className={c.numeric ? '' : 'text-column'}>
                    <input type="checkbox" checked={current?.y.includes(c.index) ?? false} onChange={() => toggleY(c.index)} />
                    {c.name}
                    {!c.numeric && <small>文字</small>}
                  </label>
                ))}
              </div>
            </div>
            <label className="plot-field">
              <span>スタイル</span>
              <select aria-label="スタイル" value={current?.style ?? ''} disabled={!current || !styles?.length} onChange={(e) => update(withStyleSize({ style: e.target.value }, styles?.find((s) => s.name === e.target.value)))}>
                {styles?.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            {style && (
              <div className="plot-style-info">
                <span className="plot-swatches">
                  {style.colors.map((color, i) => (
                    <i key={i} style={{ background: color }} />
                  ))}
                </span>
                {style.description}
              </div>
            )}
            <button type="button" className="plot-link" onClick={props.onOpenStyleFile}>
              style.py を開く（スタイルを足す・直す）
            </button>
            <label className="plot-field">
              <span>タイトル</span>
              <input aria-label="タイトル" value={current?.title ?? ''} disabled={!current} onChange={(e) => update({ title: e.target.value })} />
            </label>
            {current && current.kind !== 'pie' && current.kind !== 'box' && (
              <div className="plot-field-row">
                <label className="plot-field">
                  <span>横の軸の名前</span>
                  <input aria-label="横の軸の名前" placeholder="列の名前" value={current.xlabel ?? ''} onChange={(e) => update({ xlabel: e.target.value || null })} />
                </label>
                <label className="plot-field">
                  <span>縦の軸の名前</span>
                  <input aria-label="縦の軸の名前" placeholder="列の名前" value={current.ylabel ?? ''} onChange={(e) => update({ ylabel: e.target.value || null })} />
                </label>
              </div>
            )}
            <div className="plot-field-row">
              <label className="plot-field">
                <span>大きさ</span>
                <select
                  aria-label="大きさ"
                  value={size}
                  disabled={!current}
                  onChange={(e) => {
                    const s = SIZES[Number(e.target.value)]
                    if (s) update({ width: s.width, height: s.height })
                  }}
                >
                  {size < 0 && current && <option value={-1}>{`${current.width}×${current.height}`}</option>}
                  {SIZES.map((s, i) => (
                    <option key={s.label} value={i}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="plot-check">
                <input type="checkbox" checked={header} disabled={!current} onChange={(e) => update({ header: e.target.checked })} />1 行目は見出し
              </label>
            </div>
          </div>
          <div className="plot-dialog-preview" aria-busy={loading}>
            {preview ? <img src={preview.url} alt="プレビュー" className={loading ? 'stale' : ''} /> : <div className="plot-placeholder">{loading ? '描いています…' : 'プレビュー'}</div>}
            {error && <p className="plot-error">{error}</p>}
            {!error && preview && preview.plot.warnings.length > 0 && (
              <ul className="plot-warnings">
                {preview.plot.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div className="dialog-buttons">
          {props.onAskClaude && (
            <button type="button" className="plot-claude" onClick={props.onAskClaude} title="表を添えて Claude のパネルを開き、列・種類・スタイルを選んでもらう">
              Claude におまかせ…
            </button>
          )}
          <button type="button" onClick={onClose}>
            やめる
          </button>
          <button type="button" className="primary" disabled={!current || current.y.length === 0 || placing || !styles?.length} onClick={() => void place()}>
            {placing ? '置いています…' : initial ? '描き直す' : '置く'}
          </button>
        </div>
      </div>
    </div>
  )
}
