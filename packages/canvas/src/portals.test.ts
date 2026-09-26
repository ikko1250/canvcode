import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import type { PortalProps } from '@canvcode/nodes'
import { makeBinding } from './bindings.ts'
import { copySelection, insertPayloadWithResult } from './clipboard.ts'
import { Editor } from './editor.ts'
import { SelectTool, type ToolContext, type ToolPointer } from './tools.ts'
import { Workspace } from './workspace.ts'

// Portal・階層・ゴミ箱・昇格・子キャンバス・親キャンバスへの移動（MAI-8、MAI-29、MAI-38、MAI-69）

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
    expect(canvas(canvasId)).toMatchObject({ parentCanvasId: 'canvas:root', ownerNodeId: portalId, title: '新しいキャンバス 1' })
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
    expect(canvas(a.canvasId)).toMatchObject({ deletedAt: null, ownerNodeId: a.portalId })
    expect(portal(a.portalId)).toBeDefined()
  })

  it('restores a trashed canvas with its descendants and puts the owner portal back', () => {
    const { workspace, root, open, canvas } = setup()
    const a = root.createPortal({ x: 100, y: 50 })
    const b = open(a.canvasId).createPortal({ x: 0, y: 0 })
    const before = root.getNode(a.portalId)!
    root.deleteNodes([a.portalId], { ownerPortals: 'trash' })
    root.transact('restore', (tx) => workspace.restoreCanvas(tx, a.canvasId))
    expect(canvas(a.canvasId)).toMatchObject({ deletedAt: null, trash: null, parentCanvasId: 'canvas:root', ownerNodeId: a.portalId })
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
    expect(canvas(a.canvasId)).toMatchObject({ ownerNodeId: placed, parentCanvasId: 'canvas:root' })
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
    expect(canvas(a.canvasId).ownerNodeId).toBe(a.portalId)
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
    expect(canvas(a.canvasId)).toMatchObject({ ownerNodeId: ids[0], parentCanvasId: b.canvasId })
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
    expect(canvas(a.canvasId).ownerNodeId).toBeNull()
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
    expect(canvas(canvasId)).toMatchObject({ parentCanvasId: 'canvas:root', ownerNodeId: portalId })
    // 残ったノードへのつながりは外れ、一緒に移ったノードへのつながりは残る
    expect(workspace.bindingsOfArrow(arrow.id).map((b) => b.toId)).toEqual([x])
    root.undo()
    expect(root.index.allIds()).toContain(x)
    expect(workspace.getCanvas(canvasId)).toBeUndefined()
    expect(canvas(inner.canvasId).parentCanvasId).toBe('canvas:root')
    expect(workspace.bindingsOfArrow(arrow.id)).toHaveLength(2)
  })
})

