import type { NodeRecord } from '@canvcode/core'
import { defineNodeType, type RenderInfo } from './defineNodeType.ts'
import { IMAGE_PLACEHOLDER_FILL, requestAssetImage } from './image.ts'
import { TEXT_FONT_FAMILY } from './text/fonts.ts'
import { TEXT_BAR_THRESHOLD_PX, drawTextBars, drawTextLayout, layoutText, type TextLayout, type TextStyle } from './text/layout.ts'

// リンクのカード。Canvas に URL だけを貼り付けると、テキストノードの代わりにこれを置く。
// - カードのどこでも Ctrl（⌘）+クリックで URL を開ける（linkAt）
// - タイトル・説明・サムネイルは、サーバーがリンク先のページ（OGP）から取ってきたものを、あとから書き込む。
//   取れなかったときは URL だけのカードのまま
// - 高さは中身に合わせて決まる（幅だけを変えられる）
export interface LinkCardProps {
  url: string
  title: string | null
  description: string | null
  siteName: string | null
  // サムネイル（og:image）。aspect は高さ / 幅
  image: { assetId: string; aspect: number } | null
  // 'loading' はページの情報を取ってきているところ。'failed' は取れなかった（URL だけで描く）
  status: 'loading' | 'done' | 'failed'
  w: number
}

export type LinkCardNode = NodeRecord<LinkCardProps>

export const LINK_CARD_DEFAULT_WIDTH = 400

// 寸法（ワールド座標）
const PADDING = 14
const GAP = 4
const MAX_TITLE_LINES = 2
const MAX_DESCRIPTION_LINES = 2
// サムネイルは右に、カードの高さいっぱいに置く。幅はカードの幅に対する割合
const THUMB_RATIO = 0.3
const MIN_THUMB_H = 84
const SITE_FONT = 12

const TITLE_STYLE: TextStyle = { fontSize: 15, lineHeight: 1.4, fontWeight: 600, color: '#1f2328', align: 'left' }
const DESCRIPTION_STYLE: TextStyle = { fontSize: 13, lineHeight: 1.45, fontWeight: 400, color: '#57606a', align: 'left' }
const BORDER = 'rgba(31, 35, 40, 0.16)'

interface Box {
  x: number
  y: number
  w: number
  h: number
}

interface LinkCardLayout {
  title: TextLayout
  titleBox: Box
  description: TextLayout | null
  descriptionBox: Box
  siteY: number
  textW: number
  thumbBox: Box | null
  h: number
}

const layoutCache = new WeakMap<LinkCardProps, LinkCardLayout>()

// 表に出す名前。タイトルがなければ、URL から https:// を取ったもの
export function linkCardTitle(props: Pick<LinkCardProps, 'url' | 'title'>): string {
  return props.title?.trim() || props.url.replace(/^https?:\/\//, '')
}

// 下に出すサイトの名前。なければドメイン
export function linkCardSite(props: Pick<LinkCardProps, 'url' | 'siteName'>): string {
  if (props.siteName?.trim()) return props.siteName.trim()
  try {
    return new URL(props.url).hostname
  } catch {
    return props.url
  }
}

// max 行に収まるように組む。収まらなければ、末尾に … を付けて max 行に収まる長さまで縮める
// （描くのは行の segments なので、行の text を書き換えるのでなく、縮めた文字列を組み直す）
function layoutClamped(text: string, style: TextStyle, width: number, max: number): TextLayout {
  const full = layoutText(text, style, width)
  if (full.lines.length <= max) return full
  const chars = [...text]
  let lo = 0
  let hi = chars.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (layoutText(chars.slice(0, mid).join('').trimEnd() + '…', style, width).lines.length <= max) lo = mid
    else hi = mid - 1
  }
  return layoutText(chars.slice(0, lo).join('').trimEnd() + '…', style, width)
}

