import { useRef, useState } from 'react'
import type { Workspace } from '@canvcode/canvas'
import type { CanvasRecord } from '@canvcode/core'
import { renamedTitle } from './rename.ts'

// パンくずリスト（MAI-8）。持ち主をたどった経路。ショートカットから入っても同じ経路になる
export function Breadcrumb(props: {
  workspace: Workspace
  currentId: string
  onOpen(canvasId: string): void
  onRename(canvasId: string, title: string): void
}) {
  const path = props.workspace.canvasPath(props.currentId)
  const unplaced = path[0]?.id !== props.workspace.rootCanvasId
  return (
    <nav className="breadcrumb">
      {unplaced && <span className="breadcrumb-note">未配置</span>}
      {path.map((canvas, i) => (
        <span key={canvas.id} className="breadcrumb-item">
          {(i > 0 || unplaced) && <span className="breadcrumb-sep">›</span>}
          {i === path.length - 1 ? (
            <CurrentTitle canvas={canvas} onRename={props.onRename} />
          ) : (
            <button onClick={() => props.onOpen(canvas.id)}>{canvas.title}</button>
          )}
        </span>
      ))}
    </nav>
  )
}

// 右端（今開いている Canvas）の名前。ダブルクリックで名前を変える（MAI-41）。
// 名前の変え方はサイドバーと同じ（今の Canvas の履歴に入る）
function CurrentTitle(props: { canvas: CanvasRecord; onRename(canvasId: string, title: string): void }) {
  const { canvas } = props
  const [editing, setEditing] = useState<string | null>(null)
  // 閉じると blur も起きるので、2 回目は何もしない（PortalRename と同じ。Esc のあとの blur で確定しないように）
  const done = useRef(false)
  if (editing !== null) {
    const finish = (commit: boolean) => {
      if (done.current) return
      done.current = true
      const title = commit ? renamedTitle(editing, canvas.title) : null
      if (title) props.onRename(canvas.id, title)
      setEditing(null)
    }
    return (
      <input
        className="breadcrumb-rename"
        autoFocus
        value={editing}
        // 名前の長さに合わせて広げる
        size={Math.max(editing.length + 2, 8)}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setEditing(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          // IME で変換を確定する Enter では、名前を確定しない
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter') finish(true)
          if (e.key === 'Escape') finish(false)
        }}
      />
    )
  }
  return (
    <strong
      title="ダブルクリックで名前を変える"
      onDoubleClick={() => {
        done.current = false
        setEditing(canvas.title)
      }}
    >
      {canvas.title}
    </strong>
  )
}
