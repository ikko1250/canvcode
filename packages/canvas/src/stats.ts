// 描画の計測（MAI-14）。直近のフレームの時間を記録し、中央値と 95 パーセンタイルを出す。

export interface FrameSample {
  // 前回の描画からの間隔（ms）。連続して描画しているときだけ意味がある
  interval: number
  // シーンとオーバーレイの描画にかかった CPU 時間（ms）
  drawMs: number
  drawnNodes: number
}

export interface StatsSummary {
  fps: number
  intervalP50: number
  intervalP95: number
  drawP50: number
  drawP95: number
  drawnNodes: number
  totalNodes: number
  samples: number
}

const CAPACITY = 1200
// これより間隔が空いたフレームは、連続した描画ではないので間隔の統計から外す
const IDLE_GAP_MS = 250

export class FrameStats {
  private samples: FrameSample[] = []
  private lastFrameAt: number | null = null

  record(now: number, drawMs: number, drawnNodes: number): void {
    const interval = this.lastFrameAt === null ? Number.NaN : now - this.lastFrameAt
    this.lastFrameAt = now
    this.samples.push({ interval: interval > IDLE_GAP_MS ? Number.NaN : interval, drawMs, drawnNodes })
    if (this.samples.length > CAPACITY) this.samples.shift()
  }

  reset(): void {
    this.samples = []
    this.lastFrameAt = null
  }

  summary(totalNodes: number): StatsSummary {
    const intervals = this.samples.map((s) => s.interval).filter((v) => !Number.isNaN(v))
    const draws = this.samples.map((s) => s.drawMs)
    const p50 = percentile(intervals, 0.5)
    return {
      fps: p50 > 0 ? 1000 / p50 : 0,
      intervalP50: p50,
      intervalP95: percentile(intervals, 0.95),
      drawP50: percentile(draws, 0.5),
      drawP95: percentile(draws, 0.95),
      drawnNodes: this.samples.at(-1)?.drawnNodes ?? 0,
      totalNodes,
      samples: intervals.length,
    }
  }
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[i]
}
