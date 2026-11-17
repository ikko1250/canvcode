import { describe, expect, it } from 'vitest'
import type { AssetRecord, NodeRecord } from '@canvcode/core'
import { imagePaint, pickImageVariant, plainTextOf, richTextFromPlain, type TextProps } from '@canvcode/nodes'
import {
  copySelection,
  duplicateSelection,
  insertAttachments,
  insertImages,
  insertLinkCard,
  insertPayload,
  insertRichText,
  insertText,
  parsePayload,
  pastedSvg,
  pastedUrl,
  payloadText,
  payloadToHtml,
} from './clipboard.ts'
import { Editor } from './editor.ts'
import { imageFillTargetAt, setImageFill } from './imageFill.ts'

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

describe('rich text nodes (MAI-74)', () => {
  it('keeps the formats of the characters when copying and pasting a text node', () => {
    const { editor } = setup()
    const paragraphs = [{ runs: [{ text: 'big', format: { fontSize: 40, color: '#ff0000' } }, { text: ' text' }] }]
    const text = editor.makeNode('text', { x: 0, y: 0, props: { paragraphs } })
    editor.createNodes([text])
    editor.setSelection([text.id])
    const payload = parsePayload({ json: JSON.stringify(copySelection(editor)) })!
    const [id] = insertPayload(editor, payload, { center: { x: 500, y: 500 } })
    expect(editor.getNode(id)).toMatchObject({ version: 2, props: { paragraphs } })
  })

  it('upgrades text nodes copied from a tab that still had plain text (version 1)', () => {
    const { editor } = setup()
    const text = editor.makeNode('text', { x: 0, y: 0 })
    const { paragraphs: _, ...props } = text.props as TextProps
    const legacy = { ...text, version: undefined, props: { ...props, text: 'old\ntext' } }
    const payload = { kind: 'canvcode/nodes' as const, version: 1 as const, nodes: [legacy], roots: [legacy.id], bounds: { x: 0, y: 0, w: 10, h: 10 }, assets: [], bindings: [], anchors: [] }
    const [id] = insertPayload(editor, payload, { center: { x: 0, y: 0 } })
    const node = editor.getNode(id) as NodeRecord<TextProps>
    expect(node.version).toBe(2)
    expect(node.props.paragraphs).toEqual(richTextFromPlain('old\ntext'))
    expect('text' in node.props).toBe(false)
  })
})

