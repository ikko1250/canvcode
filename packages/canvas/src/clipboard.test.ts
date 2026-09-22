import { describe, expect, it } from 'vitest'
import type { AssetRecord } from '@canvcode/core'
import { pickImageVariant } from '@canvcode/nodes'
import {
  copySelection,
  duplicateSelection,
  insertImages,
  insertPayload,
  insertText,
  parsePayload,
  payloadText,
  payloadToHtml,
} from './clipboard.ts'
import { Editor } from './editor.ts'

// コピー・貼り付け・複製と、画像の縮小版の選び方（MAI-26）

function setup() {
  const editor = new Editor({ canvasId: 'canvas:1' })
  const rect = (x: number, y: number, parentId?: string, label = '') =>
    editor.makeNode('geo', { x, y, parentId, props: { shape: 'rect', w: 100, h: 50, label } })
  const worldBox = (id: string) => editor.index.get(id)!.worldBounds
  return { editor, rect, worldBox }
}

const asset: AssetRecord = {
  typeName: 'asset',
  id: 'asset:abc',
  mime: 'image/png',
  size: 1000,
  hash: 'abc',
  width: 4000,
  height: 3000,
  variants: [256, 1024],
}

describe('copy and paste', () => {
  it('pastes a group with its children under new ids, centred on the given point', () => {
    const { editor, rect, worldBox } = setup()
    const a = rect(0, 0, undefined, 'A')
    editor.createNodes([a])
    const b = rect(200, 100, undefined, 'B')
    editor.createNodes([b])
    editor.setSelection([a.id, b.id])
    const groupId = editor.groupSelected()!
    const payload = copySelection(editor)!
    expect(payload.roots).toEqual([groupId])
    expect(payload.nodes).toHaveLength(3)
    expect(payloadText(editor, payload)).toBe('A\nB')

    const [pasted] = insertPayload(editor, payload, { center: { x: 1000, y: 1000 } })
    expect(pasted).not.toBe(groupId)
    expect(editor.index.childrenOf(pasted)).toHaveLength(2)
    // 元の箱は (0, 0)〜(300, 150)。中心を (1000, 1000) に合わせる
    const box = worldBox(pasted)
    expect(box.x).toBeCloseTo(850, 6)
    expect(box.y).toBeCloseTo(925, 6)
    expect([...editor.session.get().selectedIds]).toEqual([pasted])
    // 元の group はそのまま
    expect(editor.index.childrenOf(groupId)).toHaveLength(2)
  })

  it('copies a node inside a rotated frame in world form and pastes it at the top level', () => {
    const { editor, rect, worldBox } = setup()
    const frame = { ...editor.makeNode('frame', { x: 500, y: 0, props: { w: 400, h: 400, name: 'F' } }), rotation: Math.PI / 2 }
    editor.createNodes([frame])
    const inside = rect(10, 10, frame.id)
    editor.createNodes([inside])
    const before = worldBox(inside.id)
    editor.setSelection([inside.id])
    const payload = copySelection(editor)!
    // ずらさずに貼り付ければ、ワールドで同じ場所に来る
    const [pasted] = insertPayload(editor, payload, { offset: { x: 0, y: 0 } })
    expect(editor.getNode(pasted)!.parentId).toBe('canvas:1')
    const after = worldBox(pasted)
    for (const key of ['x', 'y', 'w', 'h'] as const) expect(after[key]).toBeCloseTo(before[key], 6)
  })

  it('does not copy a node twice when its ancestor is also selected', () => {
    const { editor, rect } = setup()
    const frame = editor.makeNode('frame', { x: 0, y: 0, props: { w: 400, h: 400, name: 'F' } })
    editor.createNodes([frame])
    const inside = rect(10, 10, frame.id)
    editor.createNodes([inside])
    editor.setSelection([frame.id, inside.id])
    const payload = copySelection(editor)!
    expect(payload.roots).toEqual([frame.id])
    expect(payload.nodes.map((n) => n.id)).toEqual([frame.id, inside.id])
  })

  it('pasting is one undo step', () => {
    const { editor, rect } = setup()
    const a = rect(0, 0)
    editor.createNodes([a])
    editor.setSelection([a.id])
    insertPayload(editor, copySelection(editor)!, { center: { x: 0, y: 0 } })
    expect(editor.index.size).toBe(2)
    editor.undo()
    expect(editor.index.size).toBe(1)
    expect([...editor.session.get().selectedIds]).toEqual([a.id])
  })

  it('round-trips the payload through text/html and JSON, and rejects foreign data', () => {
    const { editor, rect } = setup()
    const a = rect(0, 0, undefined, '日本語のラベル')
    editor.createNodes([a])
    editor.setSelection([a.id])
    const payload = copySelection(editor)!
    const html = `<html><body><!--StartFragment-->${payloadToHtml(payload)}<!--EndFragment--></body></html>`
    expect(parsePayload({ html })).toEqual(payload)
    expect(parsePayload({ json: JSON.stringify(payload) })).toEqual(payload)
    expect(parsePayload({ html: '<p>hello</p>' })).toBeNull()
    expect(parsePayload({ json: '{"kind":"other"}' })).toBeNull()
    expect(parsePayload({ json: 'not json' })).toBeNull()
  })
})

