import { lazy, Suspense } from 'react'
import { App } from './App.tsx'

// 検証ページは ?lab=markdown で開く（MAI-21）。通常の画面には読み込ませない
const MarkdownLab = lazy(() => import('./lab/MarkdownLab.tsx').then((m) => ({ default: m.MarkdownLab })))

export function Root() {
  const lab = new URLSearchParams(location.search).get('lab')
  if (lab === 'markdown') {
    return (
      <Suspense fallback={null}>
        <MarkdownLab />
      </Suspense>
    )
  }
  return <App />
}
