import { fitBox, indicesBetween, unionBoxes, zoomAt, type Box, type Camera, type NodeRecord } from '@canvcode/core'
import { percentile, type CanvasView, type Editor } from '@canvcode/canvas'
import { rasterizeCounters } from '@canvcode/nodes/markdown'
import { batchVariants } from './markdown/samples.ts'

// Markdown カードを並べたときのズームの応答性のベンチマーク（MAI-22）。
// ズーム中は画像を作り直さず、止まってから画面内のカードを作り直す仕組み（MAI-5、MAI-14）が、
// ズームの最中と止めた直後にカクつかないかを測る。
// フレームの間隔は、描画の有無にかかわらず requestAnimationFrame の時刻から測る
// （作り直しでメインスレッドが止まっていれば、間隔が空く）。

export const CARD_COUNT = 48
const COLUMNS = 8
const CARD_W = 560
const CARD_H = 700
const GAP = 40

export function generateMarkdownCards(editor: Editor, count = CARD_COUNT): void {
  const sources = batchVariants(location.origin, count)
  const indices = indicesBetween(editor.index.topmost()?.index ?? null, null, count)
  const nodes: NodeRecord[] = sources.map((markdown, i) =>
    editor.makeNode('markdown-card', {
      x: (i % COLUMNS) * (CARD_W + GAP),
      y: Math.floor(i / COLUMNS) * (CARD_H + GAP),
      index: indices[i],
      // File を使わず、本文をカードに直接持たせる（ベンチマーク用）
      props: { w: CARD_W, h: CARD_H, sizing: 'fixed', inlineText: markdown },
    }),
  )
  editor.store.transact(
    'generate cards',
    (tx) => {
      for (const node of nodes) tx.put(node)
    },
    { history: 'ignore', scope: editor.canvasId },
  )
}

export interface CardPhaseResult {
  name: string
  frames: number
  fps: number
  p50: number
  p95: number
  max: number
  // 1 フレーム（16.7 ms）の 1.5 倍を超えた間隔の数
  dropped: number
  // 止めてから、画面内のすべてのカードが今の倍率の解像度になるまで（止めたフェーズだけ）
  sharpMs?: number
  produced: number
}

export interface CardBenchmarkResult {
  warmupMs: number
  dpr: number
  // どの方法で画像を作れたか
  raster: { bitmap: number; canvas: number; bitmapFallback: number }
  phases: CardPhaseResult[]
}

interface Phase {
  name: string
  durationMs: number
  // 経過時間の割合から、そのときのカメラを返す。null ならカメラを動かさない
  camera: ((t: number, ctx: { base: Camera; center: { x: number; y: number } }) => Camera) | null
  measureSharp?: boolean
}

// base は全体が見える倍率。そこから、ピンチでのズームのように連続して倍率を変える
const PHASES: Phase[] = [
  {
    name: '連続ズーム（ピンチ相当、1〜4 倍を往復）',
    durationMs: 4000,
    camera: (t, { base, center }) => zoomAt(base, center, base.zoom * (1 + 1.5 * (1 - Math.cos(t * Math.PI * 4)))),
  },
  {
    name: '止めた直後（3 倍で停止、作り直し中）',
    durationMs: 3000,
    camera: null,
    measureSharp: true,
  },
  {
    name: '作り直しの最中にパン（1.5 倍で停止 → 0.4 秒後にパン）',
    durationMs: 2500,
    camera: (t, { base, center }) => {
      const stopped = zoomAt(base, center, base.zoom * 1.5)
      // 最初の 0.4 秒は止めておき、作り直しを始めさせる
      const elapsed = t * 2500
      if (elapsed < 400) return stopped
      const dx = ((elapsed - 400) / 2100) * 900
      return { ...stopped, x: stopped.x + dx / stopped.zoom }
    },
  },
]

function summarize(name: string, intervals: number[], produced: number, sharpMs?: number): CardPhaseResult {
  const p50 = percentile(intervals, 0.5)
  return {
    name,
    frames: intervals.length,
    fps: p50 > 0 ? 1000 / p50 : 0,
    p50,
    p95: percentile(intervals, 0.95),
    max: intervals.length ? Math.max(...intervals) : 0,
    dropped: intervals.filter((v) => v > 25).length,
    sharpMs,
    produced,
  }
}

function cardBounds(editor: Editor): Box | null {
  return unionBoxes(
    editor.index.allIds().flatMap((id) => {
      const entry = editor.index.get(id)
      return entry && entry.node.type === 'markdown-card' ? [entry.worldBounds] : []
    }),
  )
}

// 画像キャッシュが空になる（作るべきものがなくなる）まで待つ
function waitForIdle(view: CanvasView, timeoutMs = 60000): Promise<number> {
  const start = performance.now()
  return new Promise((resolve) => {
    const check = () => {
      if (view.images.idle || performance.now() - start > timeoutMs) resolve(performance.now() - start)
      else setTimeout(check, 20)
    }
    // 描画されて、足りない画像が頼まれてから調べる
    requestAnimationFrame(() => requestAnimationFrame(check))
  })
}

export async function runCardBenchmark(view: CanvasView): Promise<CardBenchmarkResult> {
  const editor = view.editor
  if (!cardBounds(editor)) generateMarkdownCards(editor)
  const bounds = cardBounds(editor)!
  const size = view.size
  const base = fitBox(bounds, size.width, size.height, 24)
  const center = { x: size.width / 2, y: size.height / 2 }
  editor.setSelection([])
  view.setCamera(base)
  // 全体が見える倍率での最初の画像を作り終えるまで待つ
  const warmupMs = await waitForIdle(view)

  const phases: CardPhaseResult[] = []
  for (const phase of PHASES) {
    const intervals: number[] = []
    const producedBefore = view.images.stats.produced
    let sharpMs: number | undefined
    await new Promise<void>((resolve) => {
      let start: number | null = null
      let last: number | null = null
      if (!phase.camera) {
        // 止めるフェーズ：3 倍の位置で止める
        view.setCamera(zoomAt(base, center, base.zoom * 3))
      }
      const stop = view.onFrame((now) => {
        if (start === null) start = now
        if (last !== null) intervals.push(now - last)
        last = now
        const elapsed = now - start
        if (phase.measureSharp && sharpMs === undefined && elapsed > 200 && view.images.idle) sharpMs = elapsed
        if (elapsed >= phase.durationMs) {
          stop()
          resolve()
          return
        }
        if (phase.camera) view.setCamera(phase.camera(elapsed / phase.durationMs, { base, center }))
      })
    })
    if (phase.measureSharp && sharpMs === undefined) sharpMs = await waitForIdle(view).then((ms) => phase.durationMs + ms)
    phases.push(summarize(phase.name, intervals, view.images.stats.produced - producedBefore, sharpMs))
  }
  view.setCamera(base)
  return { warmupMs, dpr: window.devicePixelRatio || 1, phases, raster: { ...rasterizeCounters } }
}
