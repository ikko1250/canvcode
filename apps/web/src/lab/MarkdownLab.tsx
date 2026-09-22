import 'katex/dist/katex.min.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  MARKDOWN_CARD_CSS,
  buildMarkdownCardHtml,
  hitLink,
  measureLinks,
  rasterizeHtml,
  renderMarkdown,
  type LinkRegion,
  type RasterizeResult,
} from '@canvcode/nodes/markdown'
import { percentile } from '@canvcode/canvas'
import { KATEX_BASE_CSS, buildEmbeddedKatexCss, type FontMode } from '../markdown/katexFonts.ts'
import { batchVariants, sampleMarkdown } from '../markdown/samples.ts'
import './lab.css'

// Markdown カードを画像に変換する方法の検証ページ（MAI-21）。
// 左：Markdown、中央：実物の DOM（比較の基準）、右：画像にして Canvas に貼ったもの。

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]
const RERENDER_DELAY_MS = 150
const BATCH_COUNT = 30

interface BatchResult {
  count: number
  firstMs: number
  p50Ms: number
  p95Ms: number
  totalMs: number
  scale: number
}

export function MarkdownLab() {
  const [markdown, setMarkdown] = useState(() => sampleMarkdown(location.origin))
  const [width, setWidth] = useState(560)
  const [height, setHeight] = useState(900)
  const [zoom, setZoom] = useState(1)
  const [autoRerender, setAutoRerender] = useState(true)
  const [fontMode, setFontMode] = useState<FontMode>('auto')
  const [urlMode, setUrlMode] = useState<'data' | 'blob'>('data')
  const [raster, setRaster] = useState<RasterizeResult | null>(null)
  const [fontInfo, setFontInfo] = useState<{ fonts: string[]; bytes: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [batch, setBatch] = useState<BatchResult | 'running' | null>(null)
  const [showLinks, setShowLinks] = useState(true)
  const [hoverHref, setHoverHref] = useState<string | null>(null)
  const [linkModifier, setLinkModifier] = useState(false)
  const outputRef = useRef<HTMLCanvasElement>(null)
  const dpr = window.devicePixelRatio || 1

  const render = useMemo(() => {
    // 所要時間を表示するためだけの計測なので、描画中に時刻を読んでも表示は不安定にならない
    // oxlint-disable-next-line react/purity
    const start = performance.now()
    const result = renderMarkdown(markdown)
    const html = buildMarkdownCardHtml('研究ノート.md', result.html)
    // oxlint-disable-next-line react/purity
    return { html, ms: performance.now() - start }
  }, [markdown])

  // リンクの位置。レイアウトは倍率によらないので、中身と大きさが変わったときだけ測る
  const links = useMemo(() => {
    // oxlint-disable-next-line react/purity
    const start = performance.now()
    const regions = measureLinks({ html: render.html, css: KATEX_BASE_CSS + MARKDOWN_CARD_CSS, width, height })
    // oxlint-disable-next-line react/purity
    return { regions, ms: performance.now() - start }
  }, [render.html, width, height])

  // 画像にする倍率。自動なら表示倍率に合わせ、そうでなければ等倍のまま
  const targetScale = (autoRerender ? zoom : 1) * dpr

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(async () => {
      try {
        const embedded = await buildEmbeddedKatexCss(render.html, fontMode)
        const result = await rasterizeHtml({
          html: render.html,
          css: embedded.css + MARKDOWN_CARD_CSS,
          width,
          height,
          scale: targetScale,
          urlMode,
        })
        if (cancelled) return
        setFontInfo({ fonts: embedded.fonts, bytes: embedded.fontBytes })
        setRaster(result)
        setError(null)
      } catch (e) {
        if (!cancelled) setError(String(e))
      }
    }, RERENDER_DELAY_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [render.html, width, height, targetScale, fontMode, urlMode])

  // 画像を、表示倍率に合わせて Canvas に貼る（キャンバス上のカードの描き方と同じ）
  useEffect(() => {
    const canvas = outputRef.current
    if (!canvas) return
    canvas.width = Math.round(width * zoom * dpr)
    canvas.height = Math.round(height * zoom * dpr)
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (!raster) return
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(raster.canvas, 0, 0, canvas.width, canvas.height)
    // 記録したリンクの位置を重ねて描き、画像の中のリンクと重なるかを確かめる
    if (showLinks) {
      const s = zoom * dpr
      for (const region of links.regions) {
        const hovered = region.href === hoverHref
        ctx.fillStyle = hovered ? 'rgba(47, 111, 237, 0.22)' : 'rgba(47, 111, 237, 0.08)'
        ctx.strokeStyle = 'rgba(47, 111, 237, 0.9)'
        ctx.lineWidth = dpr
        for (const r of region.rects) {
          ctx.fillRect(r.x * s, r.y * s, r.w * s, r.h * s)
          ctx.strokeRect(r.x * s, r.y * s, r.w * s, r.h * s)
        }
      }
    }
  }, [raster, width, height, zoom, dpr, links, showLinks, hoverHref])

  const linkAt = (e: React.MouseEvent<HTMLCanvasElement>): LinkRegion | null => {
    const rect = e.currentTarget.getBoundingClientRect()
    return hitLink(links.regions, (e.clientX - rect.left) / zoom, (e.clientY - rect.top) / zoom)
  }

  const runBatch = async () => {
    setBatch('running')
    const variants = batchVariants(location.origin, BATCH_COUNT)
    const times: number[] = []
    const start = performance.now()
    for (const [i, source] of variants.entries()) {
      const html = buildMarkdownCardHtml(`カード ${i + 1}`, renderMarkdown(source).html)
      const t0 = performance.now()
      const embedded = await buildEmbeddedKatexCss(html, fontMode)
      await rasterizeHtml({ html, css: embedded.css + MARKDOWN_CARD_CSS, width, height, scale: dpr, urlMode })
      times.push(performance.now() - t0)
    }
    setBatch({
      count: times.length,
      firstMs: times[0],
      p50Ms: percentile(times, 0.5),
      p95Ms: percentile(times, 0.95),
      totalMs: performance.now() - start,
      scale: dpr,
    })
  }

  const t = raster?.timings
  return (
    <div className="lab">
      <style>{MARKDOWN_CARD_CSS}</style>
      <header className="lab-controls">
        <strong>Markdown カードの画像化（MAI-21）</strong>
        <label>
          幅 <input type="number" value={width} min={200} max={1600} step={20} onChange={(e) => setWidth(Number(e.target.value))} />
        </label>
        <label>
          高さ <input type="number" value={height} min={200} max={2400} step={20} onChange={(e) => setHeight(Number(e.target.value))} />
        </label>
        <label>
          表示倍率
          <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
            {ZOOM_STEPS.map((z) => (
              <option key={z} value={z}>
                {Math.round(z * 100)}%
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={autoRerender} onChange={(e) => setAutoRerender(e.target.checked)} />
          倍率に合わせて作り直す
        </label>
        <label>
          数式フォント
          <select value={fontMode} onChange={(e) => setFontMode(e.target.value as FontMode)}>
            <option value="auto">使うものだけ埋め込む</option>
            <option value="all">すべて埋め込む</option>
            <option value="none">埋め込まない</option>
          </select>
        </label>
        <label>
          読み込み方
          <select value={urlMode} onChange={(e) => setUrlMode(e.target.value as 'data' | 'blob')}>
            <option value="data">data: URL</option>
            <option value="blob">blob: URL</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={showLinks} onChange={(e) => setShowLinks(e.target.checked)} />
          リンクの位置を表示
        </label>
        <button onClick={runBatch} disabled={batch === 'running'}>
          {batch === 'running' ? '実行中…' : `${BATCH_COUNT} 枚まとめて変換`}
        </button>
        <a href="/">キャンバスに戻る</a>
      </header>

      <section className="lab-metrics">
        {error && <div className="lab-error">エラー：{error}</div>}
        <div>
          Markdown → HTML：{render.ms.toFixed(1)} ms
          {t && (
            <>
              {' '}／ 画像の埋め込み {t.inlineImagesMs.toFixed(1)} ms ／ SVG 作成 {t.serializeMs.toFixed(1)} ms ／ 読み込み{' '}
              {t.decodeMs.toFixed(1)} ms ／ 描画 {t.drawMs.toFixed(1)} ms ／ <strong>合計 {t.totalMs.toFixed(1)} ms</strong>
            </>
          )}
        </div>
        {raster && (
          <div>
            画像の倍率 {raster.scale.toFixed(2)}（{raster.canvas.width}×{raster.canvas.height} px）／ SVG{' '}
            {(raster.svgBytes / 1024).toFixed(0)} KB ／ 数式フォント {fontInfo?.fonts.length ?? 0} 個（
            {((fontInfo?.bytes ?? 0) / 1024).toFixed(0)} KB）／ Canvas の汚染：
            <strong className={raster.tainted ? 'bad' : 'good'}>{raster.tainted ? 'あり（画素を読めない）' : 'なし'}</strong>
          </div>
        )}
        <div>
          リンク {links.regions.length} 個（矩形 {links.regions.reduce((n, r) => n + r.rects.length, 0)} 個）／ 位置の計測{' '}
          {links.ms.toFixed(1)} ms{hoverHref && <> ／ ポインタの下：{hoverHref}</>}
        </div>
        {batch && batch !== 'running' && (
          <div>
            {batch.count} 枚まとめて変換（倍率 {batch.scale}）：1 枚目 {batch.firstMs.toFixed(1)} ms ／ 中央値{' '}
            {batch.p50Ms.toFixed(1)} ms ／ 95% {batch.p95Ms.toFixed(1)} ms ／ 合計 {batch.totalMs.toFixed(0)} ms
          </div>
        )}
      </section>

      <main className="lab-panels">
        <div className="lab-panel lab-source">
          <h2>Markdown</h2>
          <textarea value={markdown} onChange={(e) => setMarkdown(e.target.value)} spellCheck={false} />
        </div>
        <div className="lab-panel">
          <h2>DOM（基準）</h2>
          <div className="lab-frame" style={{ width: width * zoom, height: height * zoom }}>
            <div
              style={{ width, height, transform: `scale(${zoom})`, transformOrigin: '0 0' }}
              dangerouslySetInnerHTML={{ __html: render.html }}
            />
          </div>
        </div>
        <div className="lab-panel">
          <h2>画像にして Canvas に貼ったもの</h2>
          <div className="lab-frame" style={{ width: width * zoom, height: height * zoom }}>
            <canvas
              ref={outputRef}
              // リンクは Ctrl（⌘）+クリックで開く。ふつうのクリックはカードの選択に使う（MAI-9）
              style={{ width: width * zoom, height: height * zoom, cursor: hoverHref && linkModifier ? 'pointer' : 'default' }}
              title={hoverHref ? `Ctrl（⌘）+クリックで開く：${hoverHref}` : undefined}
              onMouseMove={(e) => {
                setHoverHref(linkAt(e)?.href ?? null)
                setLinkModifier(e.ctrlKey || e.metaKey)
              }}
              onMouseLeave={() => setHoverHref(null)}
              onClick={(e) => {
                if (!(e.ctrlKey || e.metaKey)) return
                const link = linkAt(e)
                if (link) window.open(link.href, '_blank', 'noopener,noreferrer')
              }}
            />
          </div>
        </div>
      </main>
    </div>
  )
}
