import { describe, expect, it } from 'vitest'
import { Editor, Workspace } from '@canvcode/canvas'
import { builtinNodeTypes, createCodeCardType } from '@canvcode/nodes'
import { createMarkdownCardType } from '@canvcode/nodes/markdown'
import { canvasUrl, fileUrl, newTabUrl } from './newTab.ts'

const files = { get: () => null }

function setup() {
  const workspace = new Workspace({
    rootCanvasId: 'canvas:root',
    types: [
      ...builtinNodeTypes,
      createMarkdownCardType({ embedCss: async () => '', measureCss: '' }),
      createCodeCardType({ files }),
    ],
  })
  const editor = new Editor({ workspace })
  const addFile = (id: string, kind: 'markdown' | 'code', path: string) => {
    workspace.applyServerFile({ id, kind, title: id, path, size: 0, mtime: 0, hash: 'h', missing: false })
    return editor.getNode(editor.createFileCard(id, { x: 0, y: 0 })!)!
  }
  return { workspace, editor, addFile }
}

describe('newTabUrl', () => {
  it('Portal は参照先のキャンバスの URL', () => {
    const { workspace, editor } = setup()
    const { portalId, canvasId } = editor.createPortal({ x: 0, y: 0 })
    expect(newTabUrl(workspace, editor.getNode(portalId)!)).toBe(`/c/${encodeURIComponent(canvasId)}`)
  })

  it('Markdown・Python のカードは全画面のエディタの URL', () => {
    const { workspace, addFile } = setup()
    expect(newTabUrl(workspace, addFile('file:a', 'markdown', 'a.md'))).toBe('/f/file%3Aa')
    expect(newTabUrl(workspace, addFile('file:b', 'code', 'b.py'))).toBe('/f/file%3Ab')
  })

  it('開けないもの・ほかのノードは null', () => {
    const { workspace, editor, addFile } = setup()
    const card = addFile('file:gone', 'markdown', 'gone.md')
    workspace.applyServerFile({ id: 'file:gone', kind: 'markdown', title: 'file:gone', path: 'gone.md', size: 0, mtime: 0, hash: 'h', missing: true })
    expect(newTabUrl(workspace, card)).toBeNull()
    const { portalId } = editor.createPortal({ x: 0, y: 0 })
    const portal = editor.getNode(portalId)!
    expect(newTabUrl(workspace, { ...portal, props: { ...portal.props, targetId: 'canvas:missing' } })).toBeNull()
    expect(newTabUrl(workspace, { ...portal, type: 'note' })).toBeNull()
  })
})

describe('URL', () => {
  it('id を URL に使える形にする', () => {
    expect(canvasUrl('canvas:a b')).toBe('/c/canvas%3Aa%20b')
    expect(fileUrl('file:x/y')).toBe('/f/file%3Ax%2Fy')
  })
})