describe('pasting from outside', () => {
  it('turns plain text into a text node centred on the point, wrapping long lines', () => {
    const { editor } = setup()
    const short = insertText(editor, 'hello\r\nworld\n\n', { x: 0, y: 0 })!
    const node = editor.getNode(short)! as NodeRecord<TextProps>
    expect(plainTextOf(node.props.paragraphs)).toBe('hello\nworld')
    expect(node.props.autoWidth).toBe(true)
    const box = editor.index.get(short)!.worldBounds
    expect(box.x + box.w / 2).toBeCloseTo(0, 6)
    expect(box.y + box.h / 2).toBeCloseTo(0, 6)

    const long = insertText(editor, 'x'.repeat(200), { x: 0, y: 0 })!
    expect((editor.getNode(long)!.props as { autoWidth: boolean }).autoWidth).toBe(false)
    expect(insertText(editor, '   ', { x: 0, y: 0 })).toBeNull()
  })

  it('reads pasted text as Markdown, and copies formatted nodes as standard Markdown (plain ones as plain text)', () => {
    const { editor } = setup()
    const id = insertText(editor, '**議題**\n- [予算]{color=#e03131} を決める', { x: 0, y: 0 })!
    const node = editor.getNode(id)! as NodeRecord<TextProps>
    expect(node.props.paragraphs).toEqual([
      { runs: [{ text: '議題', format: { fontWeight: 700 } }] },
      { runs: [{ text: '予算', format: { color: '#e03131' } }, { text: ' を決める' }], list: { type: 'bullet', level: 0 } },
    ])
    const note = editor.makeNode('note', { x: 0, y: 300, props: { paragraphs: richTextFromPlain('a*b') } })
    editor.createNodes([note])
    editor.setSelection([id, note.id])
    // 色はほかのアプリへ渡さない。入れ子のリストの字下げは残す
    expect(payloadText(editor, copySelection(editor)!)).toBe('**議題**\n- 予算 を決める\na*b')
    const nested = editor.makeNode('note', { x: 0, y: 600, props: { paragraphs: [{ runs: [{ text: 'sub' }], list: { type: 'bullet', level: 1 } }] } })
    editor.createNodes([nested])
    editor.setSelection([nested.id])
    expect(payloadText(editor, copySelection(editor)!)).toBe('  - sub')
  })

  it('makes a text node from formatted paragraphs (text copied while editing), dropping values equal to its defaults', () => {
    const { editor } = setup()
    const id = insertRichText(editor, (base) => [{ runs: [{ text: 'a', format: { color: '#e03131', fontSize: base.fontSize } }, { text: 'b' }] }], { x: 0, y: 0 })!
    expect((editor.getNode(id)!.props as TextProps).paragraphs).toEqual([{ runs: [{ text: 'a', format: { color: '#e03131' } }, { text: 'b' }] }])
    expect(insertRichText(editor, () => [{ runs: [{ text: '  ' }] }], { x: 0, y: 0 })).toBeNull()
  })

  it('treats text that is a single http(s) URL as a link', () => {
    expect(pastedUrl('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c')
    expect(pastedUrl('  http://example.com/  \n')).toBe('http://example.com/')
    expect(pastedUrl('HTTPS://EXAMPLE.COM')).toBe('HTTPS://EXAMPLE.COM')
    expect(pastedUrl('see https://example.com')).toBeNull()
    expect(pastedUrl('https://example.com\nhttps://example.org')).toBeNull()
    expect(pastedUrl('javascript:alert(1)')).toBeNull()
    expect(pastedUrl('ftp://example.com/file')).toBeNull()
    expect(pastedUrl('example.com')).toBeNull()
    expect(pastedUrl('https://')).toBeNull()
  })

  // SVG のコード（Figma の「SVG としてコピー」など）は画像にする（MAI-116）
  it('treats text that is a single SVG document as an SVG image', () => {
    const svg = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'
    expect(pastedSvg(`  ${svg}\n`)).toBe(svg)
    expect(pastedSvg(`<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: x -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n${svg}`)).toContain(svg)
    expect(pastedSvg(`<svg\n  xmlns="http://www.w3.org/2000/svg">\n</svg>`)).not.toBeNull()
    expect(pastedSvg(`see ${svg}`)).toBeNull()
    expect(pastedSvg(`${svg} and more`)).toBeNull()
    expect(pastedSvg('<svgx></svgx>')).toBeNull()
    expect(pastedSvg('<p>text</p>')).toBeNull()
  })

  it('places a loading link card centred on the point, and copies it as its URL', () => {
    const { editor } = setup()
    const id = insertLinkCard(editor, 'https://example.com/page', { x: 100, y: 50 })
    const node = editor.getNode(id)!
    expect(node.type).toBe('link-card')
    expect(node.props).toMatchObject({ url: 'https://example.com/page', title: null, image: null, status: 'loading' })
    expect([...editor.session.get().selectedIds]).toEqual([id])
    const box = editor.index.get(id)!.worldBounds
    expect(box.x + box.w / 2).toBeCloseTo(100, 6)
    expect(box.y + box.h / 2).toBeCloseTo(50, 6)
    const payload = copySelection(editor, () => undefined)!
    expect(payloadText(editor, payload)).toBe('https://example.com/page')
    expect(editor.getType(node).linkAt!(node, { x: 10, y: 10 })).toBe('https://example.com/page')
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

  // ファイルのカード（MAI-100）：横に 3 枚ずつ並べ、コピーするときは原本の Asset も載せる。Ctrl+クリックで原本を開く
  it('places attachment cards in rows of three, and copies their assets', () => {
    const { editor } = setup()
    const file = (n: number): AssetRecord => ({ typeName: 'asset', id: `asset:${String(n).repeat(64)}`, mime: 'application/zip', size: 1000 * n, hash: String(n).repeat(64), width: 0, height: 0, variants: [] })
    const ids = insertAttachments(editor, [1, 2, 3, 4].map((n) => ({ asset: file(n), name: `資料${n}.zip`, mime: 'application/zip' })), { x: 0, y: 0 })
    expect([...editor.session.get().selectedIds]).toEqual(ids)
    const boxes = ids.map((id) => editor.index.get(id)!.worldBounds)
    expect(boxes.map((b) => [b.x, b.y, b.w, b.h])).toEqual([
      [-466, -80, 300, 72],
      [-150, -80, 300, 72],
      [166, -80, 300, 72],
      [-466, 8, 300, 72],
    ])
    const node = editor.getNode(ids[0])!
    expect(node.props).toEqual({ assetId: file(1).id, name: '資料1.zip', mime: 'application/zip', size: 1000, w: 300 })
    expect(editor.getType(node).linkAt!(node, { x: 10, y: 10 })).toBe(`/api/assets/${'1'.repeat(64)}?${new URLSearchParams({ name: '資料1.zip' })}`)
    editor.setSelection([ids[0]])
    const payload = copySelection(editor, (id) => (id === file(1).id ? file(1) : undefined))!
    expect(payload.assets).toEqual([file(1)])
    expect(payloadText(editor, payload)).toBe('')
    // 幅だけを変えられる
    expect(editor.getType(node).resize!(node, { w: 500, h: 300 })).toMatchObject({ w: 500 })
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

  // SVG は縮小版を作らず、要る大きさを 2 倍ずつの段階に丸めて描き直す（MAI-116）
  it('picks the size to draw an SVG at, in steps of two from 32 to 4096 pixels', () => {
    const svg = { ...asset, mime: 'image/svg+xml', width: 24, height: 24, variants: [] }
    expect(pickImageVariant(svg, 1)).toBe(32)
    expect(pickImageVariant(svg, 24)).toBe(32)
    expect(pickImageVariant(svg, 33)).toBe(64)
    expect(pickImageVariant(svg, 384)).toBe(512)
    expect(pickImageVariant(svg, 4096)).toBe(4096)
    expect(pickImageVariant(svg, 100_000)).toBe(4096)
  })
})

// 画像の塗り（MAI-83）
describe('image fills', () => {
  it('sets the image fill of shapes only, in one undo step, and copies the asset with the shape', () => {
    const { editor, rect } = setup()
    const shape = { ...rect(0, 0), props: { ...rect(0, 0).props, fill: { type: 'solid', color: '#ff0000', opacity: 0.4 } } }
    const text = editor.makeNode('text', { x: 300, y: 0, props: { paragraphs: richTextFromPlain('a'), autoWidth: true } })
    editor.createNodes([shape, text])
    expect(setImageFill(editor, [shape.id, text.id], asset.id)).toEqual([shape.id])
    expect((editor.getNode(shape.id)!.props as { fill: unknown }).fill).toEqual(imagePaint(asset.id, { opacity: 0.4 }))
    editor.undo()
    expect((editor.getNode(shape.id)!.props as { fill: { type: string } }).fill.type).toBe('solid')
    editor.redo()

    editor.setSelection([shape.id])
    const payload = copySelection(editor, (id) => (id === asset.id ? asset : undefined))!
    expect(payload.assets).toEqual([asset])
  })

  it('finds the shape under a dropped image', () => {
    const { editor, rect } = setup()
    const shape = rect(0, 0)
    editor.createNodes([shape])
    expect(imageFillTargetAt(editor, { x: 50, y: 25 })?.id).toBe(shape.id)
    expect(imageFillTargetAt(editor, { x: 500, y: 25 })).toBeNull()
  })
})
