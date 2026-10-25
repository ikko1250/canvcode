import type { PlotSpec } from '@canvcode/nodes'

// CSV から作るグラフ（apps/server/src/plot.ts）のサーバーとのやりとり

export interface PlotStyle {
  name: string
  description: string
  colors: string[]
  // 新しく作るときの画像の大きさ（画素の [幅, 高さ]。style.py の size）
  size?: [number, number]
}

export interface RenderedPlot {
  blob: Blob
  width: number
  height: number
  warnings: string[]
}

async function errorOf(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null
  return new Error(body?.error ?? `HTTP ${response.status}`)
}

// style.py のスタイルの一覧（ワークスペースに style.py がなければ、サーバーが同梱のものを写す）
export async function fetchPlotStyles(): Promise<PlotStyle[]> {
  const response = await fetch('/api/plot/styles')
  if (!response.ok) throw await errorOf(response)
  return ((await response.json()) as { styles: PlotStyle[] }).styles
}

// 作り方どおりに描いた PNG
export async function renderPlot(spec: PlotSpec, signal?: AbortSignal): Promise<RenderedPlot> {
  const response = await fetch('/api/plot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spec),
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) throw await errorOf(response)
  let warnings: string[] = []
  try {
    warnings = JSON.parse(decodeURIComponent(response.headers.get('x-canvcode-warnings') ?? '%5B%5D')) as string[]
  } catch {
    // 読めない知らせは捨てる
  }
  return {
    blob: await response.blob(),
    width: Number(response.headers.get('x-canvcode-width')) || spec.width,
    height: Number(response.headers.get('x-canvcode-height')) || spec.height,
    warnings,
  }
}
