import type { Workspace } from '@canvcode/canvas'

// パンくずリスト（MAI-8）。持ち主をたどった経路。ショートカットから入っても同じ経路になる
export function Breadcrumb(props: { workspace: Workspace; currentId: string; onOpen(canvasId: string): void }) {
  const path = props.workspace.canvasPath(props.currentId)
  const unplaced = path[0]?.id !== props.workspace.rootCanvasId
  return (
    <nav className="breadcrumb">
      {unplaced && <span className="breadcrumb-note">未配置</span>}
      {path.map((canvas, i) => (
        <span key={canvas.id} className="breadcrumb-item">
          {(i > 0 || unplaced) && <span className="breadcrumb-sep">›</span>}
          {i === path.length - 1 ? (
            <strong>{canvas.title}</strong>
          ) : (
            <button onClick={() => props.onOpen(canvas.id)}>{canvas.title}</button>
          )}
        </span>
      ))}
    </nav>
  )
}
