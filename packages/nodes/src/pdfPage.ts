import type { NodeRecord } from '@canvcode/core'
import { defineNodeType, pickImageLevel } from './defineNodeType.ts'
import { TEXT_FONT_FAMILY } from './text/layout.ts'

// PDF の 1 ページ（MAI-7 の `pdf-page`、MAI-5、MAI-32）。
// - 原本の PDF は Asset。ページは、表示の倍率に合う解像度で PDF.js が描いた画像を、画像キャッシュに頼んで貼る
// - 書き込みは、同じ Canvas に置いた別のノード（フリーハンドや付箋など）で行う。PDF の原本には書き込まない
// - ページはふつう固定（locked）して置く。書き込みや範囲選択で、ページを動かしてしまわないように
export interface PdfPageProps {
  assetId: string
  // PDF の File
  fileId: string
  // 0 から
  pageIndex: number
  // ページの大きさ（ワールド座標）。PDF の 1 ポイント = 96/72 単位
  w: number
  h: number
}

export type PdfPageNode = NodeRecord<PdfPageProps>

// 取り込むときの、ページの大きさの倍率（PDF のポイント → ワールド座標）
export const PDF_POINT_SCALE = 96 / 72

const PAGE_BORDER = 'rgba(31, 35, 40, 0.2)'
const PLACEHOLDER_LINE = '#eef0f3'

export const pdfPageType = defineNodeType<PdfPageProps>({
  type: 'pdf-page',
  version: 1,

  defaultProps: () => ({ assetId: '', fileId: '', pageIndex: 0, w: 816, h: 1056 }),

  getBounds: (node) => ({ x: 0, y: 0, w: node.props.w, h: node.props.h }),

  hitTest(node, point, margin) {
    const { w, h } = node.props
    return point.x >= -margin && point.y >= -margin && point.x <= w + margin && point.y <= h + margin
  },

  render(ctx, node, info) {
    const { assetId, pageIndex, w, h } = node.props
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    const assets = info.assets
    let raster = null
    if (assets?.renderPdfPage && info.images) {
      // 1 単位あたりの画素数（倍率 × devicePixelRatio）の段階で描く
      const level = pickImageLevel(info.zoom * info.devicePixelRatio)
      raster = info.images.get(`${assetId}#${pageIndex}`, 'v1', level, () => assets.renderPdfPage!(assetId, pageIndex, level))
    }
    if (raster) {
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(raster.image, 0, 0, w, h)
    } else {
      // 読み込み中：灰色の行と、ページ番号
      ctx.fillStyle = PLACEHOLDER_LINE
      for (let y = h * 0.1; y < h * 0.9; y += h * 0.035) ctx.fillRect(w * 0.1, y, w * 0.8 * (0.6 + 0.4 * Math.abs(Math.sin(y))), h * 0.012)
      ctx.fillStyle = '#8c959f'
      ctx.font = `${Math.max(12, w * 0.03)}px ${TEXT_FONT_FAMILY}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(`${pageIndex + 1}`, w / 2, h * 0.95)
      ctx.textAlign = 'left'
    }
    ctx.lineWidth = 1 / info.zoom
    ctx.strokeStyle = PAGE_BORDER
    ctx.strokeRect(0, 0, w, h)
  },

  roughColor: () => '#ffffff',

  resize: (node, size) => ({ ...node.props, w: size.w, h: size.h }),
  minSize: { w: 40, h: 40 },
  lockAspectRatio: true,
})
