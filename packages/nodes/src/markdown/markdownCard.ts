import type { NodeRecord } from '@canvcode/core'
import { defineNodeType, pickImageLevel, type FileContentSource, type RasterImage } from '../defineNodeType.ts'
import { MARKDOWN_CARD_CSS, buildMarkdownCardHtml } from './cardHtml.ts'
import { hitLink, measureCardHeight, measureLinks, type LinkRegion } from './layout.ts'
import { measureLinksInImage } from './linkMap.ts'
import { drawHtmlTile, loadHtmlImage, rasterizeHtml, type HtmlImage } from './rasterize.ts'
import { renderMarkdown } from './renderMarkdown.ts'
import { fullImageLevel, tilesInRect, visibleLocalRect } from './tiles.ts'

// Markdown カード（MAI-7 の `markdown-card`、MAI-9、MAI-30）。
// - 本文は File（ワークスペースの .md ファイル）にあり、カードは fileId で参照する。本文のコピーは持たない
// - 描き方は MAI-5・MAI-22 のとおり：表示倍率に合う解像度の画像を画像キャッシュに頼み、手元の画像を拡大・縮小して貼る
//   長いカードで、全体の画像では解像度が足りないときは、見えている部分をタイルで重ねて描く（tiles.ts）
// - 高さは、既定では中身に合わせる（sizing: 'auto'）。'fixed' なら w・h のまま、収まらない分は下端をぼかして切る
// - File を参照するノードなので、Portal と同じく持ち主とショートカットがある（MAI-8）

export interface MarkdownCardProps {
  fileId: string
  w: number
  // sizing が 'fixed' のときの高さ。'auto' のときは、最後に測った高さ（本文を読み込むまでの仮の高さ）
  h: number
  sizing: 'auto' | 'fixed'
  role: 'owner' | 'shortcut'
  // File を使わずに本文を直接持つ（MAI-22 のベンチマーク用）
  inlineText?: string
}

export type MarkdownCardNode = NodeRecord<MarkdownCardProps>

export interface MarkdownCardOptions {
  // SVG に埋め込む数式フォントの CSS を作る（Vite の機能を使うので、アプリ側から渡す）
  embedCss(html: string): Promise<string>
  // 計測に使う CSS（フォントの @font-face は含めない。ページで読み込んだものを使う）
  measureCss: string
  // File の本文を引く先。高さを中身に合わせるときの計測にも使う
  files?: FileContentSource
  // 画像の作り方（MAI-22 で比べる）。既定は 'canvas'
  output?: () => 'canvas' | 'bitmap'
}

export const MARKDOWN_CARD_DEFAULT_WIDTH = 480
const MIN_HEIGHT = 80
const PLACEHOLDER_LINE_HEIGHT = 26
const HEADER_H = 36
// タイルを切り出す元の画像を、いくつのカードの分まで持つか
const HTML_IMAGE_LIMIT = 4
// 最後に描いた HTML を、いくつのカードの分まで持つか（リンクの位置を、描いた画像と同じ HTML で読むため）
const DRAWN_HTML_LIMIT = 16

