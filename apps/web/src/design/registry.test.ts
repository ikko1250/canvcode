import { describe, expect, it } from 'vitest'
import { Editor, editNodes } from '@canvcode/canvas'
import type { NodeRecord } from '@canvcode/core'
import { designSections, propField, registerDesignSection, visibleSections, type DesignSection } from './registry.ts'
import { fillColorField, fontSizeField, opacityField, strokeColorField, strokeWidthField, textAlignField, textColorField } from './sections.ts'

// デザインパネルのセクションと項目（MAI-73）

function setup() {
  const editor = new Editor()
  const geo = editor.makeNode('geo', { x: 0, y: 0, props: { shape: 'rect', w: 100, h: 100 } })
  const geo2 = editor.makeNode('geo', { x: 200, y: 0, props: { shape: 'ellipse', w: 100, h: 100, fill: '#ff0000' } })
  const text = editor.makeNode('text', { x: 0, y: 200, props: { text: 'hello' } })
  const note = editor.makeNode('note', { x: 200, y: 200, props: { text: 'memo' } })
  const arrow = editor.makeNode('arrow', { x: 0, y: 400, props: { start: { x: 0, y: 0 }, end: { x: 100, y: 0 } } })
  const group = editor.makeNode('group', { x: 0, y: 0 })
  editor.createNodes([geo, geo2, text, note, arrow, group])
  editor.history.clear(editor.canvasId)
  return { editor, geo, geo2, text, note, arrow, group }
}

const sectionIds = (nodes: NodeRecord[]) => visibleSections(nodes).map((s) => s.section.id)
const fieldIds = (nodes: NodeRecord[]) => visibleSections(nodes).flatMap((s) => s.fields.map((f) => f.field.id))

describe('design sections', () => {
  it('shows the sections for the type of the selected node', () => {
    const { geo, text, arrow } = setup()
    expect(sectionIds([geo])).toEqual(['fill', 'stroke', 'layer'])
    expect(fieldIds([geo])).toEqual(['fill.color', 'stroke.color', 'stroke.width', 'layer.opacity'])
    expect(sectionIds([text])).toEqual(['text', 'layer'])
    expect(fieldIds([text])).toEqual(['text.fontSize', 'text.color', 'text.align', 'layer.opacity'])
    expect(sectionIds([arrow])).toEqual(['stroke', 'layer'])
  })

  it('shows only the fields every selected node has', () => {
    const { geo, text, note, arrow, group } = setup()
    // テキストと付箋：大きさと揃えは共通。文字の色はテキストだけ、塗りは付箋だけ
    expect(fieldIds([text, note])).toEqual(['text.fontSize', 'text.align', 'layer.opacity'])
    // 図形と矢印：線は共通（図形の stroke と矢印の color）
    expect(fieldIds([geo, arrow])).toEqual(['stroke.color', 'stroke.width', 'layer.opacity'])
    expect(fieldIds([geo, text])).toEqual(['layer.opacity'])
    // group には変えられる項目がない
    expect(visibleSections([group])).toEqual([])
    expect(visibleSections([geo, group])).toEqual([])
    expect(visibleSections([])).toEqual([])
  })

  it('reports mixed values when the selected nodes differ', () => {
    const { geo, geo2 } = setup()
    const fields = visibleSections([geo, geo2]).flatMap((s) => s.fields)
    const fill = fields.find((f) => f.field.id === 'fill.color')!
    const width = fields.find((f) => f.field.id === 'stroke.width')!
    expect(fill.value.kind).toBe('mixed')
    expect(width.value).toEqual({ kind: 'same', value: 2 })
  })

  it('reads a missing align as left (old records)', () => {
    const { note } = setup()
    const { align: _, ...props } = note.props as { align: string }
    expect(textAlignField.read({ ...note, props })).toBe('left')
  })

  it('writes the matching prop per type and returns the same node when unchanged', () => {
    const { geo, arrow, note } = setup()
    expect((strokeColorField.write(geo, '#123456').props as { stroke: string }).stroke).toBe('#123456')
    expect((strokeColorField.write(arrow, '#123456').props as { color: string }).color).toBe('#123456')
    expect((fillColorField.write(note, '#abcdef').props as { color: string }).color).toBe('#abcdef')
    expect(strokeWidthField.write(geo, 2)).toBe(geo)
    expect(opacityField.write(geo, 1)).toBe(geo)
    expect(opacityField.write(geo, 0.5).opacity).toBe(0.5)
  })

  it('changes geo fill / stroke / strokeWidth and text fontSize / color / align, each undoable', () => {
    const { editor, geo, text } = setup()
    const apply = <T,>(node: NodeRecord, field: { write(node: NodeRecord, value: T): NodeRecord }, value: T) =>
      editNodes(editor, [node.id], (n) => field.write(n, value), 'design')
    apply(geo, fillColorField, '#ff8800')
    apply(geo, strokeColorField, '#0000ff')
    apply(geo, strokeWidthField, 6)
    apply(text, fontSizeField, 32)
    apply(text, textColorField, '#e03131')
    apply(text, textAlignField, 'center')
    expect(editor.getNode(geo.id)!.props).toMatchObject({ fill: '#ff8800', stroke: '#0000ff', strokeWidth: 6 })
    expect(editor.getNode(text.id)!.props).toMatchObject({ fontSize: 32, color: '#e03131', align: 'center' })
    editor.undo()
    expect(editor.getNode(text.id)!.props).toMatchObject({ fontSize: 32, color: '#e03131', align: 'left' })
    for (let i = 0; i < 5; i++) editor.undo()
    expect(editor.getNode(geo.id)!.props).toMatchObject({ fill: '#e8eefc', stroke: '#3b5bdb', strokeWidth: 2 })
    expect(editor.getNode(text.id)!.props).toMatchObject({ fontSize: 12, color: '#1f2328' })
  })

  it('accepts new sections from later tasks, ordered by order', () => {
    const extra: DesignSection = {
      id: 'test-corner',
      title: '角丸',
      order: 150,
      fields: [propField<number>({ id: 'corner.radius', label: '半径', keys: { geo: 'radius' }, control: { kind: 'number' }, fallback: 0 })],
    }
    const all = [...designSections(), extra].sort((a, b) => a.order - b.order)
    const { geo } = setup()
    expect(visibleSections([geo], all).map((s) => s.section.id)).toEqual(['fill', 'test-corner', 'stroke', 'layer'])
    expect(visibleSections([geo], all)[1].fields[0].value).toEqual({ kind: 'same', value: 0 })
    // 同じ id で登録し直すと置き換わる
    registerDesignSection({ ...extra, id: 'fill', order: 100 })
    expect(designSections().filter((s) => s.id === 'fill')).toHaveLength(1)
    expect(designSections().find((s) => s.id === 'fill')!.title).toBe('角丸')
    registerDesignSection({ id: 'fill', title: '塗り', order: 100, fields: [fillColorField] })
  })
})