function linkCardLayout(props: LinkCardProps): LinkCardLayout {
  let layout = layoutCache.get(props)
  if (layout) return layout
  const thumbW = props.image ? Math.round(props.w * THUMB_RATIO) : 0
  const textW = Math.max(1, props.w - thumbW - PADDING * 2)
  const title = layoutClamped(linkCardTitle(props), TITLE_STYLE, textW, MAX_TITLE_LINES)
  const titleBox = { x: PADDING, y: PADDING, w: textW, h: title.height }
  let y = titleBox.y + title.height + GAP
  const text = props.description?.trim()
  const description = text ? layoutClamped(text, DESCRIPTION_STYLE, textW, MAX_DESCRIPTION_LINES) : null
  const descriptionBox = { x: PADDING, y, w: textW, h: description?.height ?? 0 }
  if (description) y += description.height + GAP
  const siteY = y + 2
  let h = siteY + SITE_FONT * 1.4 + PADDING
  if (props.image) h = Math.max(h, MIN_THUMB_H)
  const thumbBox = props.image ? { x: props.w - thumbW, y: 0, w: thumbW, h } : null
  layout = { title, titleBox, description, descriptionBox, siteY, textW, thumbBox, h }
  layoutCache.set(props, layout)
  return layout
}

export const linkCardType = defineNodeType<LinkCardProps>({
  type: 'link-card',
  version: 1,

  defaultProps: () => ({ url: '', title: null, description: null, siteName: null, image: null, status: 'done', w: LINK_CARD_DEFAULT_WIDTH }),

  getBounds: (node) => ({ x: 0, y: 0, w: node.props.w, h: linkCardLayout(node.props).h }),

  hitTest(node, point, margin) {
    const h = linkCardLayout(node.props).h
    return point.x >= -margin && point.y >= -margin && point.x <= node.props.w + margin && point.y <= h + margin
  },

  render(ctx, node, info) {
    const props = node.props
    const layout = linkCardLayout(props)
    const { w } = props
    const { h } = layout
    ctx.fillStyle = 'rgba(40, 40, 40, 0.08)'
    ctx.fillRect(2, 3, w, h)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    if (layout.thumbBox && props.image) drawThumbnail(ctx, props.image, layout.thumbBox, info)
    ctx.lineWidth = 1 / info.zoom
    ctx.strokeStyle = BORDER
    ctx.strokeRect(0, 0, w, h)

    const bars = DESCRIPTION_STYLE.fontSize * info.zoom < TEXT_BAR_THRESHOLD_PX
    if (bars) {
      drawTextBars(ctx, layout.title, TITLE_STYLE, layout.titleBox, 'top')
      if (layout.description) drawTextBars(ctx, layout.description, DESCRIPTION_STYLE, layout.descriptionBox, 'top')
      return
    }
    drawTextLayout(ctx, layout.title, TITLE_STYLE, layout.titleBox, 'top')
    if (layout.description) drawTextLayout(ctx, layout.description, DESCRIPTION_STYLE, layout.descriptionBox, 'top')
    ctx.font = `400 ${SITE_FONT}px ${TEXT_FONT_FAMILY}`
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    ctx.fillStyle = '#8c959f'
    const site = props.status === 'loading' ? `${linkCardSite(props)} ・ 読み込み中…` : linkCardSite(props)
    ctx.fillText(fit(ctx, site, layout.textW), PADDING, layout.siteY)
  },

  roughColor: () => '#ffffff',

  // 幅だけを変える（高さは中身に合わせる）
  resize: (node, size) => ({ ...node.props, w: size.w }),
  minSize: { w: 160, h: 40 },

  assets: (node) => (node.props.image ? [node.props.image.assetId] : []),

  // カードのどこでも、Ctrl（⌘）+クリックで開く
  linkAt: (node) => node.props.url || null,
})

// サムネイルを、箱いっぱいに（はみ出す分は切り取って）描く
function drawThumbnail(ctx: CanvasRenderingContext2D, image: NonNullable<LinkCardProps['image']>, box: Box, info: RenderInfo): void {
  const asset = info.assets?.get(image.assetId)
  const longSide = Math.max(box.w, box.h, box.w * image.aspect, box.h / image.aspect)
  const raster = asset ? requestAssetImage(info, asset, longSide * info.zoom * info.devicePixelRatio) : null
  if (!raster) {
    ctx.fillStyle = IMAGE_PLACEHOLDER_FILL
    ctx.fillRect(box.x, box.y, box.w, box.h)
    return
  }
  const scale = Math.max(box.w / raster.width, box.h / raster.height)
  const sw = box.w / scale
  const sh = box.h / scale
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(raster.image, (raster.width - sw) / 2, (raster.height - sh) / 2, sw, sh, box.x, box.y, box.w, box.h)
}

function fit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (ctx.measureText(text).width <= maxWidth) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + '…'
}
