import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Root } from './Root.tsx'
import './styles.css'
// テキスト・付箋で選べる同梱の日本語フォント（MAI-75。スライドと同じ M PLUS 1p）。
// @font-face を宣言するだけで、使うまで（文字の範囲ごとのファイルも）読み込まない
import '@fontsource/m-plus-1p/400.css'
import '@fontsource/m-plus-1p/700.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
