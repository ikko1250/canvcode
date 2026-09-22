import { lazy, Suspense, useEffect, useState } from 'react'
import { loadRecords, type InitialRecords } from '@canvcode/canvas'
import { App } from './App.tsx'

// 検証ページは ?lab=markdown で開く（MAI-21）。通常の画面には読み込ませない
const MarkdownLab = lazy(() => import('./lab/MarkdownLab.tsx').then((m) => ({ default: m.MarkdownLab })))

export function Root() {
  const lab = new URLSearchParams(location.search).get('lab')
  // 保存されているレコードを読んでから、画面を作る（MAI-13）
  const [initial, setInitial] = useState<InitialRecords | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (lab === 'markdown') return
    let cancelled = false
    loadRecords()
      .then((records) => {
        if (!cancelled) setInitial(records)
      })
      .catch((error: unknown) => {
        console.error('Failed to load the workspace', error)
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [lab, attempt])
  if (lab === 'markdown') {
    return (
      <Suspense fallback={null}>
        <MarkdownLab />
      </Suspense>
    )
  }
  if (!initial) {
    return (
      <div className="loading-screen">
        {failed ? (
          <>
            <p>ワークスペースを読み込めませんでした。サーバーが動いているか確かめてください。</p>
            <button
              onClick={() => {
                setFailed(false)
                setAttempt((n) => n + 1)
              }}
            >
              もう一度読み込む
            </button>
          </>
        ) : (
          <p>読み込み中…</p>
        )}
      </div>
    )
  }
  return <App initial={initial} />
}
