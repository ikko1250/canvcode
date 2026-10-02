import { describe, expect, it } from 'vitest'
import { Editor, editNodes, type TextSelection } from '@canvcode/canvas'
import type { NodeRecord } from '@canvcode/core'
import { defaultShadow, NOTE_TEXT_COLOR, gradientStop, imagePaint, linearGradient, radialGradient, richTextFromPlain, solidPaint, type NoteProps, type TextProps } from '@canvcode/nodes'
import { designSections, propField, registerDesignSection, visibleSections, type DesignSection } from './registry.ts'
import { arrowHeadLengthField, arrowHeadWidthField, arrowShaftField, chevronDepthField, geoShapeField } from './sections.ts'
import { applyFillChange, applyShadowsChange, shadowRows, shadowsField, strokeAlignField, strokeDashField, strokeDashGapField, strokeDashLengthField, boldField, cornerRadiusField, fillField, fontFamilyField, italicField, strikethroughField, fontSizeField, letterSpacingField, lineHeightField, listStyleField, listTypeField, opacityField, strokeColorField, strokeWidthField, textAlignField, textColorField } from './sections.ts'

// デザインパネルのセクションと項目（MAI-73）

function setup() {
  const editor = new Editor()
  const geo = editor.makeNode('geo', { x: 0, y: 0, props: { shape: 'rect', w: 100, h: 100 } })
  const geo2 = editor.makeNode('geo', { x: 200, y: 0, props: { shape: 'ellipse', w: 100, h: 100, fill: solidPaint('#ff0000') } })
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
    expect(sectionIds([geo])).toEqual(['shape', 'fill', 'corner', 'stroke', 'effects', 'layer'])
    expect(fieldIds([geo])).toEqual(['shape.shape', 'fill.paint', 'corner.radius', 'stroke.color', 'stroke.width', 'stroke.align', 'stroke.dash', 'effects.shadows', 'layer.opacity'])
    expect(sectionIds([text])).toEqual(['text', 'layer'])
    expect(fieldIds([text])).toEqual(['text.fontFamily', 'text.fontSize', 'text.bold', 'text.italic', 'text.underline', 'text.strikethrough', 'text.lineHeight', 'text.letterSpacing', 'text.color', 'text.align', 'text.list', 'text.listStyle', 'layer.opacity'])
    expect(sectionIds([arrow])).toEqual(['stroke', 'layer'])
  })

  it('shows only the fields every selected node has', () => {
    const { geo, text, note, arrow, group } = setup()
    // テキストと付箋：フォント・文字の大きさ・行間・文字間・色・揃えは共通（付箋の文字の色は、文字に当てる。MAI-74）。塗りは付箋だけ
    expect(fieldIds([text, note])).toEqual(['text.fontFamily', 'text.fontSize', 'text.bold', 'text.italic', 'text.underline', 'text.strikethrough', 'text.lineHeight', 'text.letterSpacing', 'text.color', 'text.align', 'text.list', 'text.listStyle', 'layer.opacity'])
    expect(fieldIds([note])).toEqual(['fill.paint', 'text.fontFamily', 'text.fontSize', 'text.bold', 'text.italic', 'text.underline', 'text.strikethrough', 'text.lineHeight', 'text.letterSpacing', 'text.color', 'text.align', 'text.list', 'text.listStyle', 'layer.opacity'])
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
    const fill = fields.find((f) => f.field.id === 'fill.paint')!
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
    expect((strokeColorField.write(geo, { change: 'color', color: '#123456' }).props as { stroke: unknown }).stroke).toEqual(solidPaint('#123456'))
    expect((strokeColorField.write(arrow, { change: 'color', color: '#123456' }).props as { color: string }).color).toBe('#123456')
    expect((fillField.write(note, { change: 'color', color: '#abcdef' }).props as { color: string }).color).toBe('#abcdef')
    expect(strokeWidthField.write(geo, 2)).toBe(geo)
    expect(opacityField.write(geo, 1)).toBe(geo)
    expect(opacityField.write(geo, 0.5).opacity).toBe(0.5)
  })

  it('changes geo fill / stroke / strokeWidth and text fontSize / color / align, each undoable', () => {
    const { editor, geo, text } = setup()
    const apply = <T,>(node: NodeRecord, field: { write(node: NodeRecord, value: T): NodeRecord }, value: T) =>
      editNodes(editor, [node.id], (n) => field.write(n, value), 'design')
    apply(geo, fillField, { change: 'color', color: '#ff8800' })
    apply(geo, strokeColorField, { change: 'color', color: '#0000ff' })
    apply(geo, strokeWidthField, 6)
    apply(text, fontSizeField, 32)
    apply(text, textColorField, '#e03131')
    apply(text, textAlignField, 'center')
    expect(editor.getNode(geo.id)!.props).toMatchObject({ fill: solidPaint('#ff8800'), stroke: solidPaint('#0000ff'), strokeWidth: 6 })
    expect(editor.getNode(text.id)!.props).toMatchObject({ fontSize: 32, color: '#e03131', align: 'center' })
    editor.undo()
    expect(editor.getNode(text.id)!.props).toMatchObject({ fontSize: 32, color: '#e03131', align: 'left' })
    for (let i = 0; i < 5; i++) editor.undo()
    expect(editor.getNode(geo.id)!.props).toMatchObject({ fill: solidPaint('#e8eefc'), stroke: solidPaint('#3b5bdb'), strokeWidth: 2 })
    expect(editor.getNode(text.id)!.props).toMatchObject({ fontSize: 12, color: '#1f2328' })
  })

  it('accepts new sections from later tasks, ordered by order', () => {
    const extra: DesignSection = {
      id: 'test-border',
      title: 'ボーダー',
      order: 160,
      fields: [propField<number>({ id: 'border.offset', label: '位置', keys: { geo: 'borderOffset' }, control: { kind: 'number' }, fallback: 0 })],
    }
    const all = [...designSections(), extra].sort((a, b) => a.order - b.order)
    const { geo } = setup()
    expect(visibleSections([geo], all).map((s) => s.section.id)).toEqual(['shape', 'fill', 'corner', 'test-border', 'stroke', 'effects', 'layer'])
    expect(visibleSections([geo], all)[3].fields[0].value).toEqual({ kind: 'same', value: 0 })
    // 同じ id で登録し直すと置き換わる
    registerDesignSection({ ...extra, id: 'fill', order: 100 })
    expect(designSections().filter((s) => s.id === 'fill')).toHaveLength(1)
    expect(designSections().find((s) => s.id === 'fill')!.title).toBe('ボーダー')
    registerDesignSection({ id: 'fill', title: '塗り', order: 100, fields: [fillField] })
  })
})

