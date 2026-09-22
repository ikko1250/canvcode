import type { AssetRecord, NodeRecord } from '@canvcode/core'
import { defineNodeType } from './defineNodeType.ts'

// 画像（MAI-7 の `image`、MAI-26）。実体は Asset にあり、ノードは assetId で参照する。
// 倍率に応じて、縮小版（長辺 256px・1024px）と原本を切り替えて描く（MAI-14）。
export interface ImageProps {
  assetId: string
  w: number
  h: number
  // 切り抜き範囲（画像全体を 0〜1 とした割合）。null なら切り抜かない。
  // 旧データの取り込み用に持っておく。切り抜きの操作は初版では作らない
  crop: { x: number; y: number; w: number; h: number } | null
}

export type ImageNode = NodeRecord<ImageProps>

// 縮小版の長辺（画素）。画像を取り込むときに、この大きさでブラウザが作る
export const IMAGE_VARIANT_SIZES = [256, 1024] as const

// 画面上で longSidePx 画素の長辺が要るときに読む版の長辺。
// 足りる縮小版のうち最も小さいもの、なければ原本
export function pickImageVariant(asset: AssetRecord, longSidePx: number): number {
  const original = Math.max(asset.width, asset.height)
  for (const size of [...asset.variants].sort((a, b) => a - b)) {
    if (size < original && size >= longSidePx) return size
  }
  return original
}

// 長辺 size 画素に縮めたときの大きさ
export function scaledSize(width: number, height: number, size: number): { width: number; height: number } {
  const s = Math.min(1, size / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) }
}

const PLACEHOLDER_FILL = '#eef0f3'
const PLACEHOLDER_STROKE = '#d0d4da'

export const imageType = defineNodeType<ImageProps>({
  type: 'image',
  version: 1,

  defaultProps: () => ({ assetId: '', w: 100, h: 100, crop: null }),

  getBounds: (node) => ({ x: 0, y: 0, w: node.props.w, h: node.props.h }),

  hitTest(node, point, margin) {
    const { w, h } = node.props
    return point.x >= -margin && point.y >= -margin && point.x <= w + margin && point.y <= h + margin
  },

  render(ctx, node, info) {
    const { assetId, w, h, crop } = node.props
    const asset = info.assets?.get(assetId)
    let raster = null
    if (asset && info.assets && info.images) {
      // 切り抜いているときは、見えている部分が画面の大きさになるよう、画像全体をそれだけ大きく読む
      const cw = crop?.w || 1
      const ch = crop?.h || 1
      const needed = Math.max(w / cw, h / ch) * info.zoom * info.devicePixelRatio
      const size = pickImageVariant(asset, needed)
      const assets = info.assets
      raster = info.images.get(assetId, 'v1', size, () => assets.load(assetId, size))
    }
    if (!raster) {
      // 読み込み中（または Asset が見つからない）
      ctx.fillStyle = PLACEHOLDER_FILL
      ctx.fillRect(0, 0, w, h)
      ctx.lineWidth = 1 / info.zoom
      ctx.strokeStyle = PLACEHOLDER_STROKE
      ctx.strokeRect(0, 0, w, h)
      return
    }
    const sx = crop ? crop.x * raster.width : 0
    const sy = crop ? crop.y * raster.height : 0
    const sw = crop ? crop.w * raster.width : raster.width
    const sh = crop ? crop.h * raster.height : raster.height
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(raster.image, sx, sy, sw, sh, 0, 0, w, h)
  },

  roughColor: () => PLACEHOLDER_STROKE,

  resize: (node, size) => ({ ...node.props, w: size.w, h: size.h }),
  minSize: { w: 8, h: 8 },
  lockAspectRatio: true,
})
