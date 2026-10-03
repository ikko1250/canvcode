import { useEffect } from 'react'
import { screenToWorld, type Camera } from '@canvcode/core'
import type { CanvasView, Editor, SyncClient, Viewport } from '@canvcode/canvas'

// いま見ている Canvas と範囲をサーバーに知らせる（AI のツールが、ユーザーの見ている所を既定にする）。
// カメラが動くたび・窓の大きさが変わるたびに SyncClient.reportPresence に渡す。送る間隔は SyncClient が決める
export function usePresence(sync: SyncClient, view: CanvasView | null, editor: Editor): void {
  useEffect(() => {
    if (!view) return
    const report = () => {
      const { width, height } = view.size
      if (width <= 0 || height <= 0) return
      sync.reportPresence(editor.canvasId, viewportOf(editor.session.get().camera, width, height))
    }
    report()
    const unsubscribe = editor.session.subscribe((state, prev) => {
      if (state.camera !== prev.camera) report()
    })
    window.addEventListener('resize', report)
    return () => {
      unsubscribe()
      window.removeEventListener('resize', report)
    }
  }, [sync, view, editor])
}

// 画面（width x height の CSS px）に見えている範囲（ワールド座標）
export function viewportOf(camera: Camera, width: number, height: number): Viewport {
  const topLeft = screenToWorld(camera, { x: 0, y: 0 })
  return { x: topLeft.x, y: topLeft.y, w: width / camera.zoom, h: height / camera.zoom }
}
