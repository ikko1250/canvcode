import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { builtinNodeTypes, createCodeCardType } from '@canvcode/nodes'
import { createMarkdownCardType, type MarkdownCardProps } from '@canvcode/nodes/markdown'
import { copySelection, insertPayloadWithResult } from './clipboard.ts'
import { Editor } from './editor.ts'
import { markdownTableFromClipboard, toMarkdownTable } from './table.ts'
import { Workspace } from './workspace.ts'

// Markdown の File とカード（MAI-30）

function setup() {
  const cardType = createMarkdownCardType({ embedCss: async () => '', measureCss: '' })
  const workspace = new Workspace({ rootCanvasId: 'canvas:root', types: [...builtinNodeTypes, cardType, createCodeCardType()] })
  const root = new Editor({ workspace })
  const file = (id: string, title = 'メモ') =>
    workspace.applyServerFile({ id, kind: 'markdown', title, path: `${title}.md`, size: 0, mtime: 0, hash: 'h', missing: false })
  const card = (id: string) => workspace.getNode(id) as NodeRecord<MarkdownCardProps>
  return { workspace, root, file, card }
}

describe('files from the server', () => {
  it('adds new files as unplaced, and keeps the tree fields when the server updates them', () => {
    const { workspace, root, file } = setup()
    file('file:a')
    expect(workspace.unplacedDocuments().map((d) => d.id)).toEqual(['file:a'])
    root.createFileCard('file:a', { x: 0, y: 0 })
    expect(workspace.getFile('file:a')).toMatchObject({ parentCanvasId: 'canvas:root', ownerNodeId: expect.any(String) })
    // 外で名前が変わった（サーバーから新しい情報が届いた）
    workspace.applyServerFile({ id: 'file:a', kind: 'markdown', title: '新しい名前', path: '新しい名前.md', size: 3, mtime: 1, hash: 'x', missing: false })
    expect(workspace.getFile('file:a')).toMatchObject({ title: '新しい名前', parentCanvasId: 'canvas:root' })
    expect(workspace.childFiles('canvas:root').map((f) => f.id)).toEqual(['file:a'])
    // サーバーからの変更は、Undo の履歴に入らない
    expect(root.history.canUndo('canvas:root')).toBe(true)
    root.undo()
    expect(workspace.getFile('file:a')!.title).toBe('新しい名前')
  })

  it('reports a file whose real file is gone', () => {
    const { workspace, file } = setup()
    file('file:a')
    workspace.applyServerFile({ id: 'file:a', kind: 'markdown', title: 'メモ', path: 'メモ.md', size: 0, mtime: 0, hash: '', missing: true })
    expect(workspace.targetStatus('file:a')).toBe('nofile')
  })
})

describe('cards', () => {
  it('makes the first card the owner and later ones shortcuts', () => {
    const { root, file, card } = setup()
    file('file:a')
    const first = root.createFileCard('file:a', { x: 0, y: 0 })!
    const second = root.createFileCard('file:a', { x: 600, y: 0 })!
    expect(card(first).props.role).toBe('owner')
    expect(card(second).props.role).toBe('shortcut')
  })

  it('sends the file to the trash with its owner card, and restores both', () => {
    const { workspace, root, file } = setup()
    file('file:a')
    const id = root.createFileCard('file:a', { x: 0, y: 0 })!
    root.deleteNodes([id], { ownerPortals: 'trash' })
    expect(workspace.trashedDocuments().map((d) => d.id)).toEqual(['file:a'])
    expect(workspace.targetStatus('file:a')).toBe('trashed')
    root.transact('restore', (tx) => workspace.restoreCanvas(tx, 'file:a'))
    expect(workspace.getNode(id)).toBeDefined()
    expect(workspace.getFile('file:a')).toMatchObject({ deletedAt: null, ownerNodeId: id })
  })

  it('trashes the files of a canvas with it', () => {
    const { workspace, root, file } = setup()
    const { portalId, canvasId } = root.createPortal({ x: 0, y: 0 })
    file('file:a')
    new Editor({ workspace, canvasId }).createFileCard('file:a', { x: 0, y: 0 })
    root.deleteNodes([portalId], { ownerPortals: 'trash' })
    expect(workspace.targetStatus('file:a')).toBe('trashed')
    // 完全に削除すると、その File の id を返す（サーバーに実ファイルの退避を頼むため）
    let removed: string[] = []
    workspace.store.transact('forever', (tx) => (removed = workspace.deleteCanvasForever(tx, canvasId)))
    expect(removed).toEqual(['file:a'])
    expect(workspace.getFile('file:a')).toBeUndefined()
  })

  it('pastes a copied card as a shortcut, and a cut card as the owner', () => {
    const { workspace, root, file, card } = setup()
    file('file:a')
    const id = root.createFileCard('file:a', { x: 0, y: 0 })!
    root.setSelection([id])
    const payload = copySelection(root)!
    const [copy] = insertPayloadWithResult(root, payload, { offset: { x: 600, y: 0 } }).ids
    expect(card(copy).props.role).toBe('shortcut')
    root.deleteNodes([id, copy], { ownerPortals: 'unplace' })
    expect(workspace.unplacedDocuments().map((d) => d.id)).toEqual(['file:a'])
    const [moved] = insertPayloadWithResult(root, payload, { center: { x: 0, y: 0 } }).ids
    expect(card(moved).props.role).toBe('owner')
    expect(workspace.getFile('file:a')!.ownerNodeId).toBe(moved)
  })

  it('places a Python file as a code card', () => {
    const { workspace, root, card } = setup()
    workspace.applyServerFile({ id: 'file:py', kind: 'code', title: 'main', path: 'main.py', size: 0, mtime: 0, hash: 'h', missing: false })
    const id = root.placeCanvas('file:py', { x: 0, y: 0 })!
    expect(card(id).type).toBe('code-card')
    expect(workspace.getFile('file:py')!.ownerNodeId).toBe(id)
  })

  it('places an unplaced file again as a card', () => {
    const { workspace, root, file, card } = setup()
    file('file:a')
    const id = root.placeCanvas('file:a', { x: 0, y: 0 })!
    expect(card(id).type).toBe('markdown-card')
    expect(workspace.unplacedDocuments()).toHaveLength(0)
  })

  it('switches a card to a fixed size when its height is resized by hand', () => {
    const { root, file, card } = setup()
    file('file:a')
    const id = root.createFileCard('file:a', { x: 0, y: 0 })!
    const type = root.getType(card(id))
    const { h } = type.getBounds(card(id))
    expect(type.resize!(card(id), { w: 300, h }).sizing).toBe('auto')
    expect(type.resize!(card(id), { w: 300, h: h + 100 }).sizing).toBe('fixed')
  })
})

describe('pasted tables', () => {
  it('turns tab-separated text into a Markdown table', () => {
    expect(markdownTableFromClipboard('', '名前\t数\nりんご\t3\nみかん|ぶどう\t5\n')).toBe(
      '| 名前 | 数 |\n| --- | --- |\n| りんご | 3 |\n| みかん\\|ぶどう | 5 |\n',
    )
  })

  it('does not treat ordinary text as a table', () => {
    expect(markdownTableFromClipboard('', 'ふつうの文章\n二行目')).toBeNull()
    expect(markdownTableFromClipboard('', 'a\tb')).toBeNull()
  })

  it('pads rows to the widest one', () => {
    expect(toMarkdownTable([['a', 'b', 'c'], ['1']])).toBe('| a | b | c |\n| --- | --- | --- |\n| 1 |  |  |\n')
  })
})
