import { defineNodeType, pickImageLevel, type RasterImage } from '../defineNodeType.ts'
import { MARKDOWN_CARD_CSS, buildMarkdownCardHtml } from './cardHtml.ts'
import { rasterizeHtml } from './rasterize.ts'
import { renderMarkdown } from './renderMarkdown.ts'

// Markdown カードの試作版（MAI-22）。
// 本実装（段階 10、MAI-9）では本文を File から読むが、ここでは props に直接持つ。
// 描き方は MAI-5 の方針のとおり：
// - 描画のたびに、表示倍率に合う解像度の画像を画像キャッシュに頼み、手元にある画像を拡大・縮小して貼る
// - 画像がまだひとつもないときは、仮の表示（枠・見出しの帯・灰色の行）を描く

export interface MarkdownCardProps {
  w: number
  h: number
  title: string
  markdown: string
}

export interface MarkdownCardOptions {
  // SVG に埋め込む数式フォントの CSS を作る（Vite の機能を使うので、アプリ側から渡す）
  embedCss(html: string): Promise<string>
  // 画像の作り方（MAI-22 で比べる）。既定は 'canvas'
  output?: () => 'canvas' | 'bitmap'
}

const PLACEHOLDER_LINE_HEIGHT = 26

export function createMarkdownCardType(options: MarkdownCardOptions) {
  const imageOutput = options.output?.() ?? 'canvas'
  // 同じ中身の HTML と版は、props ごとに一度だけ作る（レコードは書き換えないので props で引ける）。
  // 版は、画像の見た目を決める値（題名・本文・大きさ）が変わったときだけ変わる
  const htmlCache = new WeakMap<MarkdownCardProps, { html: string; version: string }>()
  const htmlFor = (props: MarkdownCardProps) => {
    let cached = htmlCache.get(props)
    if (!cached) {
      const html = buildMarkdownCardHtml(props.title, renderMarkdown(props.markdown).html)
      cached = { html, version: `${props.w}x${props.h}:${hashString(html)}` }
      htmlCache.set(props, cached)
    }
    return cached
  }

  return defineNodeType<MarkdownCardProps>({
    type: 'markdown-card',
    version: 1,

    defaultProps: () => ({ w: 560, h: 700, title: 'Markdown', markdown: '' }),

    getBounds: (node) => ({ x: 0, y: 0, w: node.props.w, h: node.props.h }),

    hitTest: (node, point, margin) =>
      point.x >= -margin && point.y >= -margin && point.x <= node.props.w + margin && point.y <= node.props.h + margin,

    render(ctx, node, info) {
      const { w, h } = node.props
      const level = pickImageLevel(info.zoom * info.devicePixelRatio)
      const { html, version } = htmlFor(node.props)
      // キーはノードごと。中身や大きさが変わっても、作り直すまでは古い画像を引き伸ばして描く
      const image = info.images?.get(node.id, version, level, async (): Promise<RasterImage> => {
        const css = await options.embedCss(html)
        const result = await rasterizeHtml({
          html,
          css: css + MARKDOWN_CARD_CSS,
          width: w,
          height: h,
          scale: level,
          output: imageOutput,
        })
        // Canvas のままより ImageBitmap のほうが、描くときに速い（特に Chromium）
        const bitmap = result.canvas instanceof ImageBitmap ? result.canvas : await createImageBitmap(result.canvas)
        // 大きすぎて解像度を抑えた場合も、頼んだ段階として記録する（そうしないと、同じ段階を頼み続けてしまう）
        return { image: bitmap, width: bitmap.width, height: bitmap.height, level }
      })
      if (image) {
        // 解像度は段階で持ち、必要な倍率の 2 倍までしか縮めないので、既定の（軽い）補間で足りる
        ctx.drawImage(image.image, 0, 0, w, h)
      } else {
        drawPlaceholder(ctx, w, h)
      }
    },

    roughColor: () => '#efe6cf',

    resize: (node, size) => ({ ...node.props, w: size.w, h: size.h }),
    minSize: { w: 160, h: 120 },
  })
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

function drawPlaceholder(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#fffdf7'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = 'rgba(245, 231, 197, 0.55)'
  ctx.fillRect(0, 0, w, 36)
  ctx.fillStyle = '#ece6d8'
  for (let y = 60; y < h - 30; y += PLACEHOLDER_LINE_HEIGHT) {
    const lineW = (w - 44) * (0.55 + 0.45 * Math.abs(Math.sin(y)))
    ctx.fillRect(22, y, lineW, 10)
  }
  ctx.strokeStyle = 'rgba(80, 66, 45, 0.28)'
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1)
}
