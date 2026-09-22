import { boxFromPoints, dist, panBy, worldToScreen, type NodeRecord, type Transaction, type Vec } from '@canvcode/core'
import { GEO_DEFAULT_SIZE, type GeoProps } from '@canvcode/nodes'
import type { Editor, TransformSelection } from './editor.ts'
import type { ToolId } from './session.ts'
import {
  frameCenter,
  handleCursor,
  hitHandle,
  resizeFrame,
  resizeNodes,
  rotateNodes,
  rotationDelta,
  screenHandles,
  type Handle,
  type HandleHit,
  type ScreenHandles,
} from './transform.ts'

// ツールの状態機械（MAI-12）。各ツールは自分の状態を持ち、ポインタとキーの入力で状態を移る。
// どの状態でも cancel（Esc）で操作を取り消して idle に戻れる。

// ドラッグとみなすまでの移動量（CSS ピクセル）
const DRAG_THRESHOLD_PX = 3
// 当たり判定の余裕（CSS ピクセル）
export const HIT_MARGIN_PX = 4

export interface ToolPointer {
  screen: Vec
  world: Vec
  button: number
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

export interface ToolContext {
  readonly editor: Editor
  setTool(id: ToolId): void
  // シーンから外してオーバーレイに描くノードを決める（ドラッグ中など）
  lift(ids: Iterable<string>): void
  drop(): void
  // ツールの既定のカーソルの代わりに使うカーソル（ハンドルの上など）。null で元に戻す
  setCursor(cursor: string | null): void
}

// 選択しているノードのハンドル（画面上の位置）。描画と当たり判定で同じものを使う（MAI-23）
export function selectionHandles(editor: Editor): { selection: TransformSelection; handles: ScreenHandles } | null {
  const selection = editor.transformSelection()
  if (!selection) return null
  const camera = editor.session.get().camera
  const handles = screenHandles(selection.frame, (p) => worldToScreen(camera, p), {
    resize: selection.canResize,
    rotate: selection.canRotate,
  })
  return { selection, handles }
}

export interface Tool {
  readonly id: ToolId
  readonly cursor: string
  onPointerDown?(pointer: ToolPointer): void
  onPointerMove?(pointer: ToolPointer): void
  onPointerUp?(pointer: ToolPointer): void
  // 操作の途中なら取り消して true を返す
  cancel(): boolean
  // 別のツールに切り替わるとき
  onExit?(): void
}

// ---- 選択ツール ----

type SelectState =
  | { name: 'idle' }
  | { name: 'pointingNode'; start: ToolPointer; nodeId: string; wasSelected: boolean }
  | { name: 'pointingCanvas'; start: ToolPointer }
  | {
      name: 'translating'
      start: ToolPointer
      tx: Transaction<NodeRecord>
      initial: Map<string, NodeRecord>
    }
  | { name: 'resizing'; handle: Handle; tx: Transaction<NodeRecord>; selection: TransformSelection }
  | {
      name: 'rotating'
      tx: Transaction<NodeRecord>
      pivot: Vec
      start: Vec
      initial: NodeRecord[]
      // 1 つだけのときはそのノードの向き（Shift で向きを 15° 刻みにする）。複数なら null
      baseRotation: number | null
    }

export class SelectTool implements Tool {
  readonly id = 'select' as const
  readonly cursor = 'default'
  private state: SelectState = { name: 'idle' }
  private readonly ctx: ToolContext

  constructor(ctx: ToolContext) {
    this.ctx = ctx
  }

  onPointerDown(pointer: ToolPointer): void {
    if (pointer.button !== 0) return
    const editor = this.ctx.editor
    // 選択枠のハンドルは、ノードより先に調べる
    const handleHit = this.hitSelectionHandle(pointer)
    if (handleHit) {
      this.startTransform(handleHit.hit, handleHit.selection, pointer)
      return
    }
    const zoom = editor.session.get().camera.zoom
    const hit = editor.hitTest(pointer.world, HIT_MARGIN_PX / zoom)
    const selected = editor.session.get().selectedIds
    if (hit) {
      const wasSelected = selected.has(hit.id)
      if (pointer.shiftKey) {
        if (!wasSelected) editor.setSelection([...selected, hit.id])
      } else if (!wasSelected) {
        editor.setSelection([hit.id])
      }
      this.state = { name: 'pointingNode', start: pointer, nodeId: hit.id, wasSelected }
    } else {
      if (!pointer.shiftKey) editor.setSelection([])
      this.state = { name: 'pointingCanvas', start: pointer }
    }
  }

