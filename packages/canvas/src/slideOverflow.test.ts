import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { resetTextMetrics, richTextFromPlain, slotsOf, solidPaint, type SlideLayoutKind, type SlideLayoutProps } from '@canvcode/nodes'
import { Editor, nodeIn } from './editor.ts'
import { drawOverlay, type Viewport } from './renderer.ts'
import { slideLayoutMaxRows } from './slideLayoutArrange.ts'
import { slideLayoutOverflow } from './slideOverflow.ts'

// スライドの中のあふれ（スライド v2）。文字は縮めずに折り返し、セルからあふれたら印と警告を出す

// 文字の大きさ 30 の n 行の文字（1 行は 40.5 の高さ。余白は四方 8）
const lines = (n: number) => Array.from({ length: n }, (_, i) => `行${i}`).join('\n')

// スライドと、その中の slide-layout（タイトル・パネルと n 行。table なら見出しと本文）
function setup(n = 3, layout: SlideLayoutKind = 'table', editor = new Editor({ canvasId: 'canvas:1' })) {
  const slide = editor.makeNode('slide', { x: 0, y: 0, props: { ratio: '16:9', name: 'S', hidden: false } })
  const node = editor.makeNode('slide-layout', { x: 0, y: 0, parentId: slide.id, props: { layout, w: 1920, h: 1080, slots: { rows: [] } } })
  editor.createNodes([slide, node])
  const make = (type: string, props: object) => editor.makeNode(type, { x: 0, y: 0, parentId: node.id, props })
  const cell = (value: string) =>
    make('geo', { shape: 'rect', w: 100, h: 100, fill: solidPaint('#ffffff'), stroke: null, label: value, labelParagraphs: richTextFromPlain(value), labelFontSize: 30 })
  const title = make('text', { paragraphs: richTextFromPlain('題名'), fontSize: 40, autoWidth: false, w: 400 })
  const children: NodeRecord[] = [title]
  const rows: SlideLayoutProps['slots']['rows'] = []
  for (let i = 0; i < n; i++) {
    const label = cell(`見出し${i}`)
    const body = cell(`本文${i}`)
    children.push(label, body)
    rows.push({ label: label.id, body: body.id })
  }
  editor.transact('setup', (tx) => {
    for (const child of children) tx.put(child)
    tx.put({ ...node, props: { ...node.props, slots: { title: title.id, rows } } })
  })
  // セルの文字を変える
  const setText = (id: string, value: string) =>
    editor.transact('edit', (tx) => {
      const cellNode = nodeIn(tx, id)!
      tx.put({ ...cellNode, props: { ...cellNode.props, label: value, labelParagraphs: richTextFromPlain(value) } })
    })
  // タイトルの文字を変える
  const setTitle = (value: string) =>
    editor.transact('edit', (tx) => {
      const titleNode = nodeIn(tx, title.id)!
      tx.put({ ...titleNode, props: { ...titleNode.props, paragraphs: richTextFromPlain(value) } })
    })
  return { editor, slide: slide.id, layout: node.id, title: title.id, rows, setText, setTitle }
}

// 行数の上限（セルの文字の大きさで決まる。行はみな同じ書式なので、1 行で測る）
function maxRows(layout: SlideLayoutKind): number {
  const { editor, layout: id } = setup(1, layout)
  const rows = slotsOf((editor.getNode(id)!.props as Record<string, unknown>).slots).rows
  return slideLayoutMaxRows(layout, rows, (x) => (x ? (editor.getNode(x) ?? undefined) : undefined))
}

describe('slideLayoutOverflow', () => {
  it('reports the geo cells whose text does not fit, and the rows over the limit', () => {
    const { editor, layout, rows } = setup(maxRows('table') + 2)
    const children = new Map(editor.index.childrenOf(layout).map((id) => [id, editor.getNode(id)!]))
    expect(slideLayoutOverflow(editor.getNode(layout)!, children)).toEqual({ nodes: [], extraRows: 2 })
    // 並べなかった行のセルは測らない
    const long = (id: string) => ({ ...children.get(id)!, props: { ...children.get(id)!.props, label: lines(8), labelParagraphs: richTextFromPlain(lines(8)) } })
    const last = rows.at(-1)!.body
    const first = rows[0].body
    const next = new Map(children).set(first, long(first)).set(last, long(last))
    expect(slideLayoutOverflow(editor.getNode(layout)!, next)).toEqual({ nodes: [first], extraRows: 2 })
  })
})

