import type { Camera } from '@canvcode/core'

// セッションストア（MAI-11）。カメラ・選択・ホバー・ツールなど、保存も Undo もしない一時的な状態。

export type ToolId = 'select' | 'hand' | 'rect' | 'ellipse' | 'text' | 'note'

export interface SessionState {
  camera: Camera
  selectedIds: ReadonlySet<string>
  hoveredId: string | null
  toolId: ToolId
  // 文字を編集しているノード（MAI-24）
  editingId: string | null
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