describe('duplicate', () => {
  it('keeps the duplicate in the same frame, offset and in front', () => {
    const { editor, rect, worldBox } = setup()
    const frame = editor.makeNode('frame', { x: 0, y: 0, props: { w: 400, h: 400, name: 'F' } })
    editor.createNodes([frame])
    const inside = rect(10, 10, frame.id)
    const front = rect(50, 50, frame.id)
    editor.createNodes([inside, front])
    editor.setSelection([inside.id])
    const [copy] = duplicateSelection(editor, { x: 16, y: 16 })
    expect(editor.getNode(copy)!.parentId).toBe(frame.id)
    expect(worldBox(copy).x).toBeCloseTo(worldBox(inside.id).x + 16, 6)
    expect(editor.index.childrenOf(frame.id).at(-1)).toBe(copy)
  })
})

describe('pasting from outside', () => {
  it('turns plain text into a text node centred on the point, wrapping long lines', () => {
    const { editor } = setup()
    const short = insertText(editor, 'hello\r\nworld\n\n', { x: 0, y: 0 })!
    const node = editor.getNode(short)! as { props: { text: string; autoWidth: boolean } }
    expect(node.props.text).toBe('hello\nworld')
    expect(node.props.autoWidth).toBe(true)
    const box = editor.index.get(short)!.worldBounds
    expect(box.x + box.w / 2).toBeCloseTo(0, 6)
    expect(box.y + box.h / 2).toBeCloseTo(0, 6)

    const long = insertText(editor, 'x'.repeat(200), { x: 0, y: 0 })!
    expect((editor.getNode(long)!.props as { autoWidth: boolean }).autoWidth).toBe(false)
    expect(insertText(editor, '   ', { x: 0, y: 0 })).toBeNull()
  })

  it('places images side by side, shrunk to fit', () => {
    const { editor } = setup()
    const small = { ...asset, id: 'asset:small', width: 100, height: 100, variants: [] }
    const ids = insertImages(editor, [asset, small], { x: 0, y: 0 }, { w: 800, h: 600 })
    const [big, little] = ids.map((id) => editor.getNode(id)!.props as { w: number; h: number })
    expect(big.w).toBeCloseTo(800, 6)
    expect(big.h).toBeCloseTo(600, 6)
    expect(little.w).toBe(100)
    expect([...editor.session.get().selectedIds]).toEqual(ids)
  })

  it('keeps the aspect ratio when resizing an image', () => {
    const { editor } = setup()
    const [id] = insertImages(editor, [asset], { x: 0, y: 0 }, { w: 400, h: 300 })
    editor.setSelection([id])
    expect(editor.transformSelection()!.forceAspect).toBe(true)
  })
})

describe('image variants', () => {
  it('picks the smallest variant that is large enough, else the original', () => {
    expect(pickImageVariant(asset, 100)).toBe(256)
    expect(pickImageVariant(asset, 256)).toBe(256)
    expect(pickImageVariant(asset, 300)).toBe(1024)
    expect(pickImageVariant(asset, 2000)).toBe(4000)
    // 縮小版がない小さな画像は、いつも原本
    expect(pickImageVariant({ ...asset, width: 200, height: 100, variants: [] }, 50)).toBe(200)
  })
})
