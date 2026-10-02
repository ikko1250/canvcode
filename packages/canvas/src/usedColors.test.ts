import { describe, expect, it } from 'vitest'
import { richTextFromPlain, solidPaint, applyRunFormat } from '@canvcode/nodes'
import { Editor } from './editor.ts'
import { usedColors } from './usedColors.ts'

// 「このキャンバスで使った色」（MAI-81）

describe('used colors', () => {
  it('collects fill, stroke, text, run and pen colors, most used first', () => {
    const editor = new Editor()
    // makeNode は今の一番手前の上に重ねる index を付けるので、1 つずつ作る
    const add = (node: ReturnType<Editor['makeNode']>) => editor.createNodes([node])
    add(editor.makeNode('geo', { x: 0, y: 0, props: { shape: 'rect', w: 10, h: 10, fill: solidPaint('#FF0000'), stroke: '#0000ff' } }))
    add(editor.makeNode('geo', { x: 20, y: 0, props: { shape: 'rect', w: 10, h: 10, fill: solidPaint('#ff0000', 0.5), stroke: '#0000ff' } }))
    add(editor.makeNode('geo', { x: 40, y: 0, props: { shape: 'rect', w: 10, h: 10, fill: null, stroke: '#00ff00' } }))
    const base = { color: '#111111', fontSize: 12, fontFamily: 'sans-serif', bold: false, italic: false, underline: false, strikethrough: false }
    const paragraphs = applyRunFormat(richTextFromPlain('hello'), 0, 2, { color: '#ff0000' }, base)
    add(editor.makeNode('text', { x: 0, y: 40, props: { paragraphs, color: '#111111' } }))
    add(editor.makeNode('draw', { x: 0, y: 80, props: { points: [0, 0, 1, 1], color: '#e03131' } }))
    expect(usedColors(editor)).toEqual(['#ff0000', '#0000ff', '#00ff00', '#111111', '#e03131'])
    expect(usedColors(editor, 2)).toEqual(['#ff0000', '#0000ff'])
  })

  it('includes nodes inside groups and frames', () => {
    const editor = new Editor()
    const frame = editor.makeNode('frame', { x: 0, y: 0, props: { w: 200, h: 200 } })
    const inner = editor.makeNode('geo', { x: 10, y: 10, parentId: frame.id, props: { shape: 'rect', w: 10, h: 10, fill: solidPaint('#123456'), strokeWidth: 0 } })
    editor.createNodes([frame, inner])
    expect(usedColors(editor)).toEqual(['#123456'])
  })
})
