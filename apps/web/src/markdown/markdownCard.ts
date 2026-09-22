import { createMarkdownCardType } from '@canvcode/nodes/markdown'
import { buildEmbeddedKatexCss } from './katexFonts.ts'

// 試作版の Markdown カード（MAI-22）。数式フォントは、使うものだけを SVG に埋め込む（MAI-21）
export const markdownCardType = createMarkdownCardType({
  embedCss: async (html) => (await buildEmbeddedKatexCss(html, 'auto')).css,
  // 既定は Canvas に描いて作る方法。?raster=bitmap で createImageBitmap で直接作る方法に切り替えられる。
  // MAI-22 の比較では、Chromium は createImageBitmap で作れず（毎回 Canvas に戻す分だけ遅くなる）、
  // Firefox では作れたがカクつきは減らなかった
  output: () => (new URLSearchParams(location.search).get('raster') === 'bitmap' ? 'bitmap' : 'canvas'),
})
