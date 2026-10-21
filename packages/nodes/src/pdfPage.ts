import type { NodeRecord } from '@canvcode/core'
import { defineNodeType, pickImageLevel, type AssetResolver, type ImageRequester, type RasterImage } from './defineNodeType.ts'
import { TEXT_FONT_FAMILY } from './text/fonts.ts'

// PDF の 1 ページ（MAI-7 の `pdf-page`、MAI-5、MAI-32）。
// - 原本の PDF は Asset。ページは、表示の倍率に合う解像度の画像を、画像キャッシュに頼んで貼る
// - サーバーが前もって作った画像（長辺 256px・1024px。Issue #26）で足りる倍率なら、それを貼る（PDF を読まない）。
//   足りなければ PDF.js で描き、描けるまではいちばん大きい前もって作った画像を引き伸ばして見せる
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

// 前もって作った画像を、要る解像度のこの割合までなら引き伸ばして使う
export const PREVIEW_STRETCH = 0.8

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
    const raster = info.assets && info.images ? requestPdfPageImage(info.assets, info.images, assetId, pageIndex, info.zoom * info.devicePixelRatio) : null
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
    // 引用した範囲（逆リンク。MAI-33）。クリックすると、引用しているノートの一覧が出る
    for (const region of info.citations?.regionsOnPage(node.props.fileId, pageIndex) ?? []) {
      const { x, y, w: rw, h: rh } = region.rect
      ctx.fillStyle = region.emphasized ? 'rgba(212, 167, 44, 0.32)' : 'rgba(212, 167, 44, 0.14)'
      ctx.fillRect(x * w, y * h, rw * w, rh * h)
      ctx.lineWidth = (region.emphasized ? 3 : 1.5) / info.zoom
      ctx.strokeStyle = region.emphasized ? '#b7861b' : 'rgba(183, 134, 27, 0.7)'
      ctx.strokeRect(x * w, y * h, rw * w, rh * h)
    }
    // 単語検索で一致したところ（試作）
    for (const hit of info.search?.rectsOnPage(node.props.fileId, pageIndex) ?? []) {
      ctx.fillStyle = hit.current ? 'rgba(255, 140, 0, 0.45)' : 'rgba(255, 230, 0, 0.4)'
      ctx.fillRect(hit.rect.x * w, hit.rect.y * h, hit.rect.w * w, hit.rect.h * h)
      if (hit.current) {
        ctx.lineWidth = 2 / info.zoom
        ctx.strokeStyle = '#d9480f'
        ctx.strokeRect(hit.rect.x * w, hit.rect.y * h, hit.rect.w * w, hit.rect.h * h)
      }
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

// ページの画像を画像キャッシュに頼む。need は 1 単位あたりに要る画素数（倍率 × devicePixelRatio）。
// 頼んだ解像度ができるまでは、手元にあるいちばん近い解像度の画像が返る
export function requestPdfPageImage(assets: AssetResolver, images: ImageRequester, assetId: string, pageIndex: number, need: number): RasterImage | null {
  if (!assets.renderPdfPage) return null
  const key = `${assetId}#${pageIndex}`
  const previews = assets.pdfPreviewLevels ? assets.pdfPreviewLevels(assetId, pageIndex) : []
  // 前もって作った画像があるかを確かめているところ。PDF.js で描き始めないよう、手元にあるものだけを見せる
  if (previews === null) return images.peek?.(key, 'v1', pickImageLevel(need)) ?? null
  const enough = previews.find((level) => level >= need * PREVIEW_STRETCH)
  if (enough !== undefined) return images.get(key, 'v1', enough, () => assets.loadPdfPreview!(assetId, pageIndex, enough))
  // PDF.js で描くまでの仮の表示に、いちばん大きい前もって作った画像を先に頼んでおく（画像キャッシュは頼んだ順に作る）。
  // それよりくっきりした画像が手元にあれば頼まない（画像キャッシュがいっぱいだと、仮の画像は入れたそばから捨てられ、
  // 頼むたびに作り直して描き直すことになる）
  const level = pickImageLevel(need)
  const largest = previews.at(-1)
  const have = images.peek?.(key, 'v1', level)
  if (largest !== undefined && !(have && have.level >= largest)) images.get(key, 'v1', largest, () => assets.loadPdfPreview!(assetId, pageIndex, largest))
  return images.get(key, 'v1', level, () => assets.renderPdfPage!(assetId, pageIndex, level))
}
