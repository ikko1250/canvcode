import { applyMat, dist, invert, worldToScreen, type Transaction, type Vec, type WorkspaceRecord } from '@canvcode/core'
import { triangleApexOf, type GeoNode } from '@canvcode/nodes'
import { BLOCK_ARROW_HANDLE_HIT_PX, BLOCK_ARROW_HANDLE_MIN_SIZE_PX } from './blockArrowHandles.ts'
import { cropEditingTarget } from './cropHandles.ts'
import { nodeIn, type Editor } from './editor.ts'
import { paintEditingTarget } from './gradientHandles.ts'

// リサイズは中心から 8px、調整ハンドルは 6px まで当たる。
const TRIANGLE_HANDLE_INSET_PX = 16

export function triangleHandle(editor: Editor): { nodeId: string; point: Vec } | null {
  const { selectedIds, editingId, camera } = editor.session.get()
  if (editingId || selectedIds.size !== 1 || paintEditingTarget(editor) || cropEditingTarget(editor)) return null
  const [nodeId] = selectedIds
  const entry = editor.index.get(nodeId)
  if (!entry || entry.node.locked || entry.node.type !== 'geo') return null
  const { props } = entry.node as GeoNode
  if (props.shape !== 'triangle' || Math.min(props.w, props.h) * camera.zoom < BLOCK_ARROW_HANDLE_MIN_SIZE_PX) return null
  const inset = TRIANGLE_HANDLE_INSET_PX / camera.zoom
  // 頂点が端にあっても、選択枠のリサイズハンドルから離して表示する。
  const local = { x: inset + (props.w - 2 * inset) * triangleApexOf(props), y: inset }
  return { nodeId, point: worldToScreen(camera, applyMat(entry.worldMatrix, local)) }
}

export function hitTriangleHandle(editor: Editor, screen: Vec) {
  const handle = triangleHandle(editor)
  return handle && dist(handle.point, screen) <= BLOCK_ARROW_HANDLE_HIT_PX ? handle : null
}

export function startTriangleHandleDrag(editor: Editor, tx: Transaction<WorkspaceRecord>, nodeId: string, world: Vec) {
  const entry = editor.index.get(nodeId)!
  const { props } = entry.node as GeoNode
  const inverse = invert(entry.worldMatrix)
  const startX = applyMat(inverse, world).x
  const startApex = triangleApexOf(props)
  const trackWidth = props.w - 2 * TRIANGLE_HANDLE_INSET_PX / editor.session.get().camera.zoom
  return {
    move(world: Vec): void {
      const node = nodeIn(tx, nodeId) as GeoNode | undefined
      if (!node) return
      const delta = (applyMat(inverse, world).x - startX) / trackWidth
      // 回転している図形でも、上辺に沿ったドラッグだけを使う。
      const value = startApex + delta
      const apex = Math.max(0, Math.min(1, Math.round(value * 1e4) / 1e4))
      const triangleApex = Math.abs(delta) < 1e-8 || apex === startApex ? props.triangleApex : apex
      if (triangleApex === node.props.triangleApex) return
      const next = { ...node.props, triangleApex }
      if (triangleApex === undefined) delete next.triangleApex
      tx.put({ ...node, props: next })
      tx.flush()
    },
  }
}
