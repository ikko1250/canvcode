import { fitBox, indicesBetween, type Camera, type NodeRecord } from '@canvcode/core'
import type { CanvasView, Editor, StatsSummary } from '@canvcode/canvas'

// 1 万ノードのベンチマーク（MAI-14、MAI-20）。
// 手元の PC のブラウザで開いて測る。決まった動きでパンとズームを行い、段階ごとにフレーム時間を集計する。

const PALETTE = [
  { fill: '#e8eefc', stroke: '#3b5bdb' },
  { fill: '#e6f6ec', stroke: '#2f9e44' },
  { fill: '#fff4e6', stroke: '#e8590c' },
  { fill: '#f3e8fc', stroke: '#9c36b5' },
  { fill: '#fdecee', stroke: '#e03131' },
]

// 決まった並びになるよう、乱数は種から作る
function seededRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31
    return state / 2 ** 31
  }
}

// 格子状に count 個の図形を作る。履歴には残さない
export function generateNodes(editor: Editor, count: number): void {
  const random = seededRandom(7)
  const columns = Math.ceil(Math.sqrt(count))
  const spacing = 160
  const indices = indicesBetween(editor.index.topmost()?.index ?? null, null, count)
  const nodes: NodeRecord[] = []
  for (let i = 0; i < count; i++) {
    const colors = PALETTE[Math.floor(random() * PALETTE.length)]
    const w = 60 + random() * 80
    const h = 60 + random() * 80
    const node = editor.makeNode('geo', {
      x: (i % columns) * spacing + (spacing - w) / 2,
      y: Math.floor(i / columns) * spacing + (spacing - h) / 2,
      index: indices[i],
      props: { shape: random() < 0.5 ? 'rect' : 'ellipse', w, h, ...colors },
    })
    nodes.push(node)
  }
  editor.store.transact(
    'generate',
    (tx) => {
      for (const node of nodes) tx.put(node)
    },
    { history: 'ignore', scope: editor.canvasId },
  )
}

export function clearNodes(editor: Editor): void {
  editor.store.transact(
    'clear',
    (tx) => {
      for (const id of [...editor.index.allIds()]) tx.remove(id)
    },
    { history: 'ignore', scope: editor.canvasId },
  )
}

export interface PhaseResult {
  name: string
  stats: StatsSummary
}

interface Phase {
  name: string
  durationMs: number
  camera(t: number, base: Camera, size: { width: number; height: number }): Camera
}

// ワールド全体が見える倍率（最も多くのノードを描く、いちばん重い状態）を基準にする
const PHASES: Phase[] = [
  {
    name: '全体表示でパン（全ノードが画面内）',
    durationMs: 4000,
    camera: (t, base, size) => {
      const r = (size.width / base.zoom) * 0.08
      return { ...base, x: base.x + Math.cos(t * Math.PI * 2) * r, y: base.y + Math.sin(t * Math.PI * 2) * r }
    },
  },
  {
    name: 'ズームイン・アウトを繰り返す',
    durationMs: 4000,
    camera: (t, base, size) => {
      const zoom = base.zoom * Math.exp(Math.sin(t * Math.PI * 4) * 1.6 + 1.6)
      const cx = base.x + size.width / 2 / base.zoom
      const cy = base.y + size.height / 2 / base.zoom
      return { x: cx - size.width / 2 / zoom, y: cy - size.height / 2 / zoom, zoom }
    },
  },
  {
    name: '等倍でパン（一部のノードだけが画面内）',
    durationMs: 4000,
    camera: (t, base, size) => {
      const worldW = size.width / base.zoom
      return { x: base.x + worldW * 0.1 + t * worldW * 0.6, y: base.y + worldW * 0.2, zoom: 1 }
    },
  },
]

export function runBenchmark(view: CanvasView, onDone: (results: PhaseResult[]) => void): () => void {
  const editor = view.editor
  const all = editor.index.allIds().flatMap((id) => {
    const entry = editor.index.get(id)
    return entry ? [entry.worldBounds] : []
  })
  if (all.length === 0) {
    onDone([])
    return () => {}
  }
  const minX = Math.min(...all.map((b) => b.x))
  const minY = Math.min(...all.map((b) => b.y))
  const maxX = Math.max(...all.map((b) => b.x + b.w))
  const maxY = Math.max(...all.map((b) => b.y + b.h))
  const size = view.size
  const base = fitBox({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, size.width, size.height, 16)

  const results: PhaseResult[] = []
  let phaseIndex = 0
  let phaseStart: number | null = null
  editor.setSelection([])

  const stop = view.onFrame((now) => {
    const phase = PHASES[phaseIndex]
    if (phaseStart === null) {
      phaseStart = now
      view.resetStats()
    }
    const t = (now - phaseStart) / phase.durationMs
    if (t >= 1) {
      results.push({ name: phase.name, stats: view.getStats() })
      phaseIndex++
      phaseStart = null
      if (phaseIndex >= PHASES.length) {
        stop()
        view.setCamera(base)
        onDone(results)
      }
      return
    }
    view.setCamera(phase.camera(t, base, size))
  })
  return stop
}
