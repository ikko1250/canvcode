import { fitBox, panBy, screenToWorld, unionBoxes, zoomAt, type Camera, type Vec } from '@canvcode/core'
import { AssetManager, isSupportedImage } from './assets.ts'
import {
  CLIPBOARD_MIME,
  copySelection,
  duplicateSelection,
  insertImages,
  insertPayload,
  insertText,
  parsePayload,
  payloadText,
  payloadToHtml,
  type ClipboardPayload,
} from './clipboard.ts'
import type { Editor } from './editor.ts'
import { drawGrid } from './grid.ts'
import { isEditableKeyboardTarget, isImeEvent } from './imeGuard.ts'
import { clearCanvas, drawOverlay, drawScene, type Viewport } from './renderer.ts'
import type { SessionState, ToolId } from './session.ts'
import { ImageCache } from './imageCache.ts'
import { FrameStats, type StatsSummary } from './stats.ts'
import { TextEditor } from './textEditor.ts'
import {
  ArrowTool,
  DrawTool,
  EraserTool,
  FrameTool,
  GeoTool,
  HandTool,
  NoteTool,
  SelectTool,
  TextTool,
  type Tool,
  type ToolContext,
  type ToolPointer,
} from './tools.ts'

// キャンバスの表示と入力（MAI-5、MAI-6、MAI-12）。
// レイヤーは下から、背景（グリッド）・シーン・オーバーレイの 3 枚の Canvas と、編集用の DOM。
// 変更があったレイヤーだけを、requestAnimationFrame でまとめて描き直す。

export interface CanvasViewOptions {
  // 'pan'：ホイールでパン、Ctrl（⌘）+ホイールでズーム（既定）/ 'zoom'：ホイールで常にズーム（MAI-6）
  wheelBehavior?: 'pan' | 'zoom'
  gridColors?: { minor: string; major: string }
  // 画像の Asset（MAI-26）。渡さなければ、このビューが自分で作る
  assets?: AssetManager
  // 画面に短く知らせる（受け付けないファイルをドロップしたときなど）
  notify?: (message: string) => void
}

// 1 回のホイールイベントで変える倍率の上限。マウスの 1 段で約 0.67 倍になる
const MAX_WHEEL_ZOOM_DELTA = 40
const WHEEL_ZOOM_SPEED = 0.01
const LINE_HEIGHT_PX = 16
const NUDGE = 1
const NUDGE_LARGE = 10
// 複製したノードをずらす量（CSS ピクセル）
const DUPLICATE_OFFSET_PX = 16
// 貼り付けた画像を、画面のこの割合に収まるよう縮める
const IMAGE_FIT_RATIO = 0.8

type Layer = 'grid' | 'scene' | 'overlay'

export class CanvasView {
  readonly editor: Editor
  readonly root: HTMLDivElement
  // 編集モードのノードの DOM を置くレイヤー（MAI-9。段階 4 以降で使う）
  readonly editingLayer: HTMLDivElement
  private readonly options: Required<Omit<CanvasViewOptions, 'assets'>>
  readonly assets: AssetManager
  private readonly gridCanvas: HTMLCanvasElement
  private readonly sceneCanvas: HTMLCanvasElement
  private readonly overlayCanvas: HTMLCanvasElement
  private readonly gridCtx: CanvasRenderingContext2D
  private readonly sceneCtx: CanvasRenderingContext2D
  private readonly overlayCtx: CanvasRenderingContext2D
  private width = 0
  private height = 0
  private dpr = 1
  private readonly dirty = new Set<Layer>(['grid', 'scene', 'overlay'])
  private frameHandle: number | null = null
  private lifted = new Set<string>()
  private readonly tools: Map<ToolId, Tool>
  private tool: Tool
  private spaceHeld = false
  private cursorOverride: string | null = null
  private panPointer: { id: number; last: { x: number; y: number } } | null = null
  private gestureScale = 1
  // 時間のかかる画像（Markdown カードなど）のキャッシュ。作れたらシーンを描き直す（MAI-22）
  readonly images = new ImageCache({ onReady: () => this.invalidate('scene') })
  private readonly stats = new FrameStats()
  private lastDrawnNodes = 0
  private readonly frameCallbacks = new Set<(now: number) => void>()
  // 文字の編集モード（MAI-24）
  readonly textEditor: TextEditor
  private readonly disposers: (() => void)[] = []
  // 最後にポインタがあった位置（画面座標）。Shift を押しながらの貼り付けに使う
  private pointerScreen: Vec | null = null
  private pasteAtPointer = false
  // このタブで最後にコピーしたもの。プレーンテキストでしか貼り付けられなかったとき（Ctrl+Shift+V など）に使う
  private lastCopied: { payload: ClipboardPayload; text: string } | null = null

