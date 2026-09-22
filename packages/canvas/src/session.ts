import type { Box, Camera } from '@canvcode/core'

// セッションストア（MAI-11）。カメラ・選択・ホバー・ツールなど、保存も Undo もしない一時的な状態。

export type ToolId = 'select' | 'hand' | 'rect' | 'ellipse' | 'text' | 'note' | 'frame' | 'draw' | 'eraser' | 'arrow'

export interface SessionState {
  camera: Camera
  selectedIds: ReadonlySet<string>
  hoveredId: string | null
  toolId: ToolId
  // 文字を編集しているノード（MAI-24）
  editingId: string | null
  // ダブルクリックで中に入っている group（MAI-25）。中のノードを直接選べる
  focusedGroupId: string | null
  // 範囲選択の枠（ワールド座標）
  brush: Box | null
  // フリーハンドで描く線の色と太さ（MAI-27）
  drawStyle: { color: string; size: number }
  // 矢印の色・太さ・矢じり（MAI-28）
  arrowStyle: ArrowStyle
}

export interface ArrowStyle {
  color: string
  size: number
  arrowheadStart: 'none' | 'arrow'
  arrowheadEnd: 'none' | 'arrow'
}

export class Session {
  private state: SessionState
  private readonly listeners = new Set<(state: SessionState, prev: SessionState) => void>()

  constructor(initial?: Partial<SessionState>) {
    this.state = {
      camera: { x: 0, y: 0, zoom: 1 },
      selectedIds: new Set(),
      hoveredId: null,
      toolId: 'select',
      editingId: null,
      focusedGroupId: null,
      brush: null,
      drawStyle: { color: '#1f2328', size: 4 },
      arrowStyle: { color: '#1f2328', size: 3, arrowheadStart: 'none', arrowheadEnd: 'arrow' },
      ...initial,
    }
  }

  get(): SessionState {
    return this.state
  }

  set(patch: Partial<SessionState>): void {
    const prev = this.state
    this.state = { ...prev, ...patch }
    for (const listener of this.listeners) listener(this.state, prev)
  }

  // React からは useSyncExternalStore で読む（MAI-11）
  subscribe = (listener: (state: SessionState, prev: SessionState) => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): SessionState => this.state
}
