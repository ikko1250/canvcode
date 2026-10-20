import type { Box } from '@canvcode/core'
import { IMAGE_LEVELS } from '../defineNodeType.ts'
import { clampScale } from './rasterize.ts'

// 長いカードを、見えているところだけタイルで描く。
// カード全体を 1 枚の画像にすると、1 辺・画素数の上限（clampScale）で解像度が抑えられ、長いカードがぼやける。
// そこで、全体の画像は上限に収まる解像度で作って下に敷き、それより高い解像度が要るときは、
// 見えている部分をタイル（カードのローカル座標で TILE_SIZE の正方形）に分けて、頼んだ解像度で重ねて描く。
// タイルの大きさは CSS ピクセルで決めるので、キーが解像度によらず、画像キャッシュの「近い解像度を返す」がそのまま使える

export const TILE_SIZE = 512

export interface Tile {
  col: number
  row: number
  // カードのローカル座標（CSS ピクセル）。右端・下端のタイルは短い
  x: number
  y: number
  w: number
  h: number
}

// カード全体の 1 枚の画像の画素数の上限。全体の画像を作る時間は画素数にほぼ比例し、その間はメインスレッドが止まる
// （iPad の Safari で、839×14010 の 0.5 倍（290 万画素）に 364ms、ふつうのカードでも 100ms 近く）。
// それより高い解像度は、タイルで重ねる（タイルは 1 枚 1〜数 ms で済む）
export const FULL_IMAGE_MAX_PIXELS = 1_500_000

// カード全体を 1 枚の画像にしても、解像度が抑えられず、画素数も FULL_IMAGE_MAX_PIXELS に収まる最も高い段階。
// どの段階でも収まらないなら最も低い段階（実際の解像度は fullImageScale で下げる）
export function fullImageLevel(width: number, height: number, maxPixels = FULL_IMAGE_MAX_PIXELS): number {
  let best: number = IMAGE_LEVELS[0]
  for (const level of IMAGE_LEVELS) {
    if (clampScale(width, height, level) >= level && width * height * level * level <= maxPixels) best = level
  }
  return best
}

// 段階 level で全体の画像を作るときの、実際の解像度の倍率（画素数を FULL_IMAGE_MAX_PIXELS に収める）。
// 最も低い段階でも収まらない長いカードは、段階より粗くする（下に敷くだけで、見えている部分はタイルで描く）
export function fullImageScale(width: number, height: number, level: number, maxPixels = FULL_IMAGE_MAX_PIXELS): number {
  return Math.min(level, Math.sqrt(maxPixels / (width * height)))
}

// rect（カードのローカル座標）にかかるタイル。rect の中心に近いものから並べる（近いものから作る）
export function tilesInRect(width: number, height: number, rect: Box, size = TILE_SIZE): Tile[] {
  const x0 = Math.max(0, rect.x)
  const y0 = Math.max(0, rect.y)
  const x1 = Math.min(width, rect.x + rect.w)
  const y1 = Math.min(height, rect.y + rect.h)
  if (x1 <= x0 || y1 <= y0) return []
  const tiles: Tile[] = []
  for (let row = Math.floor(y0 / size); row * size < y1; row++) {
    for (let col = Math.floor(x0 / size); col * size < x1; col++) {
      const x = col * size
      const y = row * size
      tiles.push({ col, row, x, y, w: Math.min(size, width - x), h: Math.min(size, height - y) })
    }
  }
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const distance = (t: Tile) => Math.hypot(t.x + t.w / 2 - cx, t.y + t.h / 2 - cy)
  return tiles.sort((a, b) => distance(a) - distance(b))
}

// ctx の描き先（canvas 全体）のうち、ノードのローカル座標で見えている範囲（ノードの箱 0..width × 0..height に切る）。
// ctx の行列はノードのローカル座標 → 描き先の画素なので、その逆で描き先の四隅を戻す（回転していても正しい）。
// 行列や描き先の大きさが分からないときは null
export function visibleLocalRect(ctx: CanvasRenderingContext2D, width: number, height: number): Box | null {
  if (typeof ctx.getTransform !== 'function' || !ctx.canvas) return null
  const m = ctx.getTransform()
  if (!m.is2D) return null
  const det = m.a * m.d - m.b * m.c
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  const cw = ctx.canvas.width
  const ch = ctx.canvas.height
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [px, py] of [[0, 0], [cw, 0], [0, ch], [cw, ch]]) {
    const dx = px - m.e
    const dy = py - m.f
    const x = (m.d * dx - m.c * dy) / det
    const y = (-m.b * dx + m.a * dy) / det
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  const x0 = Math.max(0, minX)
  const y0 = Math.max(0, minY)
  const x1 = Math.min(width, maxX)
  const y1 = Math.min(height, maxY)
  if (x1 <= x0 || y1 <= y0) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
