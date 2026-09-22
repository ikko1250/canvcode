import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import type { PortalProps } from '@canvcode/nodes'
import { makeBinding } from './bindings.ts'
import { copySelection, insertPayloadWithResult } from './clipboard.ts'
import { Editor } from './editor.ts'
import { Workspace } from './workspace.ts'

// Portal・階層・ゴミ箱・昇格（MAI-8、MAI-29）

function setup() {
  const workspace = new Workspace({ rootCanvasId: 'canvas:root' })
  const root = new Editor({ workspace })
  const open = (canvasId: string) => new Editor({ workspace, canvasId })
  const rect = (editor: Editor, x: number, y: number) => {
    const node = editor.makeNode('geo', { x, y, props: { shape: 'rect', w: 100, h: 100 } })
    editor.createNodes([node])
    return node.id
  }
  const canvas = (id: string) => workspace.getCanvas(id)!
  const portal = (id: string) => workspace.getNode(id) as NodeRecord<PortalProps> | undefined
  return { workspace, root, open, rect, canvas, portal }
}

describe('portals and the canvas tree', () => {
  it('creates a child canvas owned by the new portal, in one undo step', () => {
    const { workspace, root, canvas } = setup()
    const { portalId, canvasId } = root.createPortal({ x: 0, y: 0 })
    expect(canvas(canvasId)).toMatchObject({ parentCanvasId: 'canvas:root', ownerPortalId: portalId, title: '新しいキャンバス 1' })
    expect(workspace.childCanvases('canvas:root').map((c) => c.id)).toEqual([canvasId])
    root.undo()
    expect(workspace.getCanvas(canvasId)).toBeUndefined()
    expect(workspace.getNode(portalId)).toBeUndefined()
  })

  it('keeps each canvas to its own nodes and its own undo history', () => {
    const { root, open, rect } = setup()
    const { canvasId } = root.createPortal({ x: 0, y: 0 })
    const child = open(canvasId)
    const inChild = rect(child, 0, 0)
    expect(child.index.allIds()).toEqual([inChild])
    expect(root.index.allIds()).toHaveLength(1)
    // 親の Undo は、子での操作を取り消さない
    root.undo()
    expect(child.getNode(inChild)).toBeDefined()
  })

  it('sends the target and its descendants to the trash when the owner portal is deleted', () => {
    const { workspace, root, open, canvas, portal } = setup()
    const a = root.createPortal({ x: 0, y: 0 })
    const b = open(a.canvasId).createPortal({ x: 0, y: 0 })
    root.deleteNodes([a.portalId], { ownerPortals: 'trash' })
    expect(canvas(a.canvasId).deletedAt).not.toBeNull()
    expect(canvas(b.canvasId).deletedAt).not.toBeNull()
    expect(workspace.trashedCanvases().map((c) => c.id)).toEqual([a.canvasId])
    // 子の Canvas の中の持ち主の Portal はそのまま（元に戻すときに使う）
    expect(portal(b.portalId)).toBeDefined()
    root.undo()
    expect(canvas(a.canvasId)).toMatchObject({ deletedAt: null, ownerPortalId: a.portalId })
    expect(portal(a.portalId)).toBeDefined()
  })

  it('restores a trashed canvas with its descendants and puts the owner portal back', () => {
    const { workspace, root, open, canvas } = setup()
    const a = root.createPortal({ x: 100, y: 50 })
    const b = open(a.canvasId).createPortal({ x: 0, y: 0 })
    const before = root.getNode(a.portalId)!
    root.deleteNodes([a.portalId], { ownerPortals: 'trash' })
    root.transact('restore', (tx) => workspace.restoreCanvas(tx, a.canvasId))
    expect(canvas(a.canvasId)).toMatchObject({ deletedAt: null, trash: null, parentCanvasId: 'canvas:root', ownerPortalId: a.portalId })
    expect(canvas(b.canvasId).deletedAt).toBeNull()
    expect(root.getNode(a.portalId)).toEqual(before)
    expect(workspace.trashedCanvases()).toHaveLength(0)
  })

  it('makes the target unplaced when asked, and lets it be placed again but not inside itself', () => {
    const { workspace, root, open, canvas } = setup()
    const a = root.createPortal({ x: 0, y: 0 })
    const child = open(a.canvasId)
    const b = child.createPortal({ x: 0, y: 0 })
    root.deleteNodes([a.portalId], { ownerPortals: 'unplace' })
    expect(workspace.unplacedCanvases().map((c) => c.id)).toEqual([a.canvasId])
    // 自分の中（子孫の Canvas）には置けない
    expect(open(b.canvasId).placeCanvas(a.canvasId, { x: 0, y: 0 })).toBeNull()
    const placed = root.placeCanvas(a.canvasId, { x: 0, y: 0 })!
    expect(canvas(a.canvasId)).toMatchObject({ ownerPortalId: placed, parentCanvasId: 'canvas:root' })
  })

  it('deletes a canvas forever with its contents, leaving shortcuts to it broken', () => {
    const { workspace, root, open, rect } = setup()
    const a = root.createPortal({ x: 0, y: 0 })
    const inside = rect(open(a.canvasId), 0, 0)
    root.setSelection([a.portalId])
    insertPayloadWithResult(root, copySelection(root)!, { offset: { x: 300, y: 0 } })
    const shortcut = [...root.session.get().selectedIds][0]
    expect((root.getNode(shortcut)!.props as PortalProps).role).toBe('shortcut')
    root.deleteNodes([a.portalId], { ownerPortals: 'trash' })
    expect(workspace.targetStatus(a.canvasId)).toBe('trashed')
    root.transact('forever', (tx) => workspace.deleteCanvasForever(tx, a.canvasId))
    expect(workspace.targetStatus(a.canvasId)).toBe('missing')
    expect(workspace.getNode(inside)).toBeUndefined()
    expect(root.getNode(shortcut)).toBeDefined()
  })
})