  onPointerMove(pointer: ToolPointer): void {
    const editor = this.ctx.editor
    const state = this.state
    switch (state.name) {
      case 'idle': {
        const handleHit = this.hitSelectionHandle(pointer)
        if (handleHit) {
          this.ctx.setCursor(this.cursorFor(handleHit.hit, handleHit.selection))
          if (editor.session.get().hoveredId) editor.session.set({ hoveredId: null })
          return
        }
        this.ctx.setCursor(null)
        const zoom = editor.session.get().camera.zoom
        const hoveredId = editor.hitTest(pointer.world, HIT_MARGIN_PX / zoom)?.id ?? null
        if (hoveredId !== editor.session.get().hoveredId) editor.session.set({ hoveredId })
        return
      }
      case 'resizing': {
        const { selection, handle, tx } = state
        const frame = resizeFrame(selection.frame, handle, pointer.world, {
          keepAspect: pointer.shiftKey || selection.forceAspect,
          fromCenter: pointer.altKey,
          minW: selection.minSize.w,
          minH: selection.minSize.h,
        })
        for (const node of resizeNodes(selection.targets, selection.frame, frame)) tx.put(node)
        tx.flush()
        return
      }
      case 'rotating': {
        const delta = rotationDelta(state.pivot, state.start, pointer.world, pointer.shiftKey, state.baseRotation)
        for (const node of rotateNodes(state.initial, state.pivot, delta)) state.tx.put(node)
        state.tx.flush()
        return
      }
      case 'pointingNode': {
        if (dist(pointer.screen, state.start.screen) < DRAG_THRESHOLD_PX) return
        this.startTranslating(state.start)
        this.onPointerMove(pointer)
        return
      }
      case 'pointingCanvas':
        // 範囲選択は段階 5 で入れる
        return
      case 'translating': {
        const dx = pointer.world.x - state.start.world.x
        const dy = pointer.world.y - state.start.world.y
        for (const node of state.initial.values()) {
          state.tx.put({ ...node, x: node.x + dx, y: node.y + dy })
        }
        state.tx.flush()
        return
      }
    }
  }

  onPointerUp(pointer: ToolPointer): void {
    const editor = this.ctx.editor
    const state = this.state
    if (state.name === 'pointingNode' && pointer.shiftKey && state.wasSelected) {
      // Shift+クリックで、選択済みのノードを選択から外す
      const next = new Set(editor.session.get().selectedIds)
      next.delete(state.nodeId)
      editor.setSelection(next)
    } else if (state.name === 'pointingNode' && !pointer.shiftKey && state.wasSelected) {
      // 複数選択中に 1 つをクリックしたら、それだけを選ぶ
      editor.setSelection([state.nodeId])
    } else if (state.name === 'translating' || state.name === 'resizing' || state.name === 'rotating') {
      editor.finish(state.tx)
      this.ctx.drop()
      this.ctx.setCursor(null)
    }
    this.state = { name: 'idle' }
  }

  cancel(): boolean {
    const state = this.state
    this.state = { name: 'idle' }
    if (state.name === 'translating' || state.name === 'resizing' || state.name === 'rotating') {
      state.tx.cancel()
      this.ctx.drop()
      this.ctx.setCursor(null)
      return true
    }
    return state.name !== 'idle'
  }

  private hitSelectionHandle(pointer: ToolPointer): { hit: HandleHit; selection: TransformSelection } | null {
    const found = selectionHandles(this.ctx.editor)
    if (!found) return null
    const hit = hitHandle(found.handles, pointer.screen)
    return hit ? { hit, selection: found.selection } : null
  }

  private cursorFor(hit: HandleHit, selection: TransformSelection): string {
    return hit.kind === 'rotate' ? 'grab' : handleCursor(hit.handle, selection.frame.rotation)
  }

  private startTransform(hit: HandleHit, selection: TransformSelection, pointer: ToolPointer): void {
    const editor = this.ctx.editor
    const ids = selection.targets.map((t) => t.node.id)
    editor.session.set({ hoveredId: null })
    if (hit.kind === 'resize') {
      const tx = editor.begin('resize')
      this.ctx.lift(ids)
      this.ctx.setCursor(this.cursorFor(hit, selection))
      this.state = { name: 'resizing', handle: hit.handle, tx, selection }
    } else {
      const tx = editor.begin('rotate')
      this.ctx.lift(ids)
      this.ctx.setCursor('grabbing')
      const single = selection.targets.length === 1
      this.state = {
        name: 'rotating',
        tx,
        pivot: frameCenter(selection.frame),
        start: pointer.world,
        initial: selection.targets.map((t) => t.node),
        baseRotation: single ? selection.targets[0].node.rotation : null,
      }
    }
  }