describe('Editor.slideOverflows', () => {
  it('finds no overflow for short text, including the templates', () => {
    const { editor } = setup()
    expect(editor.slideOverflows().size).toBe(0)
    for (const kind of ['title', 'bullets', 'table', 'table-image'] as const) {
      const slide = editor.makeNode('slide', { x: 0, y: 5000, props: { ratio: '16:9', name: '', hidden: false } })
      editor.createNodes([slide])
      editor.applySlideTemplate(slide.id, kind)
      expect(editor.slideOverflows().has(slide.id)).toBe(false)
      editor.deleteNodes([slide.id])
    }
  })

  it('reports cells whose long text overflows, and cells that overflow once rows are added', () => {
    const { editor, slide, rows, setText } = setup()
    // 行の高さは文字に合わせて配分する（8 行の文字は、全高のパネルにしてほかの行を縮めれば収まる）。
    // 14 行の文字は、ほかの行を最小（68）にしても入らないので、一律の高さのままあふれる
    setText(rows[0].body, lines(8))
    expect(editor.slideOverflows().size).toBe(0)
    setText(rows[0].body, lines(14))
    expect(editor.slideOverflows().get(slide)).toEqual({ nodes: [rows[0].body], extraRows: 0 })
    expect(editor.slides.overflows?.(slide)).toBe(true)
    // 3 行の文字は、3 行のときの行（高さ 150）には収まるが、6 行のときは、ほかの行を最小（68）にしても入らず、行（高さ 74）からあふれる
    setText(rows[0].body, lines(3))
    expect(editor.slideOverflows().size).toBe(0)
    expect(editor.slides.overflows?.(slide)).toBe(false)
    editor.setSelection([rows[0].body])
    for (let i = 0; i < 3; i++) expect(editor.addSlideLayoutRow()).toBe(true)
    expect(editor.slideOverflows().get(slide)?.nodes).toEqual([rows[0].body])
    editor.undo()
    editor.undo()
    editor.undo()
    expect(editor.slideOverflows().size).toBe(0)
  })

  it('reports a title of three lines or more (titles are up to two lines)', () => {
    const { editor, slide, title, setTitle } = setup()
    setTitle(lines(2))
    expect(editor.slideOverflows().size).toBe(0)
    setTitle(lines(3))
    expect(editor.slideOverflows().get(slide)).toEqual({ nodes: [title], extraRows: 0 })
    expect(editor.slides.overflows?.(slide)).toBe(true)
    // 上へ伸ばすのは 2 行分まで（3 行でも、タイトルの上端は 2 行のときと同じ）
    const titleY = () => editor.getNode(title)!.y
    const threeY = titleY()
    setTitle(lines(2))
    expect(titleY()).toBe(threeY)
    setTitle(lines(1))
    expect(titleY()).toBeGreaterThan(threeY)
    setTitle(lines(3))
    editor.undo()
    editor.undo()
    editor.undo()
    editor.undo()
    expect(editor.slideOverflows().size).toBe(0)
  })

  it('does not limit the lines of a cover title', () => {
    const { editor } = setup()
    const slide = editor.makeNode('slide', { x: 0, y: 5000, props: { ratio: '16:9', name: '', hidden: false } })
    editor.createNodes([slide])
    editor.applySlideTemplate(slide.id, 'title')
    const layout = editor.index.childrenOf(slide.id).find((id) => editor.getNode(id)?.type === 'slide-layout')!
    const titleId = (editor.getNode(layout)!.props as SlideLayoutProps).slots.title!
    editor.transact('edit', (tx) => {
      const titleNode = nodeIn(tx, titleId)!
      tx.put({ ...titleNode, props: { ...titleNode.props, paragraphs: richTextFromPlain(lines(4)) } })
    })
    expect(editor.slideOverflows().has(slide.id)).toBe(false)
  })

  it('counts the rows over the limit', () => {
    const { editor, slide } = setup(maxRows('bullets') + 1, 'bullets')
    expect(editor.slideOverflows().get(slide)).toEqual({ nodes: [], extraRows: 1 })
    expect(editor.slides.overflows?.(slide)).toBe(true)
  })

  it('ignores children of the slide that are not in the slots', () => {
    const { editor, slide } = setup()
    const loose = editor.makeNode('geo', {
      x: 0,
      y: 0,
      parentId: slide,
      props: { shape: 'rect', w: 100, h: 40, label: lines(8), labelParagraphs: richTextFromPlain(lines(8)), labelFontSize: 30 },
    })
    editor.createNodes([loose])
    expect(editor.slideOverflows().size).toBe(0)
  })

  it('does not count slides of another canvas, nor recompute for their changes', () => {
    const { editor } = setup()
    const { canvasId } = editor.createPortal({ x: -3000, y: 0 })
    const child = new Editor({ workspace: editor.workspace, canvasId })
    const other = setup(maxRows('table') + 1, 'table', child)
    const before = editor.slideOverflows()
    other.setText(other.rows[0].body, lines(8))
    expect(editor.slideOverflows()).toBe(before)
    expect(editor.slideOverflows().size).toBe(0)
    expect(child.slideOverflows().get(other.slide)).toEqual({ nodes: [other.rows[0].body], extraRows: 1 })
    child.dispose()
  })

  it('keeps the result while nothing related changes', () => {
    const { editor, slide, rows, setText } = setup()
    const first = editor.slideOverflows()
    expect(editor.slideOverflows()).toBe(first)
    const rect = editor.makeNode('geo', { x: 0, y: 3000, props: { shape: 'rect', w: 100, h: 100 } })
    editor.createNodes([rect])
    editor.moveNodes([rect.id], 10, 0)
    // スライドの外の変更では計算し直さない
    expect(editor.slideOverflows()).toBe(first)
    // フォントを読み込み終えて測り直すときは計算し直す
    resetTextMetrics()
    const remeasured = editor.slideOverflows()
    expect(remeasured).not.toBe(first)
    setText(rows[1].body, lines(8))
    expect(editor.slideOverflows()).not.toBe(remeasured)
    // スライドを消せば、そのスライドのあふれも消える
    editor.deleteNodes([slide])
    expect(editor.slideOverflows().size).toBe(0)
  })
})