  constructor(editor: Editor, container: HTMLElement, options: CanvasViewOptions = {}) {
    this.editor = editor
    this.options = {
      wheelBehavior: options.wheelBehavior ?? 'pan',
      gridColors: options.gridColors ?? { minor: '#eef0f3', major: '#dde1e7' },
      notify: options.notify ?? ((message) => console.warn(message)),
    }
    this.assets = options.assets ?? new AssetManager({ notify: this.options.notify })

    this.root = document.createElement('div')
    this.root.tabIndex = 0
    Object.assign(this.root.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'hidden',
      touchAction: 'none',
      userSelect: 'none',
      outline: 'none',
    })
    const makeCanvas = () => {
      const canvas = document.createElement('canvas')
      Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' })
      this.root.appendChild(canvas)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas2D is not available')
      return [canvas, ctx] as const
    }
    ;[this.gridCanvas, this.gridCtx] = makeCanvas()
    ;[this.sceneCanvas, this.sceneCtx] = makeCanvas()
    ;[this.overlayCanvas, this.overlayCtx] = makeCanvas()
    this.editingLayer = document.createElement('div')
    Object.assign(this.editingLayer.style, { position: 'absolute', inset: '0', pointerEvents: 'none' })
    this.root.appendChild(this.editingLayer)
    container.appendChild(this.root)

    const toolContext: ToolContext = {
      editor,
      setTool: (id) => editor.session.set({ toolId: id }),
      lift: (ids) => this.lift(ids),
      drop: () => this.drop(),
      setCursor: (cursor) => {
        if (this.cursorOverride === cursor) return
        this.cursorOverride = cursor
        this.updateCursor()
      },
      startEditing: (nodeId, options) => this.textEditor.start(nodeId, options),
    }
    this.textEditor = new TextEditor({
      editor,
      layer: this.editingLayer,
      getDpr: () => this.dpr,
      onChange: (editingId) => {
        editor.session.set({ editingId })
        this.invalidate('scene')
        this.invalidate('overlay')
        // 編集を終えたら、キャンバスにフォーカスを戻す（ショートカットが効くように）
        if (!editingId) this.root.focus({ preventScroll: true })
      },
    })
    this.tools = new Map<ToolId, Tool>([
      ['select', new SelectTool(toolContext)],
      ['hand', new HandTool(toolContext)],
      ['rect', new GeoTool(toolContext, 'rect')],
      ['ellipse', new GeoTool(toolContext, 'ellipse')],
      ['text', new TextTool(toolContext)],
      ['note', new NoteTool(toolContext)],
      ['frame', new FrameTool(toolContext)],
      ['draw', new DrawTool(toolContext)],
      ['eraser', new EraserTool(toolContext)],
      ['arrow', new ArrowTool(toolContext)],
    ])
    this.tool = this.tools.get(editor.session.get().toolId)!

    this.disposers.push(
      editor.session.subscribe((state, prev) => this.onSessionChange(state, prev)),
      editor.store.listen((event) => {
        // ドラッグやリサイズの最中（途中経過）は、カメラが動いているときと同じく画像を作り直さない
        if (event.phase === 'progress' && editor.store.activeTransaction) this.images.notifyMotion()
        // 編集中のノードが（Undo などで）変わったら、textarea の位置を合わせ直す
        if (this.textEditor?.editingId && event.patch.has(this.textEditor.editingId)) this.textEditor.layout()
        let sceneChanged = false
        for (const id of event.patch.keys()) {
          if (!this.lifted.has(id)) {
            sceneChanged = true
            break
          }
        }
        if (sceneChanged) this.invalidate('scene')
        this.invalidate('overlay')
      }),
    )