describe('moving items into a child canvas', () => {
  it('moves the items with their children to the child canvas, in one undo step', () => {
    const { workspace, root, open, rect } = setup()
    const { portalId, canvasId } = root.createPortal({ x: 1000, y: 0 })
    const x = rect(root, 0, 0)
    const y = rect(root, 200, 50)
    const frame = root.makeNode('frame', { x: 0, y: 300, props: { w: 300, h: 200 } })
    root.createNodes([frame])
    const inFrame = root.makeNode('geo', { x: 10, y: 10, parentId: frame.id, props: { shape: 'rect', w: 50, h: 50 } })
    root.createNodes([inFrame])
    root.setSelection([x, y, frame.id])
    expect(root.moveToCanvas([x, y, frame.id], canvasId)).toEqual([x, y, frame.id])
    const child = open(canvasId)
    expect(new Set(child.index.allIds())).toEqual(new Set([x, y, frame.id]))
    expect(workspace.getNode(inFrame.id)!.parentId).toBe(frame.id)
    expect(root.index.allIds()).toEqual([portalId])
    expect(root.session.get().selectedIds.size).toBe(0)
    // 移す先が空なら、ワールドでの位置のまま
    expect(child.getNode(x)).toMatchObject({ x: 0, y: 0 })
    root.undo()
    expect(new Set(root.index.allIds())).toEqual(new Set([portalId, x, y, frame.id]))
    expect(workspace.tree.childrenOf(canvasId)).toEqual([])
    expect(new Set(root.session.get().selectedIds)).toEqual(new Set([x, y, frame.id]))
  })

  it('places the items to the right of what the child canvas already has, on top', () => {
    const { root, open, rect } = setup()
    const { canvasId } = root.createPortal({ x: 1000, y: 0 })
    const child = open(canvasId)
    const existing = rect(child, 0, 0)
    const x = rect(root, 500, 500)
    root.moveToCanvas([x], canvasId)
    expect(child.index.get(x)!.worldBounds).toMatchObject({ x: 180, y: 0 })
    expect(child.index.allIds()).toEqual([existing, x])
  })

  it('moves the canvases of owner portals along, even inside a frame, but not into themselves', () => {
    const { workspace, root, canvas } = setup()
    const a = root.createPortal({ x: 0, y: 0 })
    const b = root.createPortal({ x: 1000, y: 0 })
    const frame = root.makeNode('frame', { x: 400, y: 400, props: { w: 400, h: 400 } })
    root.createNodes([frame])
    const c = root.createPortal({ x: 600, y: 600 })
    expect(workspace.getNode(c.portalId)!.parentId).toBe(frame.id)
    root.moveToCanvas([a.portalId, frame.id], b.canvasId)
    expect(canvas(a.canvasId)).toMatchObject({ parentCanvasId: b.canvasId, ownerNodeId: a.portalId })
    expect(canvas(c.canvasId)).toMatchObject({ parentCanvasId: b.canvasId, ownerNodeId: c.portalId })
    expect(workspace.childCanvases(b.canvasId).map((d) => d.id).sort()).toEqual([a.canvasId, c.canvasId].sort())
    // b の Portal を、b の中の Canvas（a）には移せない
    expect(root.canMoveToCanvas([b.portalId], a.canvasId)).toBe(false)
    expect(root.moveToCanvas([b.portalId], a.canvasId)).toBeNull()
    // 今の Canvas にも移せない
    expect(root.canMoveToCanvas([b.portalId], 'canvas:root')).toBe(false)
    root.undo()
    expect(canvas(a.canvasId).parentCanvasId).toBe('canvas:root')
    expect(canvas(c.canvasId).parentCanvasId).toBe('canvas:root')
  })

  it('does not move into a trashed canvas', () => {
    const { root, rect } = setup()
    const a = root.createPortal({ x: 0, y: 0 })
    const x = rect(root, 500, 0)
    root.deleteNodes([a.portalId], { ownerPortals: 'trash' })
    expect(root.moveToCanvas([x], a.canvasId)).toBeNull()
  })

  it('unbinds arrows that connect moved items with ones that stay', () => {
    const { workspace, root, rect } = setup()
    const { canvasId } = root.createPortal({ x: 1000, y: 0 })
    const x = rect(root, 0, 0)
    const stay = rect(root, 300, 0)
    const arrow = root.makeNode('arrow', { x: 0, y: 0 })
    root.transact('arrow', (tx) => {
      tx.put(arrow)
      tx.put(makeBinding(arrow.id, x, { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false }))
      tx.put(makeBinding(arrow.id, stay, { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false }))
    })
    root.moveToCanvas([x, arrow.id], canvasId)
    expect(workspace.bindingsOfArrow(arrow.id).map((b) => b.toId)).toEqual([x])
    root.undo()
    expect(workspace.bindingsOfArrow(arrow.id)).toHaveLength(2)
  })

  it('finds the portal under the pointer as a drop target, skipping the dragged items', () => {
    const { root, rect } = setup()
    const a = root.createPortal({ x: 0, y: 0 })
    const b = root.createPortal({ x: 0, y: 0 })
    const x = rect(root, -50, -50)
    // 動かしているもの（x と、上に重なった b）は除いて、下の a を返す
    expect(root.canvasDropTarget({ x: 0, y: 0 }, [x, b.portalId])).toEqual({ portalId: a.portalId, canvasId: a.canvasId })
    expect(root.canvasDropTarget({ x: 0, y: 0 }, [x])).toEqual({ portalId: b.portalId, canvasId: b.canvasId })
    expect(root.canvasDropTarget({ x: 5000, y: 0 }, [x])).toBeNull()
  })

  it('asks to move items dropped onto a portal, putting them back where they were meanwhile', () => {
    const { root, rect } = setup()
    const a = root.createPortal({ x: 500, y: 0 })
    const x = rect(root, 0, 0)
    const requests: { ids: string[]; canvasId: string }[] = []
    const ctx: ToolContext = {
      editor: root,
      setTool: () => {},
      lift: () => {},
      drop: () => {},
      setCursor: () => {},
      startEditing: () => false,
      openPortal: () => {},
      editDocument: () => false,
      createDocumentAt: () => {},
      quoteRegion: () => {},
      openCitations: () => {},
      moveToCanvas: (ids, canvasId) => requests.push({ ids, canvasId }),
    }
    const pointer = (px: number, py: number): ToolPointer => ({
      screen: { x: px, y: py },
      world: { x: px, y: py },
      button: 0,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    })
    const tool = new SelectTool(ctx)
    tool.onPointerDown(pointer(50, 50))
    tool.onPointerMove(pointer(300, 50))
    tool.onPointerMove(pointer(500, 0))
    // 落とす先の Portal を、ホバーの枠で見せる
    expect(root.session.get().hoveredId).toBe(a.portalId)
    tool.onPointerUp(pointer(500, 0))
    expect(requests).toEqual([{ ids: [x], canvasId: a.canvasId }])
    expect(root.getNode(x)).toMatchObject({ x: 0, y: 0 })
    expect(root.session.get().hoveredId).toBeNull()
    // Portal の外に落としたら、ふつうに動かす
    tool.onPointerDown(pointer(50, 50))
    tool.onPointerMove(pointer(300, 50))
    tool.onPointerUp(pointer(300, 50))
    expect(requests).toHaveLength(1)
    expect(root.getNode(x)).toMatchObject({ x: 250, y: 0 })
  })
})