describe('showing overflows', () => {
  it('widens the name hit area to the label with the warning', () => {
    const { editor, slide, rows, setText } = setup()
    // 名前の「1. S」は 4 文字分（12 × 4 + 8 = 56）
    expect(editor.hitTest({ x: 60, y: -5 }, 0)).toBeNull()
    setText(rows[0].body, lines(14))
    // 「1. S ⚠ あふれ」は 10 文字分（12 × 10 + 8 = 128）
    expect(editor.hitTest({ x: 120, y: -5 }, 0)?.id).toBe(slide)
    expect(editor.hitTest({ x: 135, y: -5 }, 0)).toBeNull()
  })

  it('outlines the overflowing cells on screen, but not for print', () => {
    const { editor, rows, setText } = setup()
    setText(rows[0].body, lines(14))
    const view: Viewport = { camera: { x: -100, y: -100, zoom: 0.5 }, width: 2000, height: 1000, dpr: 2 }
    const strokes = (print: boolean) => {
      const drawn: { color: unknown; width: unknown }[] = []
      const state: Record<string, unknown> = {}
      const ctx = new Proxy(state, {
        get(target, key) {
          if (key === 'stroke') return () => drawn.push({ color: target.strokeStyle, width: target.lineWidth })
          if (key in target) return target[key as string]
          return () => {}
        },
        set(target, key, value) {
          target[key as string] = value
          return true
        },
      }) as unknown as CanvasRenderingContext2D
      drawOverlay(ctx, editor, { ...view, print }, { lifted: new Set(), selectedIds: new Set(), hoveredId: null, brush: null, focusedGroupId: null })
      return drawn
    }
    // 倍率によらず 2 CSS ピクセル（dpr 2 なら 4 物理ピクセル）の赤い枠
    expect(strokes(false)).toEqual([{ color: '#e03131', width: 4 }])
    expect(strokes(true)).toEqual([])
  })
})