    this.listen(this.root, 'pointerdown', (e) => this.onPointerDown(e))
    this.listen(this.root, 'pointermove', (e) => this.onPointerMove(e))
    this.listen(this.root, 'pointerup', (e) => this.onPointerUp(e))
    this.listen(this.root, 'pointercancel', (e) => this.onPointerUp(e))
    this.listen(this.root, 'pointerleave', () => {
      if (editor.session.get().hoveredId) editor.session.set({ hoveredId: null })
    })
    this.listen(this.root, 'wheel', (e) => this.onWheel(e), { passive: false })
    this.listen(this.root, 'contextmenu', (e) => e.preventDefault())
    this.listen(this.root, 'dblclick', (e) => {
      if (this.panPointer || this.spaceHeld) return
      this.tool.onDoubleClick?.(this.toPointer(e))
    })
    // Safari のトラックパッドのピンチは wheel ではなく gesture イベントで届く
    this.listen(this.root, 'gesturestart' as keyof HTMLElementEventMap, (e) => this.onGesture(e, 'start'))
    this.listen(this.root, 'gesturechange' as keyof HTMLElementEventMap, (e) => this.onGesture(e, 'change'))
    // クリップボード（MAI-26）。キーの操作ではなく copy / cut / paste のイベントで受けると、
    // 権限を求められずに読み書きできる
    this.listen(window, 'copy', (e) => this.onCopy(e, false))
    this.listen(window, 'cut', (e) => this.onCopy(e, true))
    this.listen(window, 'paste', (e) => void this.onPaste(e))
    this.listen(this.root, 'dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    })
    this.listen(this.root, 'drop', (e) => void this.onDrop(e))
    this.listen(window, 'keydown', (e) => this.onKeyDown(e))
    this.listen(window, 'keyup', (e) => this.onKeyUp(e))
    this.listen(window, 'blur', () => this.setSpaceHeld(false))

    const resizeObserver = new ResizeObserver(() => this.resize())
    resizeObserver.observe(this.root)
    this.disposers.push(() => resizeObserver.disconnect())
    this.resize()
    this.updateCursor()
    // 開いただけで Space+ドラッグが効くように、最初からフォーカスを置く（MAI-12）
    this.root.focus({ preventScroll: true })
  }

