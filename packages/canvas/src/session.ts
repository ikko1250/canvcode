import type { Box, Camera } from '@canvcode/core'
import type { SnapGuide } from './snapping.ts'
import type { Axis } from './arrange.ts'

// セッションストア（MAI-11）。カメラ・選択・ホバー・ツールなど、保存も Undo もしない一時的な状態。

export type ToolId = 'select' | 'hand' | 'rect' | 'ellipse' | 'text' | 'title' | 'note' | 'frame' | 'draw' | 'eraser' | 'arrow' | 'portal' | 'markdown' | 'code'

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
  // 直前の範囲選択の枠と、そのとき選んだノード。右クリックの「AIに渡す」で範囲に使う。次の左クリックで消す
  lastBrush: { rect: Box; ids: ReadonlySet<string> } | null
  // 引用する範囲（PDF のページの上。ワールド座標。MAI-33）。範囲を決めたあと、メニューを閉じるまで出しておく
  quoteRegion: Box | null
  // 次のドラッグを、引用する範囲の選択にする（右クリックの「範囲を選んで引用」。一度だけ）
  quoteArmed: boolean
  // フリーハンドで描く線の色・太さ（MAI-27）と透過率（0〜1 の不透明度。MAI-49）
  drawStyle: DrawStyle
  // 矢印の色・太さ・矢じり（MAI-28）
  arrowStyle: ArrowStyle
  // 移動中に吸い付いた線（ワールド座標。MAI-53）。ドラッグを終えると空になる
  snapGuides: readonly SnapGuide[]
  // 間隔のハンドル（MAI-54）：ポインタの下にある（またはドラッグ中の）隙間。gapIndex はその軸の隙間の通し番号
  hoveredSpacing: { axis: Axis; gapIndex: number } | null
  // 間隔のハンドルをドラッグしている間の、今の間隔（棒の横に数字で出す）
  spacingDrag: { axis: Axis; gap: number } | null
}

export interface DrawStyle {
  color: string
  size: number
  opacity: number
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
      lastBrush: null,
      quoteRegion: null,
      quoteArmed: false,
      // フリーハンドの既定は赤・透過率 50%（MAI-49）
      drawStyle: { color: '#e03131', size: 4, opacity: 0.5 },
      arrowStyle: { color: '#1f2328', size: 3, arrowheadStart: 'none', arrowheadEnd: 'arrow' },
      snapGuides: [],
      hoveredSpacing: null,
      spacingDrag: null,
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
