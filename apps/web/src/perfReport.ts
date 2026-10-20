import { percentile, type CanvasView } from '@canvcode/canvas'
import { rasterizeLog, type RasterizeLogEntry } from '@canvcode/nodes/markdown'

// 端末での性能の記録。開発者ツールを開けない端末（iPad など）で、どこが遅いかを調べるため、
// 今の Canvas で決まった動き（パン・ズーム）をして、フレームの間隔・描画の時間・画像（Markdown カードなど）を作る時間を測り、
// サーバーのログ（/api/client-log。[client] perf | …）に送る。?perf を付けて開くか、パイメニュー「そのほか › ベンチマーク」から

interface FramePhase {
  name: string
  frames: number
  // requestAnimationFrame の間隔（ms）。メインスレッドが止まっていれば空く
  intervalP50: number
  intervalP95: number
  intervalMax: number
  // 50 ms を超えた間隔の数
  long: number
  // シーンとオーバーレイの描画の時間（ms。view の計測）
  drawP50: number
  drawP95: number
  drawnNodes: number
  // このあいだに作った画像の数
  produced: number
}

const round = (value: number) => Math.round(value * 10) / 10

export async function runPerfReport(view: CanvasView, options: { bootMs?: number } = {}): Promise<string> {
  const startedAt = performance.now()
  const images = view.images
  const editor = view.editor
  const types: Record<string, number> = {}
  for (const id of editor.index.allIds()) {
    const node = editor.getNode(id)
    if (node) types[node.type] = (types[node.type] ?? 0) + 1
  }
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  const scripts = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
    .filter((r) => r.name.includes('/assets/') && r.name.endsWith('.js'))
    .map((r) => ({ name: r.name.split('/').pop(), ms: Math.round(r.duration), kb: Math.round(r.transferSize / 1024) }))

  // 開いたときの画像ができ終わるまで（最大 30 秒）
  const firstIdle = await waitIdle(view, 30_000)
  const producedAtStart = images.stats.produced

  const base = editor.session.get().camera
  const size = view.size
  const phases: FramePhase[] = []
  phases.push(
    await framePhase(view, 'パン', 3000, (t) => ({
      ...base,
      x: base.x + (Math.cos(t * Math.PI * 2) * size.width * 0.2) / base.zoom,
      y: base.y + (Math.sin(t * Math.PI * 2) * size.height * 0.2) / base.zoom,
    })),
  )
  phases.push(
    await framePhase(view, 'ズーム', 3000, (t) => {
      const zoom = base.zoom * Math.exp(Math.sin(t * Math.PI * 4) * 0.8)
      const cx = base.x + size.width / 2 / base.zoom
      const cy = base.y + size.height / 2 / base.zoom
      return { x: cx - size.width / 2 / zoom, y: cy - size.height / 2 / zoom, zoom }
    }),
  )
  // 2 倍に拡大して止め、画像を作り直し終えるまで（その間のフレームの間隔も）
  const zoomed = { x: base.x + size.width / 4 / base.zoom, y: base.y + size.height / 4 / base.zoom, zoom: base.zoom * 2 }
  view.setCamera(zoomed)
  const sharpen = await idlePhase(view, '2 倍で止めて作り直す', 20_000)
  view.setCamera(base)
  const back = await idlePhase(view, '元の倍率に戻して作り直す', 20_000)
  phases.push(sharpen.phase, back.phase)

  const report = {
    env: {
      ua: navigator.userAgent,
      dpr: window.devicePixelRatio,
      viewport: `${innerWidth}x${innerHeight}`,
      cores: navigator.hardwareConcurrency,
      canvas: editor.canvasId,
      nodes: types,
    },
    load: {
      responseEnd: nav ? Math.round(nav.responseEnd) : null,
      domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      bootMs: options.bootMs === undefined ? null : Math.round(options.bootMs),
      scripts,
    },
    firstImages: { ms: firstIdle.ms, produced: producedAtStart, timedOut: firstIdle.timedOut },
    phases,
    sharpMs: { zoomed: sharpen.ms, back: back.ms },
    imageCache: { entries: images.stats.entries, mb: round(images.stats.bytes / 1024 / 1024) },
    rasterize: summarizeRasterize(rasterizeLog),
    totalMs: Math.round(performance.now() - startedAt),
  }
  const body = JSON.stringify(report)
  await fetch('/api/client-log', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: `perf | ${body}` })
  return body
}