describe('moving items to the parent canvas', () => {
  // 親の Canvas に Portal（a）と遠くのノードを置き、a の中にノードを作る
  function nested() {
    const env = setup()
    const { root, open, rect } = env
    const a = root.createPortal({ x: 100, y: 200 })
    const far = rect(root, 3000, 0)
    const child = open(a.canvasId)
    return { ...env, a, far, child, portalBounds: root.index.get(a.portalId)!.worldBounds, x: rect(child, 500, 500) }
  }

  it('places the items right of the owner portal, top aligned, in one undo step of the child canvas', () => {
    const { workspace, root, child, a, portalBounds, x } = nested()
    const y = child.makeNode('geo', { x: 700, y: 600, props: { shape: 'rect', w: 100, h: 100 } })
    child.createNodes([y])
    expect(child.canMoveToCanvas([x, y.id], 'canvas:root')).toBe(true)
    expect(child.moveToCanvas([x, y.id], 'canvas:root', { nextTo: a.portalId })).toEqual([x, y.id])
    expect(workspace.getNode(x)!.parentId).toBe('canvas:root')
    // 並びは保ったまま、Portal の右に上を揃えて置く。重なり順は最も手前
    const left = portalBounds.x + portalBounds.w + 80
    expect(root.index.get(x)!.worldBounds).toMatchObject({ x: left, y: portalBounds.y })
    expect(root.index.get(y.id)!.worldBounds).toMatchObject({ x: left + 200, y: portalBounds.y + 100 })
    expect(root.index.allIds().slice(-2)).toEqual([x, y.id])
    expect(child.index.allIds()).toEqual([])
    child.undo()
    expect(new Set(child.index.allIds())).toEqual(new Set([x, y.id]))
    expect(child.getNode(x)).toMatchObject({ parentId: a.canvasId, x: 500, y: 500 })
  })

  it('falls back to the right of all content when the node to place next to is not in the parent', () => {
    const { root, child, x } = nested()
    child.moveToCanvas([x], 'canvas:root', { nextTo: 'node:missing' })
    // far（3000, 0、幅 100）の右
    expect(root.index.get(x)!.worldBounds).toMatchObject({ x: 3180, y: 0 })
  })

  it('moves the canvases of owner portals along to the parent', () => {
    const { root, child, canvas, a } = nested()
    const b = child.createPortal({ x: 0, y: 0 })
    child.moveToCanvas([b.portalId], 'canvas:root', { nextTo: a.portalId })
    expect(canvas(b.canvasId)).toMatchObject({ parentCanvasId: 'canvas:root', ownerNodeId: b.portalId })
    expect(root.getNode(b.portalId)).toBeDefined()
    child.undo()
    expect(canvas(b.canvasId).parentCanvasId).toBe(a.canvasId)
  })

  it('has no parent to move to at the root', () => {
    const { root, canvas, rect } = setup()
    rect(root, 0, 0)
    expect(canvas('canvas:root').parentCanvasId).toBeNull()
  })

  it('unbinds arrows that connect moved items with ones that stay', () => {
    const { workspace, child, rect, a, x } = nested()
    const stay = rect(child, 800, 500)
    const arrow = child.makeNode('arrow', { x: 500, y: 500 })
    child.transact('arrow', (tx) => {
      tx.put(arrow)
      tx.put(makeBinding(arrow.id, x, { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false }))
      tx.put(makeBinding(arrow.id, stay, { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false }))
    })
    child.moveToCanvas([x, arrow.id], 'canvas:root', { nextTo: a.portalId })
    expect(workspace.bindingsOfArrow(arrow.id).map((b) => b.toId)).toEqual([x])
    child.undo()
    expect(workspace.bindingsOfArrow(arrow.id)).toHaveLength(2)
  })
})