export function createMarkdownCardType(options: MarkdownCardOptions) {
  const imageOutput = options.output?.() ?? 'canvas'
  const canMeasure = typeof document !== 'undefined'

  const textOf = (props: MarkdownCardProps) => {
    if (props.inlineText !== undefined) return { text: props.inlineText, version: `inline:${hashString(props.inlineText)}` }
    return options.files?.get(props.fileId) ?? null
  }

  // 本文から作った HTML の本体（題名や切り方によらない部分）。本文の版とファイルの場所ごとに一度だけ作る
  // （相対パスの画像はファイルの場所を基準に解決するので、名前を変えたり動かしたりしたら作り直す）
  const bodyCache = new Map<string, string>()
  const bodyHtml = (content: { text: string; version: string; path?: string }) => {
    const key = `${content.version}|${content.path ?? ''}`
    let html = bodyCache.get(key)
    if (html === undefined) {
      html = renderMarkdown(content.text, { documentPath: content.path }).html
      remember(bodyCache, key, html)
    }
    return html
  }

  // 中身に合わせた高さ（本文の版と幅ごとに一度だけ測る）
  const heightCache = new Map<string, number>()
  const measuredHeight = (props: MarkdownCardProps): number | null => {
    const content = textOf(props)
    if (!content || !canMeasure) return null
    const key = `${content.version}|${content.path ?? ''}|${props.w}`
    let height = heightCache.get(key)
    if (height === undefined) {
      const html = buildMarkdownCardHtml('題名', bodyHtml(content))
      height = Math.max(MIN_HEIGHT, measureCardHeight({ html, css: options.measureCss, width: props.w }))
      remember(heightCache, key, height)
    }
    return height
  }

  const heightOf = (props: MarkdownCardProps) =>
    props.sizing === 'auto' ? (measuredHeight(props) ?? props.h) : props.h

  // タイルを切り出す元の、HTML の SVG の画像（ノードごとに、いまの版の 1 枚だけ）。多すぎないよう、使っていないものから捨てる
  const htmlImages = new Map<string, { version: string; image: Promise<HtmlImage> }>()
  const htmlImageOf = (nodeId: string, version: string, html: string, w: number, h: number): Promise<HtmlImage> => {
    let entry = htmlImages.get(nodeId)
    if (entry?.version !== version) {
      const image = (async () => loadHtmlImage({ html, css: (await options.embedCss(html)) + MARKDOWN_CARD_CSS, width: w, height: h }))()
      const created = { version, image }
      // 読めなかったら、次に頼まれたときに作り直す
      image.catch(() => {
        if (htmlImages.get(nodeId) === created) htmlImages.delete(nodeId)
      })
      entry = created
    }
    htmlImages.delete(nodeId)
    htmlImages.set(nodeId, entry)
    while (htmlImages.size > HTML_IMAGE_LIMIT) htmlImages.delete(htmlImages.keys().next().value!)
    return entry.image
  }

  // リンクの位置（本文の版と大きさごとに一度だけ測る）
  const linkCache = new Map<string, LinkRegion[]>()

  // ノードごとに、最後に描いた画像の HTML と版
  const drawnHtml = new Map<string, { version: string; html: string; w: number; h: number }>()
  // 描いた画像と同じ HTML の SVG から読んだリンクの位置（linkMap.ts）。版ごとに一度だけ読む。
  // 読めなかったら null（DOM で測った位置を使う）。読んでいる間は入れない
  const imageLinkCache = new Map<string, LinkRegion[] | null>()
  const imageLinkPending = new Set<string>()
  const imageLinksOf = (drawn: { version: string; html: string; w: number; h: number }): LinkRegion[] | null | undefined => {
    if (imageLinkCache.has(drawn.version)) return imageLinkCache.get(drawn.version)
    if (!imageLinkPending.has(drawn.version)) {
      imageLinkPending.add(drawn.version)
      void (async () => {
        const css = (await options.embedCss(drawn.html)) + MARKDOWN_CARD_CSS
        return measureLinksInImage({ html: drawn.html, css, width: drawn.w, height: drawn.h })
      })()
        .catch(() => null)
        .then((regions) => {
          imageLinkPending.delete(drawn.version)
          remember(imageLinkCache, drawn.version, regions, IMAGE_LINK_LIMIT)
        })
    }
    return undefined
  }

  return defineNodeType<MarkdownCardProps>({
    type: 'markdown-card',
    version: 1,

    defaultProps: () => ({ fileId: '', w: MARKDOWN_CARD_DEFAULT_WIDTH, h: 320, sizing: 'auto', role: 'owner' }),

    getBounds: (node) => ({ x: 0, y: 0, w: node.props.w, h: heightOf(node.props) }),

    hitTest: (node, point, margin) =>
      point.x >= -margin && point.y >= -margin && point.x <= node.props.w + margin && point.y <= heightOf(node.props) + margin,

    render(ctx, node, info) {
      const props = node.props
      const w = props.w
      const h = heightOf(props)
      const doc = props.inlineText !== undefined ? { title: 'Markdown', status: 'ok' as const } : info.documents?.get(props.fileId)
      const content = textOf(props)
      if (!doc || doc.status !== 'ok' || !content || info.editing) {
        drawnHtml.delete(node.id)
        drawPlaceholder(ctx, w, h, info.editing ? null : statusMessage(doc?.status))
        if (props.role === 'shortcut') drawShortcutFrame(ctx, w, h, info.zoom)
        return
      }
      const clipped = props.sizing === 'fixed' && (measuredHeight(props) ?? 0) > h
      const html = buildMarkdownCardHtml(doc.title, bodyHtml(content), {
        clipped,
        shortcut: props.role === 'shortcut',
      })
      const version = `${w}x${h}:${hashString(html)}`
      if (drawnHtml.get(node.id)?.version !== version) remember(drawnHtml, node.id, { version, html, w, h }, DRAWN_HTML_LIMIT)
      const level = pickImageLevel(info.zoom * info.devicePixelRatio)
      // 全体の画像は、1 枚で作っても解像度が抑えられない段階までにする。それより高い解像度は、タイルで重ねる
      const fullLevel = Math.min(level, fullImageLevel(w, h))
      // キーはノードごと。中身や大きさが変わっても、作り直すまでは古い画像を引き伸ばして描く
      const image = info.images?.get(node.id, version, fullLevel, async (): Promise<RasterImage> => {
        const css = await options.embedCss(html)
        const result = await rasterizeHtml({ html, css: css + MARKDOWN_CARD_CSS, width: w, height: h, scale: fullLevel, output: imageOutput })
        // Canvas のままより ImageBitmap のほうが、描くときに速い（特に Chromium）
        const bitmap = result.canvas instanceof ImageBitmap ? result.canvas : await createImageBitmap(result.canvas)
        // 大きすぎて解像度を抑えた場合も、頼んだ段階として記録する（そうしないと、同じ段階を頼み続けてしまう）
        return { image: bitmap, width: bitmap.width, height: bitmap.height, level: fullLevel }
      })
      if (image) {
        // 解像度は段階で持ち、必要な倍率の 2 倍までしか縮めないので、既定の（軽い）補間で足りる
        ctx.drawImage(image.image, 0, 0, w, h)
      } else {
        drawPlaceholder(ctx, w, h, null)
      }
      // 全体の画像では解像度が足りないなら、見えているタイルを重ねる。できていないタイルは、下の全体の画像が見える
      const visible = level > fullLevel && info.images ? visibleLocalRect(ctx, w, h) : null
      if (visible && info.images) {
        for (const tile of tilesInRect(w, h, visible)) {
          const tileImage = info.images.get(`${node.id}#tile:${tile.col},${tile.row}`, version, level, async (): Promise<RasterImage> => {
            const source = await htmlImageOf(node.id, version, html, w, h)
            const bitmap = await createImageBitmap(drawHtmlTile(source, tile, level))
            return { image: bitmap, width: bitmap.width, height: bitmap.height, level }
          })
          if (tileImage) ctx.drawImage(tileImage.image, tile.x, tile.y, tile.w, tile.h)
        }
      }
      if (props.role === 'shortcut') drawShortcutFrame(ctx, w, h, info.zoom)
    },

    roughColor: () => '#efe6cf',

    // 高さを中身に合わせているカードの高さを、手で変えたら、大きさを固定する
    resize(node, size) {
      const props = node.props
      const current = heightOf(props)
      if (props.sizing === 'auto' && Math.abs(size.h - current) < 1) return { ...props, w: size.w }
      return { ...props, w: size.w, h: size.h, sizing: 'fixed' }
    },
    minSize: { w: 200, h: MIN_HEIGHT },

    reference: (node) => (node.props.fileId ? { targetId: node.props.fileId, role: node.props.role } : null),
    withRole: (node, role) => ({ ...node.props, role }),

    linkAt(node, point) {
      const props = node.props
      const content = textOf(props)
      if (!content || !canMeasure) return null
      const h = heightOf(props)
      // 描いた画像から読んだ位置があれば、それを使う。読み終えるまでと、読めなかったときは、DOM で測った位置
      const drawn = drawnHtml.get(node.id)
      const fromImage = drawn && drawn.w === props.w && drawn.h === h ? imageLinksOf(drawn) : undefined
      if (fromImage) return hitLink(fromImage, point.x, point.y)?.href ?? null
      const key = `${content.version}|${content.path ?? ''}|${props.w}x${h}`
      let regions = linkCache.get(key)
      if (!regions) {
        const html = buildMarkdownCardHtml('題名', bodyHtml(content))
        regions = measureLinks({ html, css: options.measureCss, width: props.w, height: h })
        remember(linkCache, key, regions)
      }
      return hitLink(regions, point.x, point.y)?.href ?? null
    },
  })
}