  onExit(): void {
    this.cancel()
    this.ctx.editor.session.set({ hoveredId: null })
  }

  private startTranslating(start: ToolPointer): void {
    const editor = this.ctx.editor
    const initial = new Map<string, NodeRecord>()
    for (const id of editor.session.get().selectedIds) {
      const node = editor.getNode(id)
      if (node && !node.locked) initial.set(id, node)
    }
    if (initial.size === 0) {
      this.state = { name: 'idle' }
      return
    }
    const tx = editor.begin('move')
    this.ctx.lift(initial.keys())
    editor.session.set({ hoveredId: null })
    this.state = { name: 'translating', start, tx, initial }
  }
}

// ---- 手のひらツール（パン） ----

export class HandTool implements Tool {
  readonly id = 'hand' as const
  readonly cursor = 'grab'
  private last: Vec | null = null
  private readonly ctx: ToolContext

  constructor(ctx: ToolContext) {
    this.ctx = ctx
  }

  onPointerDown(pointer: ToolPointer): void {
    this.last = pointer.screen
  }

  onPointerMove(pointer: ToolPointer): void {
    if (!this.last) return
    const { session } = this.ctx.editor
    session.set({
      camera: panBy(session.get().camera, pointer.screen.x - this.last.x, pointer.screen.y - this.last.y),
    })
    this.last = pointer.screen
  }

  onPointerUp(): void {
    this.last = null
  }

  cancel(): boolean {
    const active = this.last !== null
    this.last = null
    return active
  }
}

// ---- 図形ツール（矩形・楕円） ----

export class GeoTool implements Tool {
  readonly id: 'rect' | 'ellipse'
  readonly cursor = 'crosshair'
  private creating: { start: ToolPointer; tx: Transaction<NodeRecord>; node: NodeRecord<GeoProps> } | null =
    null
  private readonly ctx: ToolContext

  constructor(ctx: ToolContext, shape: 'rect' | 'ellipse') {
    this.ctx = ctx
    this.id = shape
  }

  onPointerDown(pointer: ToolPointer): void {
    if (pointer.button !== 0) return
    const editor = this.ctx.editor
    const tx = editor.begin(`create ${this.id}`)
    const node = editor.makeNode('geo', {
      x: pointer.world.x,
      y: pointer.world.y,
      props: { shape: this.id, w: 1, h: 1 },
    }) as NodeRecord<GeoProps>
    tx.put(node)
    tx.flush()
    editor.setSelection([node.id])
    this.ctx.lift([node.id])
    this.creating = { start: pointer, tx, node }
  }

  onPointerMove(pointer: ToolPointer): void {
    const creating = this.creating
    if (!creating) return
    let end = pointer.world
    if (pointer.shiftKey) {
      // Shift で正方形・正円にする
      const dx = end.x - creating.start.world.x
      const dy = end.y - creating.start.world.y
      const size = Math.max(Math.abs(dx), Math.abs(dy))
      end = { x: creating.start.world.x + Math.sign(dx || 1) * size, y: creating.start.world.y + Math.sign(dy || 1) * size }
    }
    const box = boxFromPoints(creating.start.world, end)
    creating.tx.put({
      ...creating.node,
      x: box.x,
      y: box.y,
      props: { ...creating.node.props, w: Math.max(box.w, 1), h: Math.max(box.h, 1) },
    })
    creating.tx.flush()
  }

  onPointerUp(pointer: ToolPointer): void {
    const creating = this.creating
    if (!creating) return
    this.creating = null
    if (dist(pointer.screen, creating.start.screen) < DRAG_THRESHOLD_PX) {
      // クリックだけなら、既定の大きさでクリックした位置を中心に置く
      creating.tx.put({
        ...creating.node,
        x: pointer.world.x - GEO_DEFAULT_SIZE / 2,
        y: pointer.world.y - GEO_DEFAULT_SIZE / 2,
        props: { ...creating.node.props, w: GEO_DEFAULT_SIZE, h: GEO_DEFAULT_SIZE },
      })
    }
    this.ctx.editor.finish(creating.tx)
    this.ctx.drop()
    // 作り終えたら選択ツールに戻る
    this.ctx.setTool('select')
  }

  cancel(): boolean {
    const creating = this.creating
    if (!creating) return false
    this.creating = null
    creating.tx.cancel()
    this.ctx.drop()
    return true
  }

  onExit(): void {
    this.cancel()
  }
}