describe('copying and moving portals', () => {
  it('pastes a copied owner portal as a shortcut', () => {
    const { root, canvas } = setup()
    const a = root.createPortal({ x: 0, y: 0 })
    root.setSelection([a.portalId])
    const { ids } = insertPayloadWithResult(root, copySelection(root)!, { offset: { x: 300, y: 0 } })
    expect((root.getNode(ids[0])!.props as PortalProps).role).toBe('shortcut')
    expect(canvas(a.canvasId).ownerPortalId).toBe(a.portalId)
  })

  it('moves a canvas when its owner portal is cut and pasted elsewhere', () => {
    const { root, open, canvas } = setup()
    const a = root.createPortal({ x: 0, y: 0 })
    const b = root.createPortal({ x: 400, y: 0 })
    root.setSelection([a.portalId])
    const payload = copySelection(root)!
    root.deleteNodes([a.portalId], { ownerPortals: 'unplace', label: 'cut' })
    const target = open(b.canvasId)
    const { ids, refusedOwners } = insertPayloadWithResult(target, payload, { center: { x: 0, y: 0 } })
    expect(refusedOwners).toEqual([])
    expect(canvas(a.canvasId)).toMatchObject({ ownerPortalId: ids[0], parentCanvasId: b.canvasId })
  })

  it('refuses to move a canvas into itself, pasting a shortcut instead', () => {
    const { root, open, canvas } = setup()
    const a = root.createPortal({ x: 0, y: 0 })
    root.setSelection([a.portalId])
    const payload = copySelection(root)!
    root.deleteNodes([a.portalId], { ownerPortals: 'unplace', label: 'cut' })
    const { ids, refusedOwners } = insertPayloadWithResult(open(a.canvasId), payload, { center: { x: 0, y: 0 } })
    expect(refusedOwners).toEqual([a.canvasId])
    expect((open(a.canvasId).getNode(ids[0])!.props as PortalProps).role).toBe('shortcut')
    expect(canvas(a.canvasId).ownerPortalId).toBeNull()
  })
})

describe('promoting a selection to a canvas', () => {
  it('moves the selection into a new canvas behind a portal, unbinding arrows that cross', () => {
    const { workspace, root, open, rect, canvas } = setup()
    const x = rect(root, 0, 0)
    const y = rect(root, 300, 0)
    const stay = rect(root, 600, 0)
    const inner = root.createPortal({ x: 150, y: 400 })
    const arrow = root.makeNode('arrow', { x: 0, y: 0 })
    root.transact('arrow', (tx) => {
      tx.put(arrow)
      tx.put(makeBinding(arrow.id, x, { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false }))
      tx.put(makeBinding(arrow.id, stay, { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false }))
    })
    const before = root.index.get(x)!.worldBounds
    root.setSelection([x, y, inner.portalId, arrow.id])
    const { portalId, canvasId } = root.promoteSelection()!
    const child = open(canvasId)
    expect(new Set(child.index.allIds())).toEqual(new Set([x, y, inner.portalId, arrow.id]))
    expect(root.index.allIds().sort()).toEqual([stay, portalId].sort())
    expect(child.index.get(x)!.worldBounds).toEqual(before)
    // 選択に含まれていた持ち主の Portal の参照先は、新しい Canvas の子になる
    expect(canvas(inner.canvasId).parentCanvasId).toBe(canvasId)
    expect(canvas(canvasId)).toMatchObject({ parentCanvasId: 'canvas:root', ownerPortalId: portalId })
    // 残ったノードへのつながりは外れ、一緒に移ったノードへのつながりは残る
    expect(workspace.bindingsOfArrow(arrow.id).map((b) => b.toId)).toEqual([x])
    root.undo()
    expect(root.index.allIds()).toContain(x)
    expect(workspace.getCanvas(canvasId)).toBeUndefined()
    expect(canvas(inner.canvasId).parentCanvasId).toBe('canvas:root')
    expect(workspace.bindingsOfArrow(arrow.id)).toHaveLength(2)
  })
})
