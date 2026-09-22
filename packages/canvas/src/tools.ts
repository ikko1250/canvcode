import { boxFromPoints, dist, panBy, worldToScreen, type Box, type NodeRecord, type Transaction, type Vec } from '@canvcode/core'
import {
  GEO_DEFAULT_SIZE,
  textLayout,
  type FrameProps,
  type GeoProps,
  type NoteProps,
  type TextProps,
} from '@canvcode/nodes'
import type { Editor, TransformSelection } from './editor.ts'
import type { ToolId } from './session.ts'
import {
  frameCenter,
  handleCursor,
  hitHandle,
  resizeFrame,
  rotationDelta,
  screenHandles,
  type Handle,
  type HandleHit,
  type ScreenHandles,
} from './transform.ts'

// ツールの状態機械（MAI-12）。各ツールは自分の状態を持ち、ポインタとキーの入力で状態を移る。
// どの状態でも cancel（Esc）で操作を取り消して idle に戻れる。
// 入れ子のノード（MAI-25）の移動・リサイズ・回転は、ワールドで計算してから親のローカル座標に戻す。

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
  // シーンから外してオーバーレイに描くノードを決める（ドラッグ中など）。子孫も一緒に外す
  lift(ids: Iterable<string>): void
  drop(): void
  // ツールの既定のカーソルの代わりに使うカーソル（ハンドルの上など）。null で元に戻す
  setCursor(cursor: string | null): void
  // 文字の編集モードに入る（MAI-24）。tx を渡すと、作成と編集が 1 回の Undo になる
  startEditing(nodeId: string, options?: { tx?: Transaction<NodeRecord>; selectAll?: boolean }): boolean
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
  onDoubleClick?(pointer: ToolPointer): void
  // 操作の途中なら取り消して true を返す
  cancel(): boolean
  // 別のツールに切り替わるとき
  onExit?(): void
}

// ワールド座標の点に新しいノードを置くときの親（フレームの中ならそのフレーム）と、親のローカル座標での位置
function placeAt(editor: Editor, point: Vec): { parentId: string; local: Vec } {
  const parentId = editor.frameAt(point) ?? editor.canvasId
  return { parentId, local: editor.worldToParent(parentId, point) }
}

// ---- 選択ツール ----

