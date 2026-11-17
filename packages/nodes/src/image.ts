import { SVG_MIME, type AssetRecord, type NodeRecord } from '@canvcode/core'
import { defineNodeType, type RasterImage, type RenderInfo } from './defineNodeType.ts'
import type { PlotSpec } from './plot.ts'

// 画像（MAI-7 の `image`、MAI-26）。実体は Asset にあり、ノードは assetId で参照する。
// 倍率に応じて、縮小版（長辺 256px・1024px）と原本を切り替えて描く（MAI-14）。
// SVG（MAI-116）は縮小版を作らず、要る大きさ（長辺を 2 倍ずつの段階に丸めたもの）で描き直す（pickSvgSize）。
export interface ImageProps {
  assetId: string
  w: number
  h: number
  // 切り抜き範囲（画像全体を 0〜1 とした割合）。null なら切り抜かない。この範囲を w×h に描く。
  // キャンバスの切り抜きモード（packages/canvas の cropHandles.ts）・MCP の edit_canvas で変える
  crop: { x: number; y: number; w: number; h: number } | null
  // CSV から描いたグラフなら、その作り方（plot.ts）。描き直す・作り方を変えるときに使う
  plot?: PlotSpec
}

export type ImageNode = NodeRecord<ImageProps>

// 縮小版の長辺（画素）。画像を取り込むときに、この大きさでブラウザが作る
export const IMAGE_VARIANT_SIZES = [256, 1024] as const

// SVG を描く長辺の段階（画素）。SVG_MIN_SIDE から 2 倍ずつ、SVG_MAX_SIDE まで。段階をまたいだときだけ描き直す。
// 上限は、1 枚が 4096×4096（64 MB）を超えないように（それより大きく見せるときは、引き伸ばして描く）
export const SVG_MIN_SIDE = 32
export const SVG_MAX_SIDE = 4096

export function isSvgAsset(asset: Pick<AssetRecord, 'mime'>): boolean {
  return asset.mime === SVG_MIME
}

// 画面上で longSidePx 画素の長辺が要るときに描く SVG の長辺
export function pickSvgSize(longSidePx: number): number {
  let size = SVG_MIN_SIDE
  while (size < longSidePx && size < SVG_MAX_SIDE) size *= 2
  return size
}

// 画面上で longSidePx 画素の長辺が要るときに読む版の長辺。
// 足りる縮小版のうち最も小さいもの、なければ原本。SVG は、描く大きさ（pickSvgSize）
export function pickImageVariant(asset: AssetRecord, longSidePx: number): number {
  if (isSvgAsset(asset)) return pickSvgSize(longSidePx)
  const original = Math.max(asset.width, asset.height)
  for (const size of [...asset.variants].sort((a, b) => a - b)) {
    if (size < original && size >= longSidePx) return size
  }
  return original
}

// 長辺 size 画素に縮めたときの大きさ。enlarge なら、size より小さい画像は大きくする（SVG を描き直すとき）
export function scaledSize(width: number, height: number, size: number, enlarge = false): { width: number; height: number } {
  const s = enlarge ? size / Math.max(width, height) : Math.min(1, size / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) }
}

// 読み込み中の画像の色（画像の塗り（MAI-83）のプレースホルダーにも使う）
export const IMAGE_PLACEHOLDER_FILL = '#eef0f3'
const PLACEHOLDER_FILL = IMAGE_PLACEHOLDER_FILL
const PLACEHOLDER_STROKE = '#d0d4da'

// Asset の画像を、画面上で長辺 longSidePx 画素に要る縮小版で、画像キャッシュに頼む（画像ノードと画像の塗り（MAI-83）が同じ項目を使う）。
// 手元になければ null（できたら描き直される）
export function requestAssetImage(info: Pick<RenderInfo, 'images' | 'assets'>, asset: AssetRecord, longSidePx: number): RasterImage | null {
  const { images, assets } = info
  if (!images || !assets) return null
  const size = pickImageVariant(asset, longSidePx)
  return images.get(asset.id, 'v1', size, () => assets.load(asset.id, size))
}

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
    if (asset) {
      // 切り抜いているときは、見えている部分が画面の大きさになるよう、画像全体をそれだけ大きく読む
      const cw = crop?.w || 1
      const ch = crop?.h || 1
      raster = requestAssetImage(info, asset, Math.max(w / cw, h / ch) * info.zoom * info.devicePixelRatio)
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

  assets: (node) => (node.props.assetId ? [node.props.assetId] : []),

  resize: (node, size) => ({ ...node.props, w: size.w, h: size.h }),
  minSize: { w: 8, h: 8 },
  lockAspectRatio: true,
})
