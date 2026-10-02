import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Root } from './Root.tsx'
import './styles.css'
// テキスト・付箋・図形で選べる同梱の日本語フォント（MAI-75。packages/nodes の BUNDLED_FONTS と同じもの）。
// @font-face を宣言するだけで、使うまで（文字の範囲ごとのファイルも）読み込まない。
// 文字の太さ（デザインパネルの「太さ」）で選べるよう、それぞれのすべての太さを宣言する（持たない太さは、ブラウザが近い太さで描く）。
// ゴシック・明朝の既定は Noto Sans JP・Noto Serif JP（可変フォント。@font-face の名前は「… Variable」）
import '@fontsource-variable/noto-sans-jp'
import '@fontsource-variable/noto-serif-jp'
import '@fontsource-variable/m-plus-1-code'
// スライドと同じ M PLUS 1p（200・600 はない）
import '@fontsource/m-plus-1p/100.css'
import '@fontsource/m-plus-1p/300.css'
import '@fontsource/m-plus-1p/400.css'
import '@fontsource/m-plus-1p/500.css'
import '@fontsource/m-plus-1p/700.css'
import '@fontsource/m-plus-1p/800.css'
import '@fontsource/m-plus-1p/900.css'
import '@fontsource/biz-udpgothic/400.css'
import '@fontsource/biz-udpgothic/700.css'
import '@fontsource/biz-udpmincho/400.css'
import '@fontsource/biz-udpmincho/700.css'
import '@fontsource/zen-maru-gothic/300.css'
import '@fontsource/zen-maru-gothic/400.css'
import '@fontsource/zen-maru-gothic/500.css'
import '@fontsource/zen-maru-gothic/700.css'
import '@fontsource/zen-maru-gothic/900.css'
import '@fontsource/klee-one/400.css'
import '@fontsource/klee-one/600.css'
import '@fontsource/yomogi/400.css'
import '@fontsource/dela-gothic-one/400.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
