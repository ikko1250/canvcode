import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Root } from './Root.tsx'
// デジタル庁デザインシステム（DADS）のデザイントークン（MAI-111）。:root に色・影・角丸などの変数を置くだけで、
// 見た目は変えない。styles.css がこの変数を指すので、先に読み込む
import '@digital-go-jp/design-tokens/dist/tokens.css'
import './styles.css'
// テキスト・付箋・図形で選べる同梱の日本語フォント（MAI-75。packages/nodes の BUNDLED_FONTS と同じもの）。
// @font-face を宣言するだけで、使うまで（文字の範囲ごとのファイルも）読み込まない。
// 文字の太さ（デザインパネルの「太さ」）で選べるよう、それぞれのすべての太さを宣言する（持たない太さは、ブラウザが近い太さで描く）。
// ゴシック・明朝の既定は Noto Sans JP・Noto Serif JP（可変フォント。@font-face の名前は「… Variable」）
import '@fontsource-variable/noto-sans-jp'
import '@fontsource-variable/noto-serif-jp'
import '@fontsource-variable/m-plus-1-code'
// ほかの選べるフォント（M PLUS 1p・BIZ UDP・Zen Maru Gothic など）の宣言は、文字の範囲ごとの @font-face が 2000 を超え、
// CSS が 2MB になるので、画面を出すのを待たせないよう、あとから読み込む（extraFonts.ts）。読み込めたフォントで描き直すのは、
// フォントの loadingdone で行う（MAI-75）
void import('./extraFonts.ts')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