function waitIdle(view: CanvasView, timeoutMs: number): Promise<{ ms: number; timedOut: boolean }> {
  const start = performance.now()
  return new Promise((resolve) => {
    // 頼まれた画像は、次の描画で積まれるので、少し待ってから見始める
    const check = () => {
      const ms = performance.now() - start
      if (view.images.idle && ms > 300) resolve({ ms: Math.round(ms), timedOut: false })
      else if (ms > timeoutMs) resolve({ ms: Math.round(ms), timedOut: true })
      else setTimeout(check, 50)
    }
    setTimeout(check, 50)
  })
}

function framePhase(view: CanvasView, name: string, durationMs: number, camera: (t: number) => { x: number; y: number; zoom: number }): Promise<FramePhase> {
  const producedBefore = view.images.stats.produced
  return new Promise((resolve) => {
    let start: number | null = null
    let last: number | null = null
    const intervals: number[] = []
    const stop = view.onFrame((now) => {
      if (start === null) {
        start = now
        view.resetStats()
      }
      if (last !== null) intervals.push(now - last)
      last = now
      const t = (now - start) / durationMs
      if (t >= 1) {
        stop()
        resolve(phaseOf(name, intervals, view, view.images.stats.produced - producedBefore))
        return
      }
      view.setCamera(camera(t))
    })
  })
}

// カメラを止めたまま、画像を作り終えるまでの時間と、その間の requestAnimationFrame の間隔
function idlePhase(view: CanvasView, name: string, timeoutMs: number): Promise<{ ms: number; phase: FramePhase }> {
  const producedBefore = view.images.stats.produced
  view.resetStats()
  return new Promise((resolve) => {
    const start = performance.now()
    let last = start
    const intervals: number[] = []
    const step = (now: number) => {
      intervals.push(now - last)
      last = now
      const ms = now - start
      if ((view.images.idle && ms > 300) || ms > timeoutMs) {
        resolve({ ms: Math.round(ms), phase: phaseOf(name, intervals, view, view.images.stats.produced - producedBefore) })
        return
      }
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })
}

function phaseOf(name: string, intervals: number[], view: CanvasView, produced: number): FramePhase {
  const stats = view.getStats()
  const sorted = [...intervals].sort((a, b) => a - b)
  return {
    name,
    frames: intervals.length,
    intervalP50: round(percentile(sorted, 0.5)),
    intervalP95: round(percentile(sorted, 0.95)),
    intervalMax: round(sorted[sorted.length - 1] ?? 0),
    long: intervals.filter((v) => v > 50).length,
    drawP50: round(stats.drawP50),
    drawP95: round(stats.drawP95),
    drawnNodes: stats.drawnNodes,
    produced,
  }
}

// 画像を作った時間を、種類ごとに中央値・最大でまとめる（ログに収まるよう、1 件ずつは遅いものだけ）
function summarizeRasterize(log: RasterizeLogEntry[]) {
  const kinds: Record<string, unknown> = {}
  for (const kind of ['full', 'tile-source', 'tile'] as const) {
    const entries = log.filter((e) => e.kind === kind)
    if (entries.length === 0) continue
    const stat = (pick: (e: RasterizeLogEntry) => number) => {
      const values = entries.map(pick).sort((a, b) => a - b)
      return `${round(percentile(values, 0.5))}/${round(values[values.length - 1])}`
    }
    kinds[kind] = {
      count: entries.length,
      'total p50/max': stat((e) => e.totalMs),
      'inline p50/max': stat((e) => e.inlineImagesMs),
      'serialize p50/max': stat((e) => e.serializeMs),
      'decode p50/max': stat((e) => e.decodeMs),
      'draw p50/max': stat((e) => e.drawMs),
      'svgKB p50/max': stat((e) => e.svgBytes / 1024),
    }
  }
  const slowest = [...log]
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 5)
    .map((e) => `${e.kind} ${Math.round(e.width)}x${Math.round(e.height)}@${round(e.scale)} ${Math.round(e.totalMs)}ms (decode ${Math.round(e.decodeMs)}, draw ${Math.round(e.drawMs)}, svg ${Math.round(e.svgBytes / 1024)}KB)`)
  return { kinds, slowest }
}
