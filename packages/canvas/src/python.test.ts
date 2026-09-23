import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { builtinNodeTypes, createCodeCardType, type CodeCardProps } from '@canvcode/nodes'
import { Editor } from './editor.ts'
import { Workspace } from './workspace.ts'

// Python の Canvas（MAI-37）

function setup() {
  const workspace = new Workspace({ rootCanvasId: 'canvas:root', types: [...builtinNodeTypes, createCodeCardType()] })
  const root = new Editor({ workspace })
  workspace.applyServerFile({ id: 'file:py', kind: 'code', title: 'main', path: 'main.py', size: 0, mtime: 0, hash: 'h', missing: false })
  const result = root.createPythonCanvas('file:py', { x: 0, y: 0 })!
  const inner = new Editor({ workspace, canvasId: result.canvasId })
  return { workspace, root, result, inner }
}

describe('a Python canvas', () => {
  it('creates the canvas with the code card and its owner portal', () => {
    const { workspace, root, result, inner } = setup()
    expect(workspace.getCanvas(result.canvasId)).toMatchObject({ title: 'main', parentCanvasId: 'canvas:root', ownerNodeId: result.portalId })
    expect(root.index.allIds()).toEqual([result.portalId])
    expect([...root.session.get().selectedIds]).toEqual([result.portalId])
    expect(inner.index.allIds()).toEqual([result.cardId])
    const card = workspace.getNode(result.cardId) as NodeRecord<CodeCardProps>
    expect(card).toMatchObject({ type: 'code-card', parentId: result.canvasId, x: 0, y: 0 })
    expect(card.props).toMatchObject({ fileId: 'file:py', role: 'owner' })
    // 高さは中身に合わせる
    expect(card.props.sizing).toBe('auto')
    // File はその Canvas の中にある
    expect(workspace.getFile('file:py')).toMatchObject({ parentCanvasId: result.canvasId, ownerNodeId: result.cardId })
    expect(workspace.unplacedDocuments()).toHaveLength(0)
  })

  it('undoes the whole creation in one step', () => {
    const { workspace, root, result } = setup()
    root.undo()
    expect(workspace.getCanvas(result.canvasId)).toBeUndefined()
    expect(workspace.getNode(result.portalId)).toBeUndefined()
    expect(workspace.getNode(result.cardId)).toBeUndefined()
    expect(workspace.unplacedDocuments().map((d) => d.id)).toEqual(['file:py'])
  })

  it('only takes Python files', () => {
    const { workspace, root } = setup()
    workspace.applyServerFile({ id: 'file:md', kind: 'markdown', title: 'メモ', path: 'メモ.md', size: 0, mtime: 0, hash: 'h', missing: false })
    expect(root.createPythonCanvas('file:md', { x: 0, y: 0 })).toBeNull()
    expect(root.createPythonCanvas('file:none', { x: 0, y: 0 })).toBeNull()
  })
})
