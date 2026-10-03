import { useEffect, useState } from 'react'
import { undoAgentChange, type AgentChange, type SyncClient } from '@canvcode/canvas'

// AI（MCP の edit_canvas）がキャンバスを変えたことの知らせ。「元に戻す」でその編集を取り消す。
// ほかの知らせ（notices）と同じ見た目で、その上に出す。しばらくすると消える
const SHOW_MS = 12_000

interface Toast extends AgentChange {
  state: 'idle' | 'undoing' | 'undone' | 'failed'
  error?: string
}

export function AgentToasts(props: { sync: SyncClient }) {
  const { sync } = props
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    const timers = new Set<number>()
    sync.setHandlers({
      onAgentChange: (change) => {
        setToasts((list) => [...list.filter((t) => t.batchId !== change.batchId), { ...change, state: 'idle' }])
        const timer = window.setTimeout(() => {
          timers.delete(timer)
          setToasts((list) => list.filter((t) => t.batchId !== change.batchId))
        }, SHOW_MS)
        timers.add(timer)
      },
    })
    return () => {
      sync.setHandlers({ onAgentChange: () => {} })
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [sync])

  const update = (batchId: string, patch: Partial<Toast>) =>
    setToasts((list) => list.map((t) => (t.batchId === batchId ? { ...t, ...patch } : t)))

  const undo = (toast: Toast) => {
    update(toast.batchId, { state: 'undoing' })
    undoAgentChange(toast.batchId)
      .then(() => update(toast.batchId, { state: 'undone' }))
      .catch((error: unknown) => update(toast.batchId, { state: 'failed', error: error instanceof Error ? error.message : String(error) }))
  }

  if (toasts.length === 0) return null
  return (
    <div className="notices agent-notices">
      {toasts.map((toast) => (
        <div key={toast.batchId} className="notice agent-notice">
          <span>AI：{toast.label || `${toast.count} 個のノードを変更`}</span>
          {toast.state === 'undone' ? (
            <span className="agent-notice-state">元に戻しました</span>
          ) : toast.state === 'failed' ? (
            <span className="agent-notice-state" title={toast.error}>
              元に戻せませんでした（そのあと変更されています）
            </span>
          ) : (
            <button type="button" disabled={toast.state === 'undoing'} onClick={() => undo(toast)}>
              元に戻す
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
