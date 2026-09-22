import type { FileContentSource } from '@canvcode/nodes'
import { MARKDOWN_CARD_CSS, createMarkdownCardType } from '@canvcode/nodes/markdown'
import { KATEX_BASE_CSS, buildEmbeddedKatexCss } from './katexFonts.ts'

// Markdown カード（MAI-30）。数式フォントは、使うものだけを SVG に埋め込む（MAI-21）
export function createAppMarkdownCardType(files?: FileContentSource) {
  return createMarkdownCardType({
    files,
    embedCss: async (html) => (await buildEmbeddedKatexCss(html, 'auto')).css,
    measureCss: KATEX_BASE_CSS + MARKDOWN_CARD_CSS,
    // 既定は Canvas に描いて作る方法。?raster=bitmap で createImageBitmap で直接作る方法に切り替えられる。
    // MAI-22 の比較では、Chromium は createImageBitmap で作れず（毎回 Canvas に戻す分だけ遅くなる）、
    // Firefox では作れたがカクつきは減らなかった
    output: () => (new URLSearchParams(location.search).get('raster') === 'bitmap' ? 'bitmap' : 'canvas'),
  })
}