  dispose(): void {
    this.textEditor.finish()
    this.tool.onExit?.()
    this.images.dispose()
    for (const dispose of this.disposers) dispose()
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle)
    this.root.remove()
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height }
  }

  setCamera(camera: Camera): void {
    this.editor.session.set({ camera })
  }

  // すべてのノードが画面に収まるようにする（Shift+1）
  zoomToFit(): void {
    const bounds = unionBoxes(
      this.editor.index.allIds().flatMap((id) => {
        const entry = this.editor.index.get(id)
        return entry ? [entry.worldBounds] : []
      }),
    )
    if (bounds) this.setCamera(fitBox(bounds, this.width, this.height))
  }

  getStats(): StatsSummary {
    return this.stats.summary(this.editor.index.size)
  }

  resetStats(): void {
    this.stats.reset()
  }

  // 毎フレーム、描画の直前に呼ばれる処理を登録する（ベンチマークなど）
  onFrame(callback: (now: number) => void): () => void {
    this.frameCallbacks.add(callback)
    this.requestFrame()
    return () => this.frameCallbacks.delete(callback)
  }

  invalidate(layer: Layer | 'all' = 'all'): void {
    if (layer === 'all') {
      this.dirty.add('grid').add('scene').add('overlay')
    } else {
      this.dirty.add(layer)
    }
    this.requestFrame()
  }

  // ---- 描画 ----

  private requestFrame(): void {
    if (this.frameHandle !== null) return
    this.frameHandle = requestAnimationFrame((now) => this.frame(now))
  }

  private frame(now: number): void {
    this.frameHandle = null
    for (const callback of this.frameCallbacks) callback(now)
    if (this.frameCallbacks.size > 0) this.requestFrame()
    if (this.dirty.size === 0) return

    const start = performance.now()
    const view = this.viewport()
    let drawn = 0
    if (this.dirty.has('grid')) {
      clearCanvas(this.gridCtx)
      drawGrid(this.gridCtx, view.camera, view.width, view.height, view.dpr, this.options.gridColors)
    }
    if (this.dirty.has('scene')) {
      this.images.beginFrame()
      drawn += drawScene(this.sceneCtx, this.editor, view, this.lifted)
      this.images.endFrame()
    }
    if (this.dirty.has('overlay')) {
      const { selectedIds, hoveredId, brush, focusedGroupId } = this.editor.session.get()
      drawn += drawOverlay(this.overlayCtx, this.editor, view, {
        lifted: this.lifted,
        selectedIds,
        hoveredId,
        brush,
        focusedGroupId,
      })
    }
    // 描いたノード数は、シーンを描き直したフレームの値を表示し続ける
    if (this.dirty.has('scene')) this.lastDrawnNodes = drawn
    this.dirty.clear()
    this.stats.record(now, performance.now() - start, this.lastDrawnNodes)
  }

  private viewport(): Viewport {
    return {
      camera: this.editor.session.get().camera,
      width: this.width,
      height: this.height,
      dpr: this.dpr,
      images: this.images,
      assets: this.assets,
      editingId: this.editor.session.get().editingId,
    }
  }

  private resize(): void {
    const rect = this.root.getBoundingClientRect()
    this.width = rect.width
    this.height = rect.height
    this.dpr = window.devicePixelRatio || 1
    for (const canvas of [this.gridCanvas, this.sceneCanvas, this.overlayCanvas]) {
      canvas.width = Math.max(1, Math.round(this.width * this.dpr))
      canvas.height = Math.max(1, Math.round(this.height * this.dpr))
    }
    this.invalidate('all')
  }

  private lift(ids: Iterable<string>): void {
    // group やフレームを動かすときは、子孫も一緒にシーンから外す（行列が変わるのは子孫も同じなので）。
    // つながっている矢印も一緒に動くので、外しておく（シーンを描き直さずに済む。MAI-28）
    const lifted = new Set([...ids].flatMap((id) => [id, ...this.editor.index.descendantsOf(id)]))
    for (const id of [...lifted]) {
      for (const bindingId of this.editor.bindings.toTarget(id)) {
        const binding = this.editor.getBinding(bindingId)
        if (binding) lifted.add(binding.fromId)
      }
    }
    this.lifted = lifted
    this.invalidate('scene')
    this.invalidate('overlay')
  }

  private drop(): void {
    if (this.lifted.size === 0) return
    this.lifted = new Set()
    this.invalidate('scene')
    this.invalidate('overlay')
  }

  private onSessionChange(state: SessionState, prev: SessionState): void {
    if (state.camera !== prev.camera) {
      // カメラが動いている間は、画像を作り直さない（MAI-22）
      this.images.notifyMotion()
      this.invalidate('all')
      this.textEditor.layout()
    }
    if (
      state.selectedIds !== prev.selectedIds ||
      state.hoveredId !== prev.hoveredId ||
      state.brush !== prev.brush ||
      state.focusedGroupId !== prev.focusedGroupId
    ) {
      this.invalidate('overlay')
    }
    if (state.toolId !== prev.toolId) {
      this.tool.onExit?.()
      this.tool = this.tools.get(state.toolId)!
      this.cursorOverride = null
      this.updateCursor()
    }
  }

  // ---- 入力 ----

  private toPointer(e: PointerEvent | MouseEvent): ToolPointer {
    const rect = this.root.getBoundingClientRect()
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    return {
      screen,
      world: screenToWorld(this.editor.session.get().camera, screen),
      button: e.button,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
    }
  }

  private onPointerDown(e: PointerEvent): void {
    // 編集中にキャンバスのどこかを押したら、編集を終えてから、その操作を始める
    if (this.textEditor.editingId && e.button === 0) this.textEditor.finish()
    this.root.focus({ preventScroll: true })
    this.root.setPointerCapture(e.pointerId)
    // 中ボタン、または Space を押しながらのドラッグはパン（MAI-6）
    if (e.button === 1 || (e.button === 0 && this.spaceHeld)) {
      e.preventDefault()
      this.panPointer = { id: e.pointerId, last: { x: e.clientX, y: e.clientY } }
      this.updateCursor()
      return
    }
    this.tool.onPointerDown?.(this.toPointer(e))
  }

  private onPointerMove(e: PointerEvent): void {
    const rect = this.root.getBoundingClientRect()
    this.pointerScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    if (this.panPointer && this.panPointer.id === e.pointerId) {
      const { camera } = this.editor.session.get()
      this.setCamera(panBy(camera, e.clientX - this.panPointer.last.x, e.clientY - this.panPointer.last.y))
      this.panPointer.last = { x: e.clientX, y: e.clientY }
      return
    }
    const pointer = this.toPointer(e)
    // まとめて届いた途中の位置（速く動かしたときのフリーハンドのため。MAI-27）
    const coalesced = e.getCoalescedEvents?.() ?? []
    if (coalesced.length > 1) {
      const camera = this.editor.session.get().camera
      pointer.coalesced = coalesced.map((c) => screenToWorld(camera, { x: c.clientX - rect.left, y: c.clientY - rect.top }))
    }
    this.tool.onPointerMove?.(pointer)
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.root.hasPointerCapture(e.pointerId)) this.root.releasePointerCapture(e.pointerId)
    if (this.panPointer && this.panPointer.id === e.pointerId) {
      this.panPointer = null
      this.updateCursor()
      return
    }
    this.tool.onPointerUp?.(this.toPointer(e))
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    const scale = e.deltaMode === 1 ? LINE_HEIGHT_PX : e.deltaMode === 2 ? this.height : 1
    const dx = e.deltaX * scale
    const dy = e.deltaY * scale
    const { camera } = this.editor.session.get()
    // トラックパッドのピンチは、ブラウザが ctrlKey 付きの wheel として送ってくる
    const zoom = e.ctrlKey || e.metaKey || this.options.wheelBehavior === 'zoom'
    if (zoom) {
      const rect = this.root.getBoundingClientRect()
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      const delta = Math.max(-MAX_WHEEL_ZOOM_DELTA, Math.min(MAX_WHEEL_ZOOM_DELTA, dy))
      this.setCamera(zoomAt(camera, anchor, camera.zoom * Math.exp(-delta * WHEEL_ZOOM_SPEED)))
    } else {
      // Shift+ホイールは横方向のパン（マウスで横に動かすため）
      const [px, py] = e.shiftKey && dx === 0 ? [dy, 0] : [dx, dy]
      this.setCamera(panBy(camera, -px, -py))
    }
  }

  private onGesture(e: Event, phase: 'start' | 'change'): void {
    e.preventDefault()
    const gesture = e as Event & { scale: number; clientX: number; clientY: number }
    if (phase === 'start') {
      this.gestureScale = 1
      return
    }
    const rect = this.root.getBoundingClientRect()
    const anchor = { x: gesture.clientX - rect.left, y: gesture.clientY - rect.top }
    const { camera } = this.editor.session.get()
    this.setCamera(zoomAt(camera, anchor, (camera.zoom * gesture.scale) / this.gestureScale))
    this.gestureScale = gesture.scale
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (isImeEvent(e) || isEditableKeyboardTarget(e.target)) return
    const editor = this.editor
    const mod = e.ctrlKey || e.metaKey

    if (e.code === 'Space') {
      e.preventDefault()
      if (!e.repeat) this.setSpaceHeld(true)
      return
    }
    if (e.key === 'Escape') {
      if (this.tool.cancel()) return
      // group の中に入っていれば、group を選んで外に出る。そうでなければ選択を外す
      const focused = editor.session.get().focusedGroupId
      if (focused) {
        editor.focusGroup(null)
        editor.setSelection([focused])
      } else {
        editor.setSelection([])
      }
      return
    }
    if (mod && e.key.toLowerCase() === 'g') {
      e.preventDefault()
      this.tool.cancel()
      if (e.shiftKey) editor.ungroupSelected()
      else editor.groupSelected()
      return
    }
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      this.tool.cancel()
      if (e.shiftKey) editor.redo()
      else editor.undo()
      return
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      this.tool.cancel()
      editor.redo()
      return
    }
    if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      this.tool.cancel()
      const zoom = editor.session.get().camera.zoom
      duplicateSelection(editor, { x: DUPLICATE_OFFSET_PX / zoom, y: DUPLICATE_OFFSET_PX / zoom })
      return
    }
    if (mod && e.key.toLowerCase() === 'v') {
      // 貼り付けそのものは paste イベントで行う。ここでは Shift を押しているかだけを覚えておく
      this.pasteAtPointer = e.shiftKey
      return
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      editor.selectAll()
      return
    }
    if (e.key === 'Enter' && !mod) {
      // 文字を持つノードを 1 つだけ選んでいれば、編集モードに入る
      const [id, ...rest] = editor.session.get().selectedIds
      const node = id && rest.length === 0 ? editor.getNode(id) : undefined
      if (node && editor.getType(node).editText) {
        e.preventDefault()
        this.textEditor.start(node.id, { selectAll: true })
      }
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      editor.deleteSelected()
      return
    }
    if (e.key.startsWith('Arrow')) {
      e.preventDefault()
      const step = e.shiftKey ? NUDGE_LARGE : NUDGE
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
      editor.moveNodes(editor.session.get().selectedIds, dx, dy, 'nudge')
      return
    }
    if (e.shiftKey && e.code === 'Digit1') {
      this.zoomToFit()
      return
    }
    if (mod || e.altKey) return
    // ツールの切り替え（旧実装と同じ tldraw 風の割り当て。MAI-12）
    const toolKeys: Record<string, ToolId> = {
      v: 'select',
      h: 'hand',
      r: 'rect',
      o: 'ellipse',
      t: 'text',
      n: 'note',
      f: 'frame',
      d: 'draw',
      e: 'eraser',
      a: 'arrow',
    }
    const toolId = toolKeys[e.key.toLowerCase()]
    if (toolId) editor.session.set({ toolId })
  }

  // ---- クリップボードとファイル（MAI-26） ----

  // 文字の入力欄（編集中の textarea など）でのコピー・貼り付けは、ブラウザに任せる
  private ownsClipboardEvent(e: ClipboardEvent): boolean {
    return !isEditableKeyboardTarget(e.target) && !this.textEditor.editingId && e.clipboardData !== null
  }

  private onCopy(e: ClipboardEvent, cut: boolean): void {
    if (!this.ownsClipboardEvent(e)) return
    const payload = copySelection(this.editor, (id) => this.assets.get(id))
    if (!payload) return
    e.preventDefault()
    const text = payloadText(this.editor, payload)
    const data = e.clipboardData!
    data.setData(CLIPBOARD_MIME, JSON.stringify(payload))
    data.setData('text/html', payloadToHtml(payload))
    if (text) data.setData('text/plain', text)
    this.lastCopied = { payload, text }
    if (cut) {
      this.tool.cancel()
      this.editor.deleteSelected()
    }
  }

  private async onPaste(e: ClipboardEvent): Promise<void> {
    if (!this.ownsClipboardEvent(e)) return
    e.preventDefault()
    const data = e.clipboardData!
    const screen = this.pasteAtPointer && this.pointerScreen ? this.pointerScreen : { x: this.width / 2, y: this.height / 2 }
    this.pasteAtPointer = false
    const center = screenToWorld(this.editor.session.get().camera, screen)
    this.tool.cancel()

    // 優先順（MAI-12）：アプリ内の形式 → 画像 → 文字列。表の貼り付けは段階 10 で入れる
    const text = data.getData('text/plain')
    const files = clipboardFiles(data)
    let payload = parsePayload({ json: data.getData(CLIPBOARD_MIME), html: data.getData('text/html') })
    // プレーンテキストでしか受け取れなかったが、このタブでコピーしたものと同じなら、それを使う
    if (!payload && this.lastCopied && files.length === 0 && text === this.lastCopied.text) payload = this.lastCopied.payload
    if (payload) {
      for (const asset of payload.assets) this.assets.register(asset)
      this.editor.focusGroup(null)
      insertPayload(this.editor, payload, { center })
      return
    }
    if (files.length > 0) {
      await this.importFiles(files, center)
      return
    }
    if (text) insertText(this.editor, text, center)
  }

  private async onDrop(e: DragEvent): Promise<void> {
    const files = [...(e.dataTransfer?.files ?? [])]
    if (files.length === 0) return
    e.preventDefault()
    this.root.focus({ preventScroll: true })
    await this.importFiles(files, this.toPointer(e).world)
  }

  // 画像のファイルを Asset にして、center を中心に並べる。受け付けないファイルは、そのことを知らせる
  private async importFiles(files: File[], center: Vec): Promise<void> {
    const images = files.filter(isSupportedImage)
    const rejected = files.filter((file) => !isSupportedImage(file))
    if (rejected.length > 0) this.options.notify(rejectMessage(rejected))
    const assets = []
    for (const file of images) {
      try {
        assets.push(await this.assets.importImage(file))
      } catch (error) {
        console.error('Failed to import image', file.name, error)
        this.options.notify(`画像を読み込めませんでした：${file.name}`)
      }
    }
    const zoom = this.editor.session.get().camera.zoom
    const maxSize = { w: (this.width * IMAGE_FIT_RATIO) / zoom, h: (this.height * IMAGE_FIT_RATIO) / zoom }
    this.editor.focusGroup(null)
    insertImages(this.editor, assets, center, maxSize)
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.code === 'Space') this.setSpaceHeld(false)
  }

  private setSpaceHeld(held: boolean): void {
    if (this.spaceHeld === held) return
    this.spaceHeld = held
    this.updateCursor()
  }

  private updateCursor(): void {
    this.root.style.cursor = this.panPointer
      ? 'grabbing'
      : this.spaceHeld
        ? 'grab'
        : (this.cursorOverride ?? this.tool.cursor)
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (e: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void
  private listen<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    handler: (e: WindowEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void
  private listen(
    target: HTMLElement | Window,
    type: string,
    handler: (e: never) => void,
    options?: AddEventListenerOptions,
  ): void {
    const listener = handler as EventListener
    target.addEventListener(type, listener, options)
    this.disposers.push(() => target.removeEventListener(type, listener, options))
  }
}

// 貼り付けられたファイル。files が空でも items にファイルが入っていることがあるので、そちらも見る
function clipboardFiles(data: DataTransfer): File[] {
  if (data.files.length > 0) return [...data.files]
  return [...data.items].flatMap((item) => {
    const file = item.kind === 'file' ? item.getAsFile() : null
    return file ? [file] : []
  })
}

// 受け付けないファイルの知らせ（MAI-12 の「9. ファイルのドラッグ＆ドロップ」）
function rejectMessage(files: File[]): string {
  const names = files.map((file) => file.name).join('、')
  const later = files.every((file) => /\.(pdf|md|markdown|py|ricbackup)$/i.test(file.name))
  return later
    ? `${names}：PDF・Markdown・Python・.ricbackup の取り込みは、後の段階で対応します`
    : `${names}：取り込めない種類のファイルです（今取り込めるのは PNG・JPEG・GIF・WebP・AVIF・BMP の画像）`
}