describe('border fields (MAI-85)', () => {
  it('shows position and dash only for shapes with a stroke, and the dash lengths per dash style', () => {
    const { editor, geo, geo2, arrow } = setup()
    expect(fieldIds([geo, geo2])).toContain('stroke.align')
    // 線なしの図形は、色と太さだけ
    editNodes(editor, [geo.id], (n) => strokeColorField.write(n, null), 'design')
    const noStroke = editor.getNode(geo.id)!
    expect((noStroke.props as { stroke: unknown }).stroke).toBeNull()
    expect(fieldIds([noStroke])).toEqual(['shape.shape', 'fill.paint', 'corner.radius', 'stroke.color', 'stroke.width', 'effects.shadows', 'layer.opacity'])
    // 破線は長さと間隔、点線は間隔だけ
    const dashed = strokeDashField.write(geo2, 'dashed')
    expect(fieldIds([dashed]).filter((id) => id.startsWith('stroke.'))).toEqual(['stroke.color', 'stroke.width', 'stroke.align', 'stroke.dash', 'stroke.dashLength', 'stroke.dashGap'])
    expect(fieldIds([strokeDashField.write(geo2, 'dotted')]).filter((id) => id.startsWith('stroke.dash'))).toEqual(['stroke.dash', 'stroke.dashGap'])
    // 矢印と混ぜれば、共通の色と太さだけ（線なしは選べない）
    expect(fieldIds([dashed, arrow])).toEqual(['stroke.color', 'stroke.width', 'layer.opacity'])
    const control = strokeColorField.control as { none: (node: NodeRecord) => boolean; opacity: (node: NodeRecord) => boolean }
    expect(control.none(arrow)).toBe(false)
    expect(control.opacity(geo2)).toBe(true)
  })

  it('writes the stroke paint, position, dash style and lengths', () => {
    const { geo, arrow } = setup()
    const translucent = strokeColorField.write(geo, { change: 'opacity', opacity: 0.4 })
    expect((translucent.props as { stroke: unknown }).stroke).toEqual(solidPaint('#3b5bdb', 0.4))
    expect(strokeColorField.read(translucent)).toEqual(solidPaint('#3b5bdb', 0.4))
    // 矢印は色だけ。不透明度・線なしは変えない
    expect(strokeColorField.write(arrow, { change: 'opacity', opacity: 0.4 })).toBe(arrow)
    expect(strokeColorField.write(arrow, null)).toBe(arrow)
    // 太さ 0 の図形に線を足すと、既定の太さになる
    const thin = { ...geo, props: { ...(geo.props as object), stroke: null, strokeWidth: 0 } }
    expect(strokeColorField.write(thin, solidPaint('#ff0000')).props).toMatchObject({ stroke: solidPaint('#ff0000'), strokeWidth: 2 })

    expect(strokeAlignField.read(geo)).toBe('center')
    expect(strokeAlignField.write(geo, 'center')).toBe(geo)
    expect(strokeAlignField.write(geo, 'outside').props).toMatchObject({ strokeAlign: 'outside' })
    // 破線にすると、太さに合わせた長さ・間隔（px）を入れる。持っていれば、それを使う
    const dashed = strokeDashField.write(geo, 'dashed')
    expect(dashed.props).toMatchObject({ strokeDash: 'dashed', strokeDashLength: 8, strokeDashGap: 4 })
    const longer = strokeDashLengthField.write(dashed, 20)
    expect(longer.props).toMatchObject({ strokeDashLength: 20 })
    expect(strokeDashGapField.write(longer, 0).props).toMatchObject({ strokeDashGap: 0.5 })
    const solid = strokeDashField.write(longer, 'solid')
    expect(strokeDashField.write(solid, 'dotted').props).toMatchObject({ strokeDash: 'dotted', strokeDashLength: 20, strokeDashGap: 4 })
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

describe('line height field (MAI-76)', () => {
  const valueOf = (nodes: NodeRecord[]) =>
    visibleSections(nodes)
      .flatMap((s) => s.fields)
      .find((f) => f.field.id === 'text.lineHeight')!.value

  it('reads the default multiplier of each type for records without lineHeight', () => {
    const { text, note } = setup()
    expect((text.props as TextProps).lineHeight).toBeUndefined()
    expect(valueOf([text])).toEqual({ kind: 'same', value: { unit: 'multiplier', value: 1.35 } })
    expect(valueOf([note])).toEqual({ kind: 'same', value: { unit: 'multiplier', value: 1.4 } })
    expect(valueOf([text, note]).kind).toBe('mixed')
  })

  it('writes a multiplier or pixels to the node, and is undoable', () => {
    const { editor, text } = setup()
    expect(lineHeightField.write(text, { unit: 'multiplier', value: 1.35 })).toBe(text)
    editNodes(editor, [text.id], (node) => lineHeightField.write(node, { unit: 'px', value: 24 }), 'test')
    const changed = editor.getNode(text.id)!
    expect((changed.props as TextProps).lineHeight).toEqual({ unit: 'px', value: 24 })
    expect(valueOf([changed])).toEqual({ kind: 'same', value: { unit: 'px', value: 24 } })
    editor.undo()
    expect((editor.getNode(text.id)!.props as TextProps).lineHeight).toBeUndefined()
  })

  it('switches the unit keeping the look, per node by its own font size', () => {
    const { text, note } = setup()
    const big = { ...note, props: { ...(note.props as NoteProps), fontSize: 20 } }
    // テキストは 12px × 1.35、付箋は 20px × 1.4
    expect(lineHeightField.write(text, { convertTo: 'px' }).props).toMatchObject({ lineHeight: { unit: 'px', value: 16.2 } })
    expect(lineHeightField.write(big, { convertTo: 'px' }).props).toMatchObject({ lineHeight: { unit: 'px', value: 28 } })
    expect(lineHeightField.write(text, { convertTo: 'multiplier' })).toBe(text)
  })
})

describe('letter spacing field (MAI-77)', () => {
  const valueOf = (nodes: NodeRecord[]) =>
    visibleSections(nodes)
      .flatMap((s) => s.fields)
      .find((f) => f.field.id === 'text.letterSpacing')!.value

  it('reads 0 for records without letterSpacing, and shows it as % of the font size', () => {
    const { text, note } = setup()
    expect((text.props as TextProps).letterSpacing).toBeUndefined()
    expect(valueOf([text, note])).toEqual({ kind: 'same', value: 0 })
    const control = letterSpacingField.control as Extract<typeof letterSpacingField.control, { kind: 'number' }>
    expect(control.toDisplay!(0.05)).toBe(5)
    expect(control.fromDisplay!(-2.5)).toBe(-0.025)
  })

  it('writes em to the node, and is undoable', () => {
    const { editor, text, note } = setup()
    expect(letterSpacingField.write(text, 0)).toBe(text)
    editNodes(editor, [text.id, note.id], (node) => letterSpacingField.write(node, 0.1), 'test')
    expect((editor.getNode(text.id)!.props as TextProps).letterSpacing).toBe(0.1)
    expect((editor.getNode(note.id)!.props as NoteProps).letterSpacing).toBe(0.1)
    editor.undo()
    expect((editor.getNode(text.id)!.props as TextProps).letterSpacing).toBeUndefined()
  })
})

describe('list fields (MAI-78)', () => {
  const bullet = (level = 0) => ({ type: 'bullet' as const, level })
  function setupList() {
    const editor = new Editor()
    const text = editor.makeNode('text', {
      x: 0,
      y: 0,
      props: { paragraphs: [{ runs: [{ text: 'a' }], list: bullet() }, { runs: [{ text: 'b' }], list: bullet(1) }, { runs: [{ text: 'c' }] }] },
    })
    editor.createNodes([text])
    return { editor, text: editor.getNode(text.id)! }
  }
  const valueOf = (nodes: NodeRecord[], id: string, selection: TextSelection | null = null) =>
    visibleSections(nodes, undefined, selection)
      .flatMap((s) => s.fields)
      .find((f) => f.field.id === id)!.value
  const lists = (node: NodeRecord) => (node.props as TextProps).paragraphs.map((p) => p.list)

  it('shows the list type and style of the paragraphs, mixed when they differ', () => {
    const { text } = setupList()
    expect(valueOf([text], 'text.list')).toEqual({ kind: 'mixed', values: ['bullet', 'bullet', 'none'] })
    expect(valueOf([text], 'text.list', { nodeId: text.id, start: 0, end: 3 })).toEqual({ kind: 'same', value: 'bullet' })
    // 形は一番浅い階層の段落（a と c）の値
    expect(valueOf([text], 'text.listStyle')).toEqual({ kind: 'mixed', values: ['disc', 'none'] })
    expect(valueOf([text], 'text.listStyle', { nodeId: text.id, start: 2, end: 3 })).toEqual({ kind: 'same', value: 'circle' })
  })

  it('writes to the paragraphs of the selected range, or to all paragraphs', () => {
    const { text } = setupList()
    expect(lists(listTypeField.write(text, 'ordered', { start: 2, end: 5 }))).toEqual([bullet(), { type: 'ordered', level: 1 }, { type: 'ordered', level: 0 }])
    expect(lists(listTypeField.write(text, 'none'))).toEqual([undefined, undefined, undefined])
    expect(lists(listStyleField.write(text, 'check'))).toEqual([{ ...bullet(), style: 'check' }, bullet(1), { ...bullet(), style: 'check' }])
    expect(lists(listStyleField.write(text, 'none', { start: 0, end: 1 }))).toEqual([undefined, bullet(1), undefined])
    const same = listTypeField.write(text, 'bullet', { start: 0, end: 3 })
    expect(same).toBe(text)
  })
})

describe('bold, italic, underline and strikethrough (MAI-79)', () => {
  it('shows mixed per format, and toggles all the characters of the whole node (no default in the props)', () => {
    const editor = new Editor()
    const made = editor.makeNode('text', {
      x: 0,
      y: 0,
      props: { paragraphs: [{ runs: [{ text: 'ab', format: { bold: true } }, { text: 'cd', format: { bold: true, italic: true } }] }] },
    })
    editor.createNodes([made])
    const text = editor.getNode(made.id)!
    const valueOf = (node: NodeRecord, id: string, selection: TextSelection | null = null) =>
      visibleSections([node], undefined, selection)
        .flatMap((s) => s.fields)
        .find((f) => f.field.id === id)!.value
    expect(valueOf(text, 'text.bold')).toEqual({ kind: 'same', value: true })
    expect(valueOf(text, 'text.italic')).toEqual({ kind: 'mixed', values: [false, true] })
    expect(valueOf(text, 'text.italic', { nodeId: text.id, start: 2, end: 4 })).toEqual({ kind: 'same', value: true })
    expect(valueOf(text, 'text.underline')).toEqual({ kind: 'same', value: false })
    // ノード全体：すべての文字に当てる。props には既定を持たせない
    const italic = italicField.write(text, true, null)
    expect((italic.props as TextProps).paragraphs).toEqual([{ runs: [{ text: 'abcd', format: { bold: true, italic: true } }] }])
    expect('italic' in (italic.props as object)).toBe(false)
    const plain = boldField.write(italicField.write(italic, false, null), false, null)
    expect((plain.props as TextProps).paragraphs).toEqual([{ runs: [{ text: 'abcd' }] }])
    // 範囲
    const ranged = strikethroughField.write(text, true, { start: 0, end: 1 })
    expect((ranged.props as TextProps).paragraphs[0].runs[0]).toEqual({ text: 'a', format: { bold: true, strikethrough: true } })
  })
})

// 塗り（MAI-81）
describe('fill field', () => {
  it('reads the geo fill as a paint and the note background as a solid paint', () => {
    const { geo, geo2, note } = setup()
    expect(fillField.read(geo)).toEqual(solidPaint('#e8eefc'))
    expect(fillField.read(geo2)).toEqual(solidPaint('#ff0000'))
    expect(fillField.read(note)).toEqual(solidPaint('#fff3bf'))
  })

  it('changes only the color or only the opacity, keeping the other part', () => {
    const { geo } = setup()
    const half = fillField.write(geo, { change: 'opacity', opacity: 0.5 })
    expect((half.props as { fill: unknown }).fill).toEqual(solidPaint('#e8eefc', 0.5))
    const red = fillField.write(half, { change: 'color', color: '#ff0000' })
    expect((red.props as { fill: unknown }).fill).toEqual(solidPaint('#ff0000', 0.5))
    expect(fillField.write(red, { change: 'color', color: '#ff0000' })).toBe(red)
  })

  it('removes the fill and adds it back from a color', () => {
    const { geo } = setup()
    const none = fillField.write(geo, null)
    expect((none.props as { fill: unknown }).fill).toBeNull()
    // 塗りなしの不透明度は変えられない。色を選べば不透明な単色の塗りになる
    expect(fillField.write(none, { change: 'opacity', opacity: 0.3 })).toBe(none)
    expect((fillField.write(none, { change: 'color', color: '#00ff00' }).props as { fill: unknown }).fill).toEqual(solidPaint('#00ff00'))
  })

  it('keeps the note background solid (no opacity, no none)', () => {
    const { note } = setup()
    expect(fillField.write(note, null)).toBe(note)
    expect(fillField.write(note, { change: 'opacity', opacity: 0.2 })).toBe(note)
    const control = fillField.control as Extract<typeof fillField.control, { kind: 'paint' }>
    expect(control.opacity?.(note)).toBe(false)
    expect(control.none?.(note)).toBe(false)
  })

  it('applies a change to several fills, each keeping its own color', () => {
    expect(applyFillChange(solidPaint('#ff0000'), { change: 'opacity', opacity: 0.25 })).toEqual(solidPaint('#ff0000', 0.25))
    expect(applyFillChange(solidPaint('#00ff00', 0.4), { change: 'opacity', opacity: 2 })).toEqual(solidPaint('#00ff00', 1))
    expect(applyFillChange(solidPaint('#00ff00'), solidPaint('#123456'))).toEqual(solidPaint('#123456'))
  })

  // グラデーション（MAI-82）
  it('switches the paint type from the current color and back', () => {
    const { geo, note } = setup()
    const linear = fillField.write(geo, { change: 'type', type: 'linear' })
    expect((linear.props as { fill: unknown }).fill).toEqual(linearGradient([gradientStop(0, '#e8eefc', 1), gradientStop(1, '#e8eefc', 0)]))
    const radial = fillField.write(linear, { change: 'type', type: 'radial' })
    expect((radial.props as { fill: { type: string } }).fill.type).toBe('radial')
    expect((fillField.write(radial, { change: 'type', type: 'solid' }).props as { fill: unknown }).fill).toEqual(solidPaint('#e8eefc'))
    // 付箋の地はグラデーションにしない
    const control = fillField.control as Extract<typeof fillField.control, { kind: 'paint' }>
    expect(control.gradient?.(note)).toBe(false)
    expect(control.gradient?.(geo)).toBe(true)
    expect(fillField.write(note, { change: 'type', type: 'linear' })).toBe(note)
  })

  it('changes the stops, the angle in the size of each shape, and the radial center and radius', () => {
    const stops = [gradientStop(0, '#000000'), gradientStop(1, '#ffffff')]
    const linear = linearGradient(stops)
    // 横長の箱の 0°（左から右）
    expect(applyFillChange(linear, { change: 'angle', angle: 0 }, { w: 200, h: 100 })).toMatchObject({ start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 } })
    const three = [...stops, gradientStop(0.5, '#ff0000')]
    expect((applyFillChange(linear, { change: 'stops', stops: three }) as typeof linear).stops.map((s) => s.position)).toEqual([0, 0.5, 1])
    // 止め色は 2 つより少なくしない
    expect(applyFillChange(linear, { change: 'stops', stops: [stops[0]] })).toBe(linear)
    const radial = radialGradient(stops)
    expect(applyFillChange(radial, { change: 'radial', center: { x: 0.2, y: 0.3 } })).toMatchObject({ center: { x: 0.2, y: 0.3 }, radius: 0.5 })
    expect(applyFillChange(radial, { change: 'radial', radius: 0.8 })).toMatchObject({ center: { x: 0.5, y: 0.5 }, radius: 0.8 })
    // 単色に角度は当たらない
    expect(applyFillChange(solidPaint('#ff0000'), { change: 'angle', angle: 30 })).toEqual(solidPaint('#ff0000'))
  })

  // 画像（MAI-83）
  it('sets an image, keeping the opacity, and switches how it is shown', () => {
    const { geo, note } = setup()
    const half = fillField.write(geo, { change: 'opacity', opacity: 0.5 })
    const image = fillField.write(half, { change: 'image', assetId: 'asset:a' })
    expect((image.props as { fill: unknown }).fill).toEqual(imagePaint('asset:a', { opacity: 0.5 }))
    // 画像を差し替えても、表示のしかたはそのまま
    const tiled = applyFillChange(imagePaint('asset:a', { scaleMode: 'tile', tileScale: 2 }), { change: 'image', assetId: 'asset:b' })
    expect(tiled).toEqual(imagePaint('asset:b', { scaleMode: 'tile', tileScale: 2 }))
    expect(applyFillChange(tiled, { change: 'tileScale', tileScale: 0 })).toMatchObject({ tileScale: 1 })
    // 切り抜きへは、塗りつぶしで見えていた範囲から（横長の画像を正方形の図形に）
    const cropped = applyFillChange(imagePaint('asset:a'), { change: 'scaleMode', scaleMode: 'crop', image: { width: 400, height: 200 } }, { w: 100, h: 100 })
    expect(cropped).toMatchObject({ scaleMode: 'crop', crop: { x: 0.25, y: 0, w: 0.5, h: 1 } })
    expect(applyFillChange(cropped, { change: 'crop', crop: { x: 0.1 } })).toMatchObject({ crop: { x: 0.1, y: 0, w: 0.5, h: 1 } })
    // 切り抜いた範囲は、ほかのモードへ切り替えても覚えておく
    const fit = applyFillChange(cropped, { change: 'scaleMode', scaleMode: 'fit' })
    expect(fit).toMatchObject({ scaleMode: 'fit', crop: { x: 0.25, y: 0, w: 0.5, h: 1 } })
    // 画像から単色へ戻せる。付箋の地は画像にしない
    expect((fillField.write(image, { change: 'type', type: 'solid' }).props as { fill: unknown }).fill).toEqual(solidPaint('#e8eefc', 0.5))
    const control = fillField.control as Extract<typeof fillField.control, { kind: 'paint' }>
    expect(control.image?.(note)).toBe(false)
    expect(control.image?.(geo)).toBe(true)
  })
})

describe('corner radius field (MAI-84)', () => {
  it('shows only for rectangles, reading 0 for records without cornerRadius', () => {
    const { geo, geo2, text } = setup()
    expect(fieldIds([geo])).toContain('corner.radius')
    expect(fieldIds([geo2])).not.toContain('corner.radius')
    expect(fieldIds([geo, geo2])).not.toContain('corner.radius')
    expect(fieldIds([geo, text])).not.toContain('corner.radius')
    expect(visibleSections([geo]).find((s) => s.section.id === 'corner')!.fields[0].value).toEqual({ kind: 'same', value: 0 })
  })

  it('writes all corners as a number, or one corner as [tl, tr, br, bl], and is undoable', () => {
    const { editor, geo } = setup()
    const radius = () => (editor.getNode(geo.id)!.props as { cornerRadius?: unknown }).cornerRadius
    editNodes(editor, [geo.id], (node) => cornerRadiusField.write(node, { corner: null, radius: 12 }), 'design')
    expect(radius()).toBe(12)
    editNodes(editor, [geo.id], (node) => cornerRadiusField.write(node, { corner: 2, radius: 30 }), 'design')
    expect(radius()).toEqual([12, 12, 30, 12])
    // 4 つが同じになれば数値にまとめる
    editNodes(editor, [geo.id], (node) => cornerRadiusField.write(node, { corner: 2, radius: 12 }), 'design')
    expect(radius()).toBe(12)
    // 同じ値なら変えない
    const node = editor.getNode(geo.id)!
    expect(cornerRadiusField.write(node, { corner: null, radius: 12 })).toBe(node)
    editor.undo()
    expect(radius()).toEqual([12, 12, 30, 12])
    editor.undo()
    editor.undo()
    expect(radius()).toBeUndefined()
  })

  it('reports mixed values when the selected rectangles differ', () => {
    const { editor, geo } = setup()
    const other = editor.makeNode('geo', { x: 0, y: 600, props: { shape: 'rect', w: 100, h: 100, cornerRadius: [4, 0, 0, 0] } })
    editor.createNodes([other])
    const value = visibleSections([editor.getNode(geo.id)!, editor.getNode(other.id)!]).find((s) => s.section.id === 'corner')!.fields[0].value
    expect(value).toEqual({ kind: 'mixed', values: [0, [4, 0, 0, 0]] })
  })
})

describe('shadows field (MAI-86)', () => {
  it('shows only for shapes, reading no shadows for old records', () => {
    const { geo, geo2, text, arrow } = setup()
    expect(fieldIds([geo, geo2])).toContain('effects.shadows')
    expect(fieldIds([geo, arrow])).not.toContain('effects.shadows')
    expect(fieldIds([text])).not.toContain('effects.shadows')
    expect(visibleSections([geo]).find((s) => s.section.id === 'effects')!.fields[0].value).toEqual({ kind: 'same', value: [] })
  })

  it('adds, updates, hides and removes shadows, and is undoable', () => {
    const { editor, geo, geo2 } = setup()
    const shadows = (id: string) => (editor.getNode(id)!.props as { shadows?: unknown }).shadows
    const ids = [geo.id, geo2.id]
    editNodes(editor, ids, (node) => shadowsField.write(node, { op: 'add' }), 'design')
    expect(shadows(geo.id)).toEqual([defaultShadow()])
    expect(shadows(geo2.id)).toEqual([defaultShadow()])
    editNodes(editor, ids, (node) => shadowsField.write(node, { op: 'add' }), 'design')
    editNodes(editor, ids, (node) => shadowsField.write(node, { op: 'update', index: 1, patch: { type: 'inner', x: 3, color: '#ff0000' } }), 'design')
    expect(shadows(geo.id)).toEqual([defaultShadow(), { ...defaultShadow(), type: 'inner', x: 3, color: '#ff0000' }])
    // 隠す・表示する（表示は値を持たない）
    editNodes(editor, ids, (node) => shadowsField.write(node, { op: 'update', index: 0, patch: { visible: false } }), 'design')
    expect((shadows(geo.id) as { visible?: boolean }[])[0].visible).toBe(false)
    editNodes(editor, ids, (node) => shadowsField.write(node, { op: 'update', index: 0, patch: { visible: true } }), 'design')
    expect(shadows(geo.id) as object[]).toEqual([defaultShadow(), expect.objectContaining({ type: 'inner' })])
    expect('visible' in (shadows(geo.id) as object[])[0]).toBe(false)
    // 範囲に収める
    editNodes(editor, [geo.id], (node) => shadowsField.write(node, { op: 'update', index: 0, patch: { blur: -5, opacity: 2 } }), 'design')
    expect((shadows(geo.id) as { blur: number; opacity: number }[])[0]).toMatchObject({ blur: 0, opacity: 1 })
    // 消して空になれば、値も持たない
    editNodes(editor, ids, (node) => shadowsField.write(node, { op: 'remove', index: 0 }), 'design')
    editNodes(editor, ids, (node) => shadowsField.write(node, { op: 'remove', index: 0 }), 'design')
    expect(shadows(geo.id)).toBeUndefined()
    // 同じ値なら変えない
    const node = editor.getNode(geo.id)!
    expect(shadowsField.write(node, { op: 'remove', index: 0 })).toBe(node)
    editor.undo()
    expect(shadows(geo.id)).toHaveLength(1)
  })

  it('reports mixed values per shadow, or the whole list when the structure differs', () => {
    const { editor, geo, geo2 } = setup()
    editNodes(editor, [geo.id, geo2.id], (node) => shadowsField.write(node, { op: 'add' }), 'design')
    editNodes(editor, [geo2.id], (node) => shadowsField.write(node, { op: 'update', index: 0, patch: { x: 8 } }), 'design')
    const value = () => visibleSections([editor.getNode(geo.id)!, editor.getNode(geo2.id)!]).find((s) => s.section.id === 'effects')!.fields[0].value
    // 数と種類が同じ：影ごとに比べる
    const rows = shadowRows(value() as never)!
    expect(rows).toHaveLength(1)
    expect(rows[0].map((s) => s.x)).toEqual([0, 8])
    // 種類が違えば、一覧ごと混在。＋は既定の影 1 つに置き換える
    editNodes(editor, [geo2.id], (node) => shadowsField.write(node, { op: 'update', index: 0, patch: { type: 'inner' } }), 'design')
    expect(shadowRows(value() as never)).toBeNull()
    expect(applyShadowsChange([], [defaultShadow(), { bad: true } as never])).toEqual([defaultShadow()])
  })
})

// 図形の形とブロック矢印の形のパラメータ（MAI-87）
describe('shape section', () => {
  it('switches the shape and shows the block arrow parameters only for block arrows', () => {
    const { editor, geo, geo2 } = setup()
    editNodes(editor, [geo.id], (n) => geoShapeField.write(n, 'blockArrow'), 'design')
    const arrow = editor.getNode(geo.id)!
    expect(arrow.props).toMatchObject({ shape: 'blockArrow', fill: solidPaint('#e8eefc') })
    expect(fieldIds([arrow]).slice(0, 4)).toEqual(['shape.shape', 'shape.arrowShaft', 'shape.arrowHeadLength', 'shape.arrowHeadWidth'])
    // 値がないときは形の既定を見せる
    expect(visibleSections([arrow])[0].fields.map((f) => f.value)).toEqual([
      { kind: 'same', value: 'blockArrow' },
      { kind: 'same', value: 0.5 },
      { kind: 'same', value: 0.5 },
      { kind: 'same', value: 1 },
    ])
    // シェブロンは切り込みだけ。矩形と混ぜると形だけ（混在）
    const chevron = { ...arrow, props: { ...arrow.props, shape: 'chevron' } }
    expect(fieldIds([chevron]).slice(0, 2)).toEqual(['shape.shape', 'shape.chevronDepth'])
    expect(visibleSections([arrow, geo2])[0].fields.map((f) => f.field.id)).toEqual(['shape.shape'])
    expect(visibleSections([arrow, geo2])[0].fields[0].value.kind).toBe('mixed')
    // 値を書き、形を変えると値は消える。それぞれ Undo できる
    editNodes(editor, [geo.id], (n) => arrowShaftField.write(n, 0.3), 'design')
    editNodes(editor, [geo.id], (n) => arrowHeadWidthField.write(n, 20), 'design')
    expect(editor.getNode(geo.id)!.props).toMatchObject({ arrowShaft: 0.3, arrowHeadWidth: 10 })
    expect(arrowHeadLengthField.write(editor.getNode(geo.id)!, 0.5)).not.toBe(editor.getNode(geo.id))
    expect(chevronDepthField.appliesTo(editor.getNode(geo.id)!)).toBe(false)
    editNodes(editor, [geo.id], (n) => geoShapeField.write(n, 'chevron'), 'design')
    expect(editor.getNode(geo.id)!.props).not.toHaveProperty('arrowShaft')
    editor.undo()
    expect(editor.getNode(geo.id)!.props).toMatchObject({ shape: 'blockArrow', arrowShaft: 0.3 })
    expect(geoShapeField.write(editor.getNode(geo.id)!, 'blockArrow')).toBe(editor.getNode(geo.id))
  })
})
