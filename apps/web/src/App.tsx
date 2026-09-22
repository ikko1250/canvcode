import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { CanvasView, Editor, type StatsSummary, type ToolId } from '@canvcode/canvas'
import { builtinNodeTypes } from '@canvcode/nodes'
import { clearNodes, generateNodes, runBenchmark, type PhaseResult } from './benchmark.ts'
import { CARD_COUNT, generateMarkdownCards, runCardBenchmark, type CardBenchmarkResult } from './cardBenchmark.ts'
import { markdownCardType } from './markdown/markdownCard.ts'

// 段階 1・2 の動作確認用の画面。サイドバーやパンくずなど本来の UI は、後の段階で作る。

const TOOLS: { id: ToolId; label: string; key: string }[] = [
  { id: 'select', label: '選択', key: 'V' },
  { id: 'hand', label: '手のひら', key: 'H' },
  { id: 'rect', label: '矩形', key: 'R' },
  { id: 'ellipse', label: '楕円', key: 'O' },
]

const BENCH_NODE_COUNT = 10_000

export function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [editor] = useState(() => new Editor({ types: [...builtinNodeTypes, markdownCardType] }))
  const [view, setView] = useState<CanvasView | null>(null)
  const session = useSyncExternalStore(editor.session.subscribe, editor.session.getSnapshot)
  const [stats, setStats] = useState<StatsSummary | null>(null)
  const [showStats, setShowStats] = useState(true)
  const [bench, setBench] = useState<'idle' | 'running' | PhaseResult[]>('idle')
  const [cardBench, setCardBench] = useState<'idle' | 'running' | CardBenchmarkResult>('idle')

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const created = new CanvasView(editor, container)
    setView(created)
    // 開発者ツールや自動テストから状態を調べるための入口
    ;(window as unknown as { canvcode: unknown }).canvcode = { editor, view: created }
    return () => created.dispose()
  }, [editor])

  useEffect(() => {
    if (!view || !showStats) return
    const timer = window.setInterval(() => setStats(view.getStats()), 500)
    return () => window.clearInterval(timer)
  }, [view, showStats])

  const startBenchmark = () => {
    if (!view) return
    if (editor.index.size < BENCH_NODE_COUNT) {
      clearNodes(editor)
      generateNodes(editor, BENCH_NODE_COUNT)
    }
    setBench('running')
    runBenchmark(view, (results) => setBench(results))
  }

  return (
    <div className="app">
      <div className="canvas-container" ref={containerRef} />

      <div className="toolbar">
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            className={session.toolId === tool.id ? 'active' : ''}
            onClick={() => editor.session.set({ toolId: tool.id })}
            title={`${tool.label}（${tool.key}）`}
          >
            {tool.label}
            <kbd>{tool.key}</kbd>
          </button>
        ))}
        <span className="separator" />
        <button onClick={() => editor.undo()} title="元に戻す（Ctrl+Z）">
          元に戻す
        </button>
        <button onClick={() => editor.redo()} title="やり直す（Ctrl+Shift+Z）">
          やり直す
        </button>
        <span className="separator" />
        <button
          onClick={() => {
            generateNodes(editor, BENCH_NODE_COUNT)
            view?.zoomToFit()
          }}
        >
          1 万ノードを追加
        </button>
        <button onClick={() => clearNodes(editor)}>すべて消す</button>
        <button onClick={startBenchmark} disabled={bench === 'running'}>
          {bench === 'running' ? 'ベンチマーク実行中…' : 'ベンチマーク'}
        </button>
        <span className="separator" />
        <button
          onClick={() => {
            generateMarkdownCards(editor)
            view?.zoomToFit()
          }}
        >
          Markdown カード {CARD_COUNT} 枚を追加
        </button>
        <button
          disabled={cardBench === 'running' || !view}
          onClick={async () => {
            if (!view) return
            setCardBench('running')
            setCardBench(await runCardBenchmark(view))
          }}
        >
          {cardBench === 'running' ? 'カードのベンチマーク実行中…' : 'カードのズームのベンチマーク'}
        </button>
        <button onClick={() => setShowStats((v) => !v)}>{showStats ? '計測を隠す' : '計測を表示'}</button>
      </div>

      {showStats && stats && (
        <div className="stats">
          <div>FPS {stats.fps.toFixed(0)}</div>
          <div>
            フレーム間隔 中央値 {stats.intervalP50.toFixed(1)} ms / 95% {stats.intervalP95.toFixed(1)} ms
          </div>
          <div>
            描画時間 中央値 {stats.drawP50.toFixed(2)} ms / 95% {stats.drawP95.toFixed(2)} ms
          </div>
          <div>
            描画ノード {stats.drawnNodes.toLocaleString()} / 全 {stats.totalNodes.toLocaleString()}
          </div>
          <div>倍率 {(session.camera.zoom * 100).toFixed(0)}%</div>
        </div>
      )}

      {Array.isArray(bench) && (
        <div className="bench-result">
          <div className="bench-header">
            <strong>ベンチマーク結果（{editor.index.size.toLocaleString()} ノード）</strong>
            <button onClick={() => setBench('idle')}>閉じる</button>
          </div>
          <table>
            <thead>
              <tr>
                <th>段階</th>
                <th>FPS</th>
                <th>間隔 中央値</th>
                <th>間隔 95%</th>
                <th>描画 中央値</th>
                <th>描画 95%</th>
                <th>描画ノード</th>
              </tr>
            </thead>
            <tbody>
              {bench.map((result) => (
                <tr key={result.name}>
                  <td>{result.name}</td>
                  <td>{result.stats.fps.toFixed(0)}</td>
                  <td>{result.stats.intervalP50.toFixed(1)} ms</td>
                  <td>{result.stats.intervalP95.toFixed(1)} ms</td>
                  <td>{result.stats.drawP50.toFixed(2)} ms</td>
                  <td>{result.stats.drawP95.toFixed(2)} ms</td>
                  <td>{result.stats.drawnNodes.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            目標は 60FPS（フレーム間隔 16.7 ms）。描画時間はシーンとオーバーレイの描画にかかった CPU 時間。
          </p>
        </div>
      )}

      {typeof cardBench === 'object' && (
        <div className="bench-result card-bench-result">
          <div className="bench-header">
            <strong>
              カードのズームのベンチマーク（Markdown カード {CARD_COUNT} 枚、devicePixelRatio {cardBench.dpr}）
            </strong>
            <button onClick={() => setCardBench('idle')}>閉じる</button>
          </div>
          <table>
            <thead>
              <tr>
                <th>段階</th>
                <th>FPS</th>
                <th>間隔 中央値</th>
                <th>間隔 95%</th>
                <th>間隔 最大</th>
                <th>落ちたフレーム</th>
                <th>作った画像</th>
                <th>くっきりするまで</th>
              </tr>
            </thead>
            <tbody>
              {cardBench.phases.map((phase) => (
                <tr key={phase.name}>
                  <td>{phase.name}</td>
                  <td>{phase.fps.toFixed(0)}</td>
                  <td>{phase.p50.toFixed(1)} ms</td>
                  <td>{phase.p95.toFixed(1)} ms</td>
                  <td>{phase.max.toFixed(1)} ms</td>
                  <td>
                    {phase.dropped} / {phase.frames}
                  </td>
                  <td>{phase.produced}</td>
                  <td>{phase.sharpMs !== undefined ? `${(phase.sharpMs / 1000).toFixed(2)} 秒` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            画像の作り方：createImageBitmap {cardBench.raster.bitmap} 回 ／ Canvas {cardBench.raster.canvas} 回（うち
            createImageBitmap から戻したもの {cardBench.raster.bitmapFallback} 回）。
            最初の画像を作り終えるまで {(cardBench.warmupMs / 1000).toFixed(2)} 秒。「落ちたフレーム」は、間隔が 25 ms
            を超えたフレームの数。
          </p>
        </div>
      )}

      <div className="help">
        ホイール：パン ／ Ctrl+ホイール・ピンチ：ズーム ／ Space+ドラッグ・中ボタン：パン ／ Shift+1：全体表示 ／
        Delete：削除 ／ 矢印キー：移動 ／ Esc：取り消し
      </div>
    </div>
  )
}