type SelectState =
  | { name: 'idle' }
  | { name: 'pointingNode'; start: ToolPointer; nodeId: string; wasSelected: boolean }
  | { name: 'pointingCanvas'; start: ToolPointer; initial: ReadonlySet<string> }
  | { name: 'brushing'; start: ToolPointer; initial: ReadonlySet<string>; additive: boolean }
  | {
      name: 'translating'
      start: ToolPointer
      tx: Transaction<NodeRecord>
      // ワールドでの形にした、動かし始めのノード
      initial: Map<string, NodeRecord>
    }
  | { name: 'resizing'; handle: Handle; tx: Transaction<NodeRecord>; selection: TransformSelection }
  | {
      name: 'rotating'
      tx: Transaction<NodeRecord>
      selection: TransformSelection
      pivot: Vec
      start: Vec
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
      // group の中のノードは、中に入っていなければ group 全体を選ぶ（MAI-12）
      const target = editor.selectableFor(hit.id)
      const wasSelected = selected.has(target)
      if (pointer.shiftKey) {
        if (!wasSelected) editor.setSelection([...selected, target])
      } else if (!wasSelected) {
        editor.setSelection([target])
      }
      this.state = { name: 'pointingNode', start: pointer, nodeId: target, wasSelected }
    } else {
      if (!pointer.shiftKey) {
        editor.setSelection([])
        editor.focusGroup(null)
      }
      this.state = { name: 'pointingCanvas', start: pointer, initial: new Set(editor.session.get().selectedIds) }
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
        const hit = editor.hitTest(pointer.world, HIT_MARGIN_PX / zoom)
        // ホバーの表示も、クリックしたら選ばれるもの（group 全体など）に合わせる
        const hoveredId = hit ? this.selectableWithoutSideEffects(hit.id) : null
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
        for (const node of editor.resizeSelection(selection, frame)) tx.put(node)
        tx.flush()
        return
      }
      case 'rotating': {
        const delta = rotationDelta(state.pivot, state.start, pointer.world, pointer.shiftKey, state.baseRotation)
        for (const node of editor.rotateSelection(state.selection, state.pivot, delta)) state.tx.put(node)
        state.tx.flush()
        return
      }
      case 'pointingNode': {
        if (dist(pointer.screen, state.start.screen) < DRAG_THRESHOLD_PX) return
        this.startTranslating(state.start)
        this.onPointerMove(pointer)
        return
      }
      case 'pointingCanvas': {
        if (dist(pointer.screen, state.start.screen) < DRAG_THRESHOLD_PX) return
        this.state = { name: 'brushing', start: state.start, initial: state.initial, additive: state.start.shiftKey }
        this.onPointerMove(pointer)
        return
      }
      case 'brushing': {
        // 範囲選択：枠に少しでも触れたノードを選ぶ。Shift なら今の選択に足す（MAI-25）
        const brush = boxFromPoints(state.start.world, pointer.world)
        const hits = editor.nodesInBrush(brush)
        editor.session.set({ brush, hoveredId: null })
        editor.setSelection(state.additive ? new Set([...state.initial, ...hits]) : hits)
        return
      }
      case 'translating': {
        const dx = pointer.world.x - state.start.world.x
        const dy = pointer.world.y - state.start.world.y
        for (const world of state.initial.values()) {
          state.tx.put(editor.fromWorld({ ...world, x: world.x + dx, y: world.y + dy }))
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
    } else if (state.name === 'brushing') {
      editor.session.set({ brush: null })
    } else if (state.name === 'translating') {
      this.dropIntoFrames(state.tx, [...state.initial.keys()])
      editor.finish(state.tx)
      this.ctx.drop()
    } else if (state.name === 'resizing' || state.name === 'rotating') {
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
    if (state.name === 'brushing') {
      this.ctx.editor.session.set({ brush: null })
      this.ctx.editor.setSelection(state.initial)
      return true
    }
    return state.name !== 'idle'
  }

  // ダブルクリック：
  // - group の中のノードなら、その group の中に入って、中のノードを選ぶ（入れ子なら 1 段ずつ）
  // - 文字を持つノードなら、編集モードに入る
  // - 何もない所なら、そこにテキストを作って編集する
  onDoubleClick(pointer: ToolPointer): void {
    const editor = this.ctx.editor
    const zoom = editor.session.get().camera.zoom
    const hit = editor.hitTest(pointer.world, HIT_MARGIN_PX / zoom)
    if (!hit) {
      createTextAt(this.ctx, pointer.world)
      return
    }
    const target = editor.selectableFor(hit.id)
    if (target !== hit.id) {
      editor.focusGroup(target)
      editor.setSelection([editor.selectableFor(hit.id)])
      return
    }
    if (editor.getType(hit).editText) this.ctx.startEditing(hit.id, { selectAll: true })
  }

  onExit(): void {
    this.cancel()
    this.ctx.editor.session.set({ hoveredId: null })
  }

  // selectableFor と同じ選び方で、中に入っている group から出る処理はしないもの（ホバーの表示用）
  private selectableWithoutSideEffects(id: string): string {
    const editor = this.ctx.editor
    const focus = editor.session.get().focusedGroupId
    let target = id
    for (const ancestor of editor.index.ancestorsOf(id)) {
      if (ancestor === focus) break
      const node = editor.getNode(ancestor)
      if (node && editor.isContainer(node, 'group')) target = ancestor
    }
    return target
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
        selection,
        pivot: frameCenter(selection.frame),
        start: pointer.world,
        baseRotation: single ? selection.targets[0].node.rotation : null,
      }
    }
  }

  private startTranslating(start: ToolPointer): void {
    const editor = this.ctx.editor
    const initial = new Map<string, NodeRecord>()
    for (const id of editor.session.get().selectedIds) {
      const node = editor.getNode(id)
      if (node && !node.locked) initial.set(id, editor.toWorld(node))
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

  // 動かし終えたノードを、中心の下にあるフレームの子にする（フレームの外に出したら Canvas に戻す）。
  // group の中のノードは、group から勝手に出さない
  private dropIntoFrames(tx: Transaction<NodeRecord>, ids: string[]): void {
    const editor = this.ctx.editor
    const moving = new Set(ids)
    const byParent = new Map<string, string[]>()
    for (const id of ids) {
      const node = tx.get(id)
      const entry = editor.index.get(id)
      if (!node || !entry) continue
      const parent = node.parentId === editor.canvasId ? null : editor.getNode(node.parentId)
      if (parent && editor.isContainer(parent, 'group')) continue
      const center = { x: entry.worldBounds.x + entry.worldBounds.w / 2, y: entry.worldBounds.y + entry.worldBounds.h / 2 }
      const target = editor.frameAt(center, moving) ?? editor.canvasId
      if (target === node.parentId) continue
      byParent.set(target, [...(byParent.get(target) ?? []), id])
    }
    for (const [parentId, members] of byParent) editor.reparent(tx, members, parentId)
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

// ---- ドラッグで箱を作るツール（図形・フレーム）の共通部分 ----

interface BoxCreation<P extends object> {
  start: ToolPointer
  tx: Transaction<NodeRecord>
  node: NodeRecord<P>
  parentId: string
  // 親のローカル座標でのドラッグの始点
  startLocal: Vec
}

// 親のローカル座標で、始点から今の点までの箱（Shift で正方形にする）
function dragBox<P extends object>(editor: Editor, creating: BoxCreation<P>, pointer: ToolPointer): Box {
  let end = editor.worldToParent(creating.parentId, pointer.world)
  if (pointer.shiftKey) {
    const dx = end.x - creating.startLocal.x
    const dy = end.y - creating.startLocal.y
    const size = Math.max(Math.abs(dx), Math.abs(dy))
    end = { x: creating.startLocal.x + Math.sign(dx || 1) * size, y: creating.startLocal.y + Math.sign(dy || 1) * size }
  }
  return boxFromPoints(creating.startLocal, end)
}

// ---- 図形ツール（矩形・楕円） ----

export class GeoTool implements Tool {
  readonly id: 'rect' | 'ellipse'
  readonly cursor = 'crosshair'
  private creating: BoxCreation<GeoProps> | null = null
  private readonly ctx: ToolContext

  constructor(ctx: ToolContext, shape: 'rect' | 'ellipse') {
    this.ctx = ctx
    this.id = shape
  }

  onPointerDown(pointer: ToolPointer): void {
    if (pointer.button !== 0) return
    const editor = this.ctx.editor
    const { parentId, local } = placeAt(editor, pointer.world)
    const tx = editor.begin(`create ${this.id}`)
    const node = editor.makeNode('geo', {
      x: local.x,
      y: local.y,
      parentId,
      props: { shape: this.id, w: 1, h: 1 },
    }) as NodeRecord<GeoProps>
    tx.put(node)
    tx.flush()
    editor.setSelection([node.id])
    this.ctx.lift([node.id])
    this.creating = { start: pointer, tx, node, parentId, startLocal: local }
  }

  onPointerMove(pointer: ToolPointer): void {
    const creating = this.creating
    if (!creating) return
    const box = dragBox(this.ctx.editor, creating, pointer)
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
        x: creating.startLocal.x - GEO_DEFAULT_SIZE / 2,
        y: creating.startLocal.y - GEO_DEFAULT_SIZE / 2,
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

// ---- フレームツール（F）（MAI-25） ----

const FRAME_DEFAULT_W = 320
const FRAME_DEFAULT_H = 240

export class FrameTool implements Tool {
  readonly id = 'frame' as const
  readonly cursor = 'crosshair'
  private creating: BoxCreation<FrameProps> | null = null
  private readonly ctx: ToolContext

  constructor(ctx: ToolContext) {
    this.ctx = ctx
  }

  onPointerDown(pointer: ToolPointer): void {
    if (pointer.button !== 0) return
    const editor = this.ctx.editor
    const { parentId, local } = placeAt(editor, pointer.world)
    const count = [...editor.store.values()].filter((n) => n.type === 'frame').length
    const tx = editor.begin('create frame')
    const node = editor.makeNode('frame', {
      x: local.x,
      y: local.y,
      parentId,
      props: { w: 1, h: 1, name: `フレーム ${count + 1}` },
    }) as NodeRecord<FrameProps>
    tx.put(node)
    tx.flush()
    editor.setSelection([node.id])
    this.creating = { start: pointer, tx, node, parentId, startLocal: local }
  }

  onPointerMove(pointer: ToolPointer): void {
    const creating = this.creating
    if (!creating) return
    const box = dragBox(this.ctx.editor, creating, pointer)
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
    const editor = this.ctx.editor
    if (dist(pointer.screen, creating.start.screen) < DRAG_THRESHOLD_PX) {
      creating.tx.put({
        ...creating.node,
        x: creating.startLocal.x - FRAME_DEFAULT_W / 2,
        y: creating.startLocal.y - FRAME_DEFAULT_H / 2,
        props: { ...creating.node.props, w: FRAME_DEFAULT_W, h: FRAME_DEFAULT_H },
      })
      creating.tx.flush()
    }
    // 作ったフレームの中にすっぽり入っている、同じ親のノードを子にする
    const frameEntry = editor.index.get(creating.node.id)
    if (frameEntry) {
      const inside = editor.index.childrenOf(creating.parentId).filter((id) => {
        if (id === creating.node.id) return false
        const entry = editor.index.get(id)
        return entry && !entry.node.locked && containsBox(frameEntry.worldBounds, entry.worldBounds)
      })
      editor.reparent(creating.tx, inside, creating.node.id)
    }
    editor.finish(creating.tx)
    this.ctx.setTool('select')
  }

  cancel(): boolean {
    const creating = this.creating
    if (!creating) return false
    this.creating = null
    creating.tx.cancel()
    return true
  }

  onExit(): void {
    this.cancel()
  }
}

function containsBox(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
  )
}

// ---- テキストツール（T）と付箋ツール（N）（MAI-24） ----

// クリックした位置にテキストを作り、そのまま編集する（クリックした点が 1 行目の中ほどに来るようにする）
function createTextAt(ctx: ToolContext, point: Vec, tx?: Transaction<NodeRecord>): void {
  const editor = ctx.editor
  const { parentId, local } = placeAt(editor, point)
  const transaction = tx ?? editor.begin('create text')
  const draft = editor.makeNode('text', { x: local.x, y: local.y, parentId }) as NodeRecord<TextProps>
  const lineHeight = textLayout(draft.props).lineHeightPx
  const node = { ...draft, y: local.y - lineHeight / 2 }
  transaction.put(node)
  ctx.startEditing(node.id, { tx: transaction })
}

export class TextTool implements Tool {
  readonly id = 'text' as const
  readonly cursor = 'text'
  private creating: { start: ToolPointer; tx: Transaction<NodeRecord>; node: NodeRecord<TextProps>; parentId: string } | null =
    null
  private readonly ctx: ToolContext

  constructor(ctx: ToolContext) {
    this.ctx = ctx
  }

  onPointerDown(pointer: ToolPointer): void {
    if (pointer.button !== 0) return
    const editor = this.ctx.editor
    const { parentId, local } = placeAt(editor, pointer.world)
    const tx = editor.begin('create text')
    const draft = editor.makeNode('text', { x: local.x, y: local.y, parentId }) as NodeRecord<TextProps>
    const node = { ...draft, y: local.y - textLayout(draft.props).lineHeightPx / 2 }
    tx.put(node)
    tx.flush()
    this.creating = { start: pointer, tx, node, parentId }
  }

  onPointerMove(pointer: ToolPointer): void {
    const creating = this.creating
    if (!creating || dist(pointer.screen, creating.start.screen) < DRAG_THRESHOLD_PX) return
    // ドラッグしたら、その幅で折り返すテキストにする
    const editor = this.ctx.editor
    const start = editor.worldToParent(creating.parentId, creating.start.world)
    const end = editor.worldToParent(creating.parentId, pointer.world)
    const x = Math.min(start.x, end.x)
    const w = Math.max(Math.abs(end.x - start.x), 16)
    creating.tx.put({ ...creating.node, x, props: { ...creating.node.props, w, autoWidth: false } })
    creating.tx.flush()
  }

  // 編集モードには、手を離してから入る（押した瞬間だと、ブラウザの既定の動作でフォーカスが移ってしまう）
  onPointerUp(): void {
    const creating = this.creating
    if (!creating) return
    this.creating = null
    this.ctx.setTool('select')
    this.ctx.startEditing(creating.node.id, { tx: creating.tx })
  }

  cancel(): boolean {
    const creating = this.creating
    if (!creating) return false
    this.creating = null
    creating.tx.cancel()
    return true
  }

  onExit(): void {
    this.cancel()
  }
}

export class NoteTool implements Tool {
  readonly id = 'note' as const
  readonly cursor = 'crosshair'
  private creating: { tx: Transaction<NodeRecord>; node: NodeRecord<NoteProps> } | null = null
  private readonly ctx: ToolContext

  constructor(ctx: ToolContext) {
    this.ctx = ctx
  }

  // クリックした位置を中心に付箋を作る
  onPointerDown(pointer: ToolPointer): void {
    if (pointer.button !== 0) return
    const editor = this.ctx.editor
    const { parentId, local } = placeAt(editor, pointer.world)
    const tx = editor.begin('create note')
    const draft = editor.makeNode('note', { x: 0, y: 0, parentId }) as NodeRecord<NoteProps>
    const node = { ...draft, x: local.x - draft.props.w / 2, y: local.y - draft.props.h / 2 }
    tx.put(node)
    tx.flush()
    this.creating = { tx, node }
  }

  // 編集モードには、手を離してから入る。押した瞬間に入ると、そのあとのブラウザの既定の動作で
  // フォーカスがキャンバスに移り、textarea からフォーカスが外れて編集が終わってしまう
  onPointerUp(): void {
    const creating = this.creating
    if (!creating) return
    this.creating = null
    this.ctx.setTool('select')
    this.ctx.startEditing(creating.node.id, { tx: creating.tx })
  }

  cancel(): boolean {
    const creating = this.creating
    if (!creating) return false
    this.creating = null
    creating.tx.cancel()
    return true
  }

  onExit(): void {
    this.cancel()
  }
}
