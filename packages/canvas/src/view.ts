import { fitBox, panBy, screenToWorld, unionBoxes, zoomAt, type Camera } from '@canvcode/core'
import type { Editor } from './editor.ts'
import { drawGrid } from './grid.ts'
import { isEditableKeyboardTarget, isImeEvent } from './imeGuard.ts'
import { clearCanvas, drawOverlay, drawScene, type Viewport } from './renderer.ts'
import type { SessionState, ToolId } from './session.ts'
import { ImageCache } from './imageCache.ts'
import { FrameStats, type StatsSummary } from './stats.ts'
import { GeoTool, HandTool, SelectTool, type Tool, type ToolContext, type ToolPointer } from './tools.ts'

// キャンバスの表示と入力（MAI-5、MAI-6、MAI-12）。
// レイヤーは下から、背景（グリッド）・シーン・オーバーレイの 3 枚の Canvas と、編集用の DOM。
// 変更があったレイヤーだけを、requestAnimationFrame でまとめて描き直す。

export interface CanvasViewOptions {
  // 'pan'：ホイールでパン、Ctrl（⌘）+ホイールでズーム（既定）/ 'zoom'：ホイールで常にズーム（MAI-6）
  wheelBehavior?: 'pan' | 'zoom'
  gridColors?: { minor: string; major: string }
}

// 1 回のホイールイベントで変える倍率の上限。マウスの 1 段で約 0.67 倍になる
const MAX_WHEEL_ZOOM_DELTA = 40
const WHEEL_ZOOM_SPEED = 0.01
const LINE_HEIGHT_PX = 16
const NUDGE = 1
const NUDGE_LARGE = 10

type Layer = 'grid' | 'scene' | 'overlay'

export class CanvasView {
  readonly editor: Editor
  readonly root: HTMLDivElement
  // 編集モードのノードの DOM を置くレイヤー（MAI-9。段階 4 以降で使う）
  readonly editingLayer: HTMLDivElement
  private readonly options: Required<CanvasViewOptions>
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
  private readonly disposers: (() => void)[] = []

  constructor(editor: Editor, container: HTMLElement, options: CanvasViewOptions = {}) {
    this.editor = editor
    this.options = {
      wheelBehavior: options.wheelBehavior ?? 'pan',
      gridColors: options.gridColors ?? { minor: '#eef0f3', major: '#dde1e7' },
    }

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
    }
    this.tools = new Map<ToolId, Tool>([
      ['select', new SelectTool(toolContext)],
      ['hand', new HandTool(toolContext)],
      ['rect', new GeoTool(toolContext, 'rect')],
      ['ellipse', new GeoTool(toolContext, 'ellipse')],
    ])
    this.tool = this.tools.get(editor.session.get().toolId)!

    this.disposers.push(
      editor.session.subscribe((state, prev) => this.onSessionChange(state, prev)),
      editor.store.listen((event) => {
        // ドラッグやリサイズの最中（途中経過）は、カメラが動いているときと同じく画像を作り直さない
        if (event.phase === 'progress' && editor.store.activeTransaction) this.images.notifyMotion()
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
    // Safari のトラックパッドのピンチは wheel ではなく gesture イベントで届く
    this.listen(this.root, 'gesturestart' as keyof HTMLElementEventMap, (e) => this.onGesture(e, 'start'))
    this.listen(this.root, 'gesturechange' as keyof HTMLElementEventMap, (e) => this.onGesture(e, 'change'))
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
      const { selectedIds, hoveredId } = this.editor.session.get()
      drawn += drawOverlay(this.overlayCtx, this.editor, view, { lifted: this.lifted, selectedIds, hoveredId })
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
    this.lifted = new Set(ids)
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
    }
    if (state.selectedIds !== prev.selectedIds || state.hoveredId !== prev.hoveredId) this.invalidate('overlay')
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
    if (this.panPointer && this.panPointer.id === e.pointerId) {
      const { camera } = this.editor.session.get()
      this.setCamera(panBy(camera, e.clientX - this.panPointer.last.x, e.clientY - this.panPointer.last.y))
      this.panPointer.last = { x: e.clientX, y: e.clientY }
      return
    }
    this.tool.onPointerMove?.(this.toPointer(e))
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
      if (!this.tool.cancel()) editor.setSelection([])
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
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      editor.selectAll()
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
    const toolKeys: Record<string, ToolId> = { v: 'select', h: 'hand', r: 'rect', o: 'ellipse' }
    const toolId = toolKeys[e.key.toLowerCase()]
    if (toolId) editor.session.set({ toolId })
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
