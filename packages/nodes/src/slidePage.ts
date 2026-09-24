import type { NodeRecord } from '@canvcode/core'
import { defineNodeType, type RasterImage } from './defineNodeType.ts'
import { TEXT_FONT_FAMILY } from './text/layout.ts'

// スライドデッキの 1 枚（PDF の `pdf-page` と同じ扱い）。
// - サーバーが Chromium で撮った PNG（中身のハッシュが名前）を貼る。デッキを保存するたびに、変わったスライドだけ撮り直す
// - デッキのカードの横に並べ、固定（locked）して置く。書き込みは、上に置いた別のノード（付箋やフリーハンドなど）で行う
// - slideKey はスライドの id（デッキの name）。並べ替えや追加・削除のあとも、同じスライドの位置へ上の書き込みごと動かす
export interface SlidePageProps {
  // スライドデッキの File
  fileId: string
  slideKey: string
  // 貼っている PNG のハッシュ。まだなければ ''
  hash: string
  // 0 から（表示用）
  slideIndex: number
  // デッキから消えたスライド。消さずに、並びの下に移して薄く見せる
  removed: boolean
  w: number
  h: number
}

export type SlidePageNode = NodeRecord<SlidePageProps>

// キャンバスでの大きさ（16:9）
export const SLIDE_PAGE_SIZE = { w: 640, h: 360 }

export interface SlidePageImages {
  // ハッシュの PNG を読む
  load(hash: string): Promise<RasterImage>
}

const PAGE_BORDER = 'rgba(31, 35, 40, 0.2)'
const PLACEHOLDER_FILL = '#f3f1eb'

export function createSlidePageType(images: SlidePageImages) {
  return defineNodeType<SlidePageProps>({
    type: 'slide-page',
    version: 1,

    defaultProps: () => ({ fileId: '', slideKey: '', hash: '', slideIndex: 0, removed: false, ...SLIDE_PAGE_SIZE }),

    getBounds: (node) => ({ x: 0, y: 0, w: node.props.w, h: node.props.h }),

    hitTest(node, point, margin) {
      const { w, h } = node.props
      return point.x >= -margin && point.y >= -margin && point.x <= w + margin && point.y <= h + margin
    },

    render(ctx, node, info) {
      const { hash, slideIndex, removed, w, h } = node.props
      // ノードごとに頼む：撮り直した画像ができるまでは、前の画像を見せ続ける
      const raster = hash && info.images ? info.images.get(`slide-page:${node.id}`, hash, 1, () => images.load(hash)) : null
      if (raster) {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, w, h)
        ctx.imageSmoothingEnabled = true
        ctx.drawImage(raster.image, 0, 0, w, h)
      } else {
        ctx.fillStyle = PLACEHOLDER_FILL
        ctx.fillRect(0, 0, w, h)
        ctx.fillStyle = '#8c959f'
        ctx.font = `${Math.max(12, w * 0.03)}px ${TEXT_FONT_FAMILY}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(`スライド ${slideIndex + 1}（画像を準備中）`, w / 2, h / 2, w * 0.9)
        ctx.textAlign = 'start'
      }
      if (removed) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)'
        ctx.fillRect(0, 0, w, h)
        ctx.fillStyle = '#9a3412'
        ctx.font = `bold ${Math.max(12, w * 0.035)}px ${TEXT_FONT_FAMILY}`
        ctx.textBaseline = 'top'
        ctx.fillText('デッキから削除されたスライド', w * 0.03, h * 0.04, w * 0.94)
      }
      ctx.lineWidth = 1 / info.zoom
      ctx.strokeStyle = PAGE_BORDER
      ctx.strokeRect(0, 0, w, h)
    },

    roughColor: () => PLACEHOLDER_FILL,
    canRotate: false,
  })
}
