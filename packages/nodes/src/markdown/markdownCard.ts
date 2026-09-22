import type { NodeRecord } from '@canvcode/core'
import { defineNodeType, pickImageLevel, type FileContentSource, type RasterImage } from '../defineNodeType.ts'
import { MARKDOWN_CARD_CSS, buildMarkdownCardHtml } from './cardHtml.ts'
import { hitLink, measureCardHeight, measureLinks, type LinkRegion } from './layout.ts'
import { rasterizeHtml } from './rasterize.ts'
import { renderMarkdown } from './renderMarkdown.ts'

// Markdown カード（MAI-7 の `markdown-card`、MAI-9、MAI-30）。
// - 本文は File（ワークスペースの .md ファイル）にあり、カードは fileId で参照する。本文のコピーは持たない
// - 描き方は MAI-5・MAI-22 のとおり：表示倍率に合う解像度の画像を画像キャッシュに頼み、手元の画像を拡大・縮小して貼る
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

export function createMarkdownCardType(options: MarkdownCardOptions) {
  const imageOutput = options.output?.() ?? 'canvas'
  const canMeasure = typeof document !== 'undefined'

  const textOf = (props: MarkdownCardProps) => {
    if (props.inlineText !== undefined) return { text: props.inlineText, version: `inline:${hashString(props.inlineText)}` }
    return options.files?.get(props.fileId) ?? null
  }

  // 本文から作った HTML の本体（題名や切り方によらない部分）。本文の版ごとに一度だけ作る
  const bodyCache = new Map<string, string>()
  const bodyHtml = (text: string, version: string) => {
    let html = bodyCache.get(version)
    if (html === undefined) {
      html = renderMarkdown(text).html
      remember(bodyCache, version, html)
    }
    return html
  }

  // 中身に合わせた高さ（本文の版と幅ごとに一度だけ測る）
  const heightCache = new Map<string, number>()
  const measuredHeight = (props: MarkdownCardProps): number | null => {
    const content = textOf(props)
    if (!content || !canMeasure) return null
    const key = `${content.version}|${props.w}`
    let height = heightCache.get(key)
    if (height === undefined) {
      const html = buildMarkdownCardHtml('題名', bodyHtml(content.text, content.version))
      height = Math.max(MIN_HEIGHT, measureCardHeight({ html, css: options.measureCss, width: props.w }))
      remember(heightCache, key, height)
    }
    return height
  }

  const heightOf = (props: MarkdownCardProps) =>
    props.sizing === 'auto' ? (measuredHeight(props) ?? props.h) : props.h

  // リンクの位置（本文の版と大きさごとに一度だけ測る）
  const linkCache = new Map<string, LinkRegion[]>()

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
        drawPlaceholder(ctx, w, h, info.editing ? null : statusMessage(doc?.status))
        if (props.role === 'shortcut') drawShortcutFrame(ctx, w, h, info.zoom)
        return
      }
      const clipped = props.sizing === 'fixed' && (measuredHeight(props) ?? 0) > h
      const html = buildMarkdownCardHtml(doc.title, bodyHtml(content.text, content.version), {
        clipped,
        shortcut: props.role === 'shortcut',
      })
      const version = `${w}x${h}:${hashString(html)}`
      const level = pickImageLevel(info.zoom * info.devicePixelRatio)
      // キーはノードごと。中身や大きさが変わっても、作り直すまでは古い画像を引き伸ばして描く
      const image = info.images?.get(node.id, version, level, async (): Promise<RasterImage> => {
        const css = await options.embedCss(html)
        const result = await rasterizeHtml({ html, css: css + MARKDOWN_CARD_CSS, width: w, height: h, scale: level, output: imageOutput })
        // Canvas のままより ImageBitmap のほうが、描くときに速い（特に Chromium）
        const bitmap = result.canvas instanceof ImageBitmap ? result.canvas : await createImageBitmap(result.canvas)
        // 大きすぎて解像度を抑えた場合も、頼んだ段階として記録する（そうしないと、同じ段階を頼み続けてしまう）
        return { image: bitmap, width: bitmap.width, height: bitmap.height, level }
      })
      if (image) {
        // 解像度は段階で持ち、必要な倍率の 2 倍までしか縮めないので、既定の（軽い）補間で足りる
        ctx.drawImage(image.image, 0, 0, w, h)
      } else {
        drawPlaceholder(ctx, w, h, null)
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
      const key = `${content.version}|${props.w}x${h}`
      let regions = linkCache.get(key)
      if (!regions) {
        const html = buildMarkdownCardHtml('題名', bodyHtml(content.text, content.version))
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
function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.set(key, value)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
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
