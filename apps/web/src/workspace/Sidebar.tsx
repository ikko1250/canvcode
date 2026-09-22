import { useState } from 'react'
import type { CanvasRecord } from '@canvcode/core'
import type { Workspace } from '@canvcode/canvas'

// サイドバー（MAI-8 の「3. ナビゲーション」、MAI-29）。
// - ツリー：持ち主による木構造をそのまま表示する。ダブルクリックで名前を変える
// - 未配置：持ち主の Portal がなくなった Canvas。今の Canvas に置き直せる
// - ゴミ箱：元に戻す・完全に削除する

export interface SidebarProps {
  workspace: Workspace
  currentId: string
  onOpen(canvasId: string): void
  onRename(canvasId: string, title: string): void
  onPlace(canvasId: string): void
  onRestore(canvasId: string): void
  onDeleteForever(canvasId: string): void
  onClose(): void
}

export function Sidebar(props: SidebarProps) {
  const { workspace } = props
  const root = workspace.getCanvas(workspace.rootCanvasId)
  const unplaced = workspace.unplacedCanvases()
  const trashed = workspace.trashedCanvases()
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <strong>ワークスペース</strong>
        <button onClick={props.onClose} title="サイドバーを閉じる（Ctrl+\）">
          ‹
        </button>
      </div>
      <nav className="sidebar-section">{root && <TreeItem {...props} canvas={root} depth={0} />}</nav>
      {unplaced.length > 0 && (
        <section className="sidebar-section">
          <h3>未配置</h3>
          {unplaced.map((canvas) => (
            <div key={canvas.id} className="sidebar-row">
              <CanvasTitle {...props} canvas={canvas} />
              <button className="sidebar-action" onClick={() => props.onPlace(canvas.id)} title="今のキャンバスの中央に置く">
                ここに置く
              </button>
            </div>
          ))}
        </section>
      )}
      <section className="sidebar-section">
        <h3>ゴミ箱</h3>
        {trashed.length === 0 && <div className="sidebar-empty">空です</div>}
        {trashed.map((canvas) => (
          <div key={canvas.id} className="sidebar-row trashed">
            <span className="sidebar-title">{canvas.title}</span>
            <button className="sidebar-action" onClick={() => props.onRestore(canvas.id)}>
              元に戻す
            </button>
            <button className="sidebar-action danger" onClick={() => props.onDeleteForever(canvas.id)}>
              削除
            </button>
          </div>
        ))}
      </section>
    </aside>
  )
}

function TreeItem(props: SidebarProps & { canvas: CanvasRecord; depth: number }) {
  const children = props.workspace.childCanvases(props.canvas.id)
  return (
    <>
      <div className="sidebar-row" style={{ paddingLeft: 8 + props.depth * 14 }}>
        <CanvasTitle {...props} />
      </div>
      {children.map((child) => (
        <TreeItem key={child.id} {...props} canvas={child} depth={props.depth + 1} />
      ))}
    </>
  )
}

// 名前。クリックで開き、今開いている Canvas ならダブルクリックで名前を変える
function CanvasTitle(props: SidebarProps & { canvas: CanvasRecord }) {
  const [editing, setEditing] = useState<string | null>(null)
  const { canvas } = props
  const current = canvas.id === props.currentId
  if (editing !== null) {
    const commit = () => {
      const title = editing.trim()
      if (title) props.onRename(canvas.id, title)
      setEditing(null)
    }
    return (
      <input
        className="sidebar-rename"
        autoFocus
        value={editing}
        onChange={(e) => setEditing(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          // IME で変換を確定する Enter では、名前を確定しない
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setEditing(null)
        }}
      />
    )
  }
  return (
    <button
      className={current ? 'sidebar-title current' : 'sidebar-title'}
      // ダブルクリックの 2 回目のクリックでは開かない
      onClick={(e) => {
        if (e.detail <= 1) props.onOpen(canvas.id)
      }}
      // 名前を変えられるのは、今開いている Canvas だけ（開いている途中に名前を変えると、どの Canvas の履歴に入るかが揺れるため）
      onDoubleClick={() => {
        if (current) setEditing(canvas.title)
      }}
      title={current ? `${canvas.title}（ダブルクリックで名前を変える）` : canvas.title}
    >
      {canvas.title}
    </button>
  )
}