// 参照先の状態の表示。読み込み中は、文字を出さずに灰色の行を描く
function statusMessage(status: string | undefined): string | null {
  if (status === 'missing') return 'File が削除されています（リンク切れ）'
  if (status === 'trashed') return 'ゴミ箱の中'
  if (status === 'nofile') return 'ファイルが見つかりません'
  return null
}

// キャッシュが大きくなりすぎないよう、古いものから捨てる
const CACHE_LIMIT = 2000
// 画像から読んだリンクの位置を、いくつの版の分まで持つか
const IMAGE_LINK_LIMIT = 64
function remember<V>(cache: Map<string, V>, key: string, value: V, limit = CACHE_LIMIT): void {
  cache.delete(key)
  cache.set(key, value)
  if (cache.size > limit) cache.delete(cache.keys().next().value!)
}

// 文字列の簡単なハッシュ（FNV-1a）。版の比較に使うだけなので、衝突しにくければよい
function hashString(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36) + value.length.toString(36)
}

function drawPlaceholder(ctx: CanvasRenderingContext2D, w: number, h: number, message: string | null): void {
  ctx.fillStyle = '#fffdf7'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = 'rgba(245, 231, 197, 0.55)'
  ctx.fillRect(0, 0, w, HEADER_H)
  if (message) {
    ctx.fillStyle = '#8c959f'
    ctx.font = `14px 'Noto Sans JP', sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(message, w / 2, HEADER_H + (h - HEADER_H) / 2)
    ctx.textAlign = 'left'
  } else {
    ctx.fillStyle = '#ece6d8'
    for (let y = 60; y < h - 30; y += PLACEHOLDER_LINE_HEIGHT) {
      const lineW = (w - 44) * (0.55 + 0.45 * Math.abs(Math.sin(y)))
      ctx.fillRect(22, y, lineW, 10)
    }
  }
  ctx.strokeStyle = 'rgba(80, 66, 45, 0.28)'
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1)
}

// ショートカットは、Portal と同じく点線の枠で見分ける
function drawShortcutFrame(ctx: CanvasRenderingContext2D, w: number, h: number, zoom: number): void {
  ctx.save()
  ctx.strokeStyle = '#b4a6d9'
  ctx.lineWidth = 1.5 / zoom
  ctx.setLineDash([6 / zoom, 4 / zoom])
  ctx.strokeRect(0, 0, w, h)
  ctx.restore()
}
