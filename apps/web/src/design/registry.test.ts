import { describe, expect, it } from 'vitest'
import { Editor, editNodes, type TextSelection } from '@canvcode/canvas'
import type { NodeRecord } from '@canvcode/core'
import { NOTE_TEXT_COLOR, richTextFromPlain, type NoteProps, type TextProps } from '@canvcode/nodes'
import { designSections, propField, registerDesignSection, visibleSections, type DesignSection } from './registry.ts'
import { fillColorField, fontFamilyField, fontSizeField, opacityField, strokeColorField, strokeWidthField, textAlignField, textColorField } from './sections.ts'

// デザインパネルのセクションと項目（MAI-73）

function setup() {
  const editor = new Editor()
  const geo = editor.makeNode('geo', { x: 0, y: 0, props: { shape: 'rect', w: 100, h: 100 } })
  const geo2 = editor.makeNode('geo', { x: 200, y: 0, props: { shape: 'ellipse', w: 100, h: 100, fill: '#ff0000' } })
  const text = editor.makeNode('text', { x: 0, y: 200, props: { paragraphs: richTextFromPlain('hello') } })
  const note = editor.makeNode('note', { x: 200, y: 200, props: { paragraphs: richTextFromPlain('memo') } })
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
    expect(fieldIds([text])).toEqual(['text.fontFamily', 'text.fontSize', 'text.color', 'text.align', 'layer.opacity'])
    expect(sectionIds([arrow])).toEqual(['stroke', 'layer'])
  })

  it('shows only the fields every selected node has', () => {
    const { geo, text, note, arrow, group } = setup()
    // テキストと付箋：フォント・文字の大きさ・色・揃えは共通（付箋の文字の色は、文字に当てる。MAI-74）。塗りは付箋だけ
    expect(fieldIds([text, note])).toEqual(['text.fontFamily', 'text.fontSize', 'text.color', 'text.align', 'layer.opacity'])
    expect(fieldIds([note])).toEqual(['fill.color', 'text.fontFamily', 'text.fontSize', 'text.color', 'text.align', 'layer.opacity'])
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

describe('text format fields per range (MAI-74)', () => {
  const red = { color: '#ff0000' }

  function setupRich() {
    const editor = new Editor()
    const text = editor.makeNode('text', {
      x: 0,
      y: 0,
      props: { color: '#000000', fontSize: 16, paragraphs: [{ runs: [{ text: 'red', format: red }, { text: ' plain' }] }] },
    })
    const note = editor.makeNode('note', { x: 300, y: 0, props: { paragraphs: richTextFromPlain('memo') } })
    editor.createNodes([text, note])
    return { editor, text: editor.getNode(text.id)!, note: editor.getNode(note.id)! }
  }
  const valueOf = (nodes: NodeRecord[], id: string, selection: TextSelection | null = null) =>
    visibleSections(nodes, undefined, selection)
      .flatMap((s) => s.fields)
      .find((f) => f.field.id === id)!.value

  it('shows mixed when the characters differ, and the value of the selected range while editing', () => {
    const { text } = setupRich()
    expect(valueOf([text], 'text.color')).toEqual({ kind: 'mixed', values: ['#ff0000', '#000000'] })
    expect(valueOf([text], 'text.fontSize')).toEqual({ kind: 'same', value: 16 })
    expect(valueOf([text], 'text.color', { nodeId: text.id, start: 0, end: 2 })).toEqual({ kind: 'same', value: '#ff0000' })
    expect(valueOf([text], 'text.color', { nodeId: text.id, start: 4, end: 9 })).toEqual({ kind: 'same', value: '#000000' })
    // 範囲が空（カーソルだけ）なら、ノード全体
    expect(valueOf([text], 'text.color', { nodeId: text.id, start: 1, end: 1 }).kind).toBe('mixed')
  })

  it('writes to the selected range, or to the whole node clearing the per-range values', () => {
    const { text } = setupRich()
    const ranged = fontSizeField.write(text, 32, { start: 4, end: 9 })
    expect((ranged.props as TextProps).paragraphs).toEqual([
      { runs: [{ text: 'red', format: red }, { text: ' ' }, { text: 'plain', format: { fontSize: 32 } }] },
    ])
    expect((ranged.props as TextProps).fontSize).toBe(16)
    const whole = textColorField.write(text, '#0000ff')
    expect(whole.props).toMatchObject({ color: '#0000ff', paragraphs: [{ runs: [{ text: 'red plain' }] }] })
    expect(textColorField.write(whole, '#0000ff')).toBe(whole)
  })

  it('colors the characters of a sticky note (the note has no default text color to change)', () => {
    const { note } = setupRich()
    expect(valueOf([note], 'text.color')).toEqual({ kind: 'same', value: NOTE_TEXT_COLOR })
    const colored = textColorField.write(note, '#ff0000')
    expect((colored.props as NoteProps).paragraphs).toEqual([{ runs: [{ text: 'memo', format: red }] }])
    expect((colored.props as NoteProps).color).toBe((note.props as NoteProps).color)
    expect(textColorField.write(colored, NOTE_TEXT_COLOR).props).toMatchObject({ paragraphs: richTextFromPlain('memo') })
  })
})

describe('font field (MAI-75)', () => {
  const mplus = { fontFamily: 'M PLUS 1p' }

  function setupFonts() {
    const editor = new Editor()
    const text = editor.makeNode('text', {
      x: 0,
      y: 0,
      props: { paragraphs: [{ runs: [{ text: 'abc', format: mplus }, { text: ' def' }] }] },
    })
    const note = editor.makeNode('note', { x: 300, y: 0, props: { paragraphs: richTextFromPlain('memo') } })
    editor.createNodes([text, note])
    return { editor, text: editor.getNode(text.id)!, note: editor.getNode(note.id)! }
  }
  const valueOf = (nodes: NodeRecord[], selection: TextSelection | null = null) =>
    visibleSections(nodes, undefined, selection)
      .flatMap((s) => s.fields)
      .find((f) => f.field.id === 'text.fontFamily')!.value

  it('reads the default font for old records without fontFamily, and mixed fonts per range', () => {
    const { text, note } = setupFonts()
    const { fontFamily: _, ...oldProps } = note.props as NoteProps
    expect(valueOf([{ ...note, props: oldProps }])).toEqual({ kind: 'same', value: 'sans-serif' })
    expect(valueOf([text])).toEqual({ kind: 'mixed', values: ['M PLUS 1p', 'sans-serif'] })
    expect(valueOf([text], { nodeId: text.id, start: 0, end: 3 })).toEqual({ kind: 'same', value: 'M PLUS 1p' })
    expect(valueOf([text, note]).kind).toBe('mixed')
  })

  it('writes the font to the selected range, or to the whole node', () => {
    const { text, note } = setupFonts()
    const ranged = fontFamilyField.write(text, 'serif', { start: 4, end: 7 })
    expect((ranged.props as TextProps).paragraphs).toEqual([
      { runs: [{ text: 'abc', format: mplus }, { text: ' ' }, { text: 'def', format: { fontFamily: 'serif' } }] },
    ])
    expect((ranged.props as TextProps).fontFamily).toBe('sans-serif')
    const whole = fontFamilyField.write(text, 'M PLUS 1p')
    expect(whole.props).toMatchObject({ fontFamily: 'M PLUS 1p', paragraphs: [{ runs: [{ text: 'abc def' }] }] })
    expect(fontFamilyField.write(whole, 'M PLUS 1p')).toBe(whole)
    expect(fontFamilyField.write(note, 'serif').props).toMatchObject({ fontFamily: 'serif', paragraphs: richTextFromPlain('memo') })
  })
})
