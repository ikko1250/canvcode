import { describe, expect, it } from 'vitest'
import { geoLabelBox, plainTextOf, paragraphsOf, type GeoProps, type SlideLayoutKind, type SlideLayoutProps, type SlideRatio, type TextProps } from '@canvcode/nodes'
import {
  CANVAS_COVER_CREDITS_STYLE,
  CANVAS_SLIDE_FIGURE_STYLE,
  CANVAS_SLIDE_LABEL_STYLE,
  CANVAS_SLIDE_PANEL_STYLE,
  CANVAS_SLIDE_TITLE_STYLE,
  canvasCoverLayout,
  canvasSlideBodyFill,
  canvasSlideBodyStyle,
  canvasSlideLayout,
  type CanvasBox,
} from '@canvcode/slides'
import { Editor } from './editor.ts'
import { SLIDE_TEMPLATE_ROWS, slideCellProps, slideTemplateChildren, slideTemplateRowCount } from './slideTemplate.ts'

// スライドのテンプレート（スライド v2）：子の無いスライドに slide-layout とその子を 1 歩で作り、並べ直しが v1 の幾何どおりに置く

function setup(ratio: SlideRatio = '16:9') {
  const editor = new Editor({ canvasId: 'canvas:1' })
  const slide = editor.makeNode('slide', { x: 0, y: 0, props: { ratio, name: 'S1', hidden: false } })
  editor.createNodes([slide])
  return { editor, slide }
}

function layoutOf(editor: Editor, slideId: string) {
  const [layoutId] = editor.index.childrenOf(slideId)
  const layout = editor.getNode(layoutId)!
  return { layout, props: layout.props as SlideLayoutProps }
}

const boxOf = (editor: Editor, id: string): CanvasBox => {
  const node = editor.getNode(id)!
  const props = node.props as { w: number; h?: number }
  return node.type === 'text' ? { x: node.x, y: node.y, w: props.w, h: 0 } : { x: node.x, y: node.y, w: props.w, h: props.h! }
}

const near = (box: CanvasBox, expected: CanvasBox, withHeight = true) => {
  expect(box.x).toBeCloseTo(expected.x)
  expect(box.y).toBeCloseTo(expected.y)
  expect(box.w).toBeCloseTo(expected.w)
  if (withHeight) expect(box.h).toBeCloseTo(expected.h)
}

describe('slide templates', () => {
  it.each(['bullets', 'table', 'table-image'] as const)('lays out %s with the title, the panel and three rows at the v1 geometry', (kind) => {
    for (const ratio of ['16:9', '4:3'] as const) {
      const { editor, slide } = setup(ratio)
      expect(editor.applySlideTemplate(slide.id, kind)).toBe(true)
      const { layout, props } = layoutOf(editor, slide.id)
      expect(layout.type).toBe('slide-layout')
      expect(props.layout).toBe(kind)
      expect({ w: props.w, h: props.h }).toEqual(ratio === '4:3' ? { w: 1440, h: 1080 } : { w: 1920, h: 1080 })
      const { slots } = props
      expect(slots.rows).toHaveLength(SLIDE_TEMPLATE_ROWS)
      expect(slots.subtitle).toBeUndefined()
      expect(slots.credits).toBeUndefined()
      expect(slots.figure !== undefined).toBe(kind === 'table-image')
      // 子は slots のものだけで、すべて slide-layout の子
      const ids = [slots.title!, slots.panel!, ...(slots.figure ? [slots.figure] : []), ...slots.rows.flatMap((r) => (r.label ? [r.label, r.body] : [r.body]))]
      expect(new Set(editor.index.childrenOf(layout.id))).toEqual(new Set(ids))

      const boxes = canvasSlideLayout(kind, 3, ratio)
      expect(editor.getNode(slots.title!)!.type).toBe('text')
      near(boxOf(editor, slots.title!), boxes.title, false)
      near(boxOf(editor, slots.panel!), boxes.panel)
      if (kind === 'table-image') near(boxOf(editor, slots.figure!), boxes.figure!)
      slots.rows.forEach((row, i) => {
        expect(row.label !== undefined).toBe(kind !== 'bullets')
        if (row.label) near(boxOf(editor, row.label), boxes.rows[i].label!)
        near(boxOf(editor, row.body), boxes.rows[i].body)
      })
    }
  })

  it('lays out table-images with one row of a full-width table and two figure frames below it', () => {
    for (const ratio of ['16:9', '4:3'] as const) {
      const { editor, slide } = setup(ratio)
      expect(editor.applySlideTemplate(slide.id, 'table-images')).toBe(true)
      const { layout, props } = layoutOf(editor, slide.id)
      const { slots } = props
      expect(props.layout).toBe('table-images')
      expect(slots.rows).toHaveLength(slideTemplateRowCount('table-images'))
      expect(slots.rows).toHaveLength(1)
      const ids = [slots.title!, slots.panel!, slots.figure!, slots.figure2!, slots.rows[0].label!, slots.rows[0].body]
      expect(new Set(editor.index.childrenOf(layout.id))).toEqual(new Set(ids))
      const boxes = canvasSlideLayout('table-images', 1, ratio)
      near(boxOf(editor, slots.panel!), boxes.panel)
      near(boxOf(editor, slots.figure!), boxes.figure!)
      near(boxOf(editor, slots.figure2!), boxes.figure2!)
      near(boxOf(editor, slots.rows[0].label!), boxes.rows[0].label!)
      near(boxOf(editor, slots.rows[0].body), boxes.rows[0].body)
      // 行を足すと表が伸び、図の枠が低くなる
      editor.setSelection([slide.id])
      expect(editor.addSlideLayoutRow()).toBe(true)
      near(boxOf(editor, slots.figure2!), canvasSlideLayout('table-images', 2, ratio).figure2!)
    }
  })

  it('styles the cells from the theme (fills by row, the label/body padding and the figure frame)', () => {
    const { editor, slide } = setup()
    editor.applySlideTemplate(slide.id, 'table-image')
    const { slots } = layoutOf(editor, slide.id).props
    const geo = (id: string) => editor.getNode(id)!.props as GeoProps
    expect(geo(slots.panel!).fill).toMatchObject({ type: 'solid', color: CANVAS_SLIDE_PANEL_STYLE.fill })
    expect(geo(slots.panel!).stroke).toBeNull()
    expect(geo(slots.figure!)).toMatchObject({
      fill: { color: CANVAS_SLIDE_FIGURE_STYLE.fill },
      stroke: { color: CANVAS_SLIDE_FIGURE_STYLE.stroke },
      strokeWidth: CANVAS_SLIDE_FIGURE_STYLE.strokeWidth,
      strokeAlign: 'inside',
      cornerRadius: CANVAS_SLIDE_FIGURE_STYLE.cornerRadius,
      label: '画像',
    })
    slots.rows.forEach((row, i) => {
      const label = geo(row.label!)
      expect(label).toMatchObject({ label: '見出し', labelFontSize: CANVAS_SLIDE_LABEL_STYLE.fontSize, labelFontWeight: 700, labelAlign: 'center' })
      // v1 のセルの余白（見出し 8/18、本文 12/38）
      expect(geoLabelBox(label)).toMatchObject({ x: 18, y: 8 })
      const body = geo(row.body)
      expect(body).toMatchObject({ label: '本文', labelAlign: 'left', fill: { color: canvasSlideBodyFill(i) } })
      expect(geoLabelBox(body)).toMatchObject({ x: 38, y: 12, w: body.w - 76, h: body.h - 24 })
    })
    // 1・2 行目と 3 行目で地の色が違う
    expect(geo(slots.rows[0].body).fill).toEqual(geo(slots.rows[1].body).fill)
    expect(geo(slots.rows[2].body).fill).not.toEqual(geo(slots.rows[0].body).fill)
    const title = editor.getNode(slots.title!)!.props as TextProps
    expect(title).toMatchObject({ fontSize: CANVAS_SLIDE_TITLE_STYLE.fontSize, fontWeight: 700, autoWidth: false, lineHeight: { unit: 'multiplier', value: CANVAS_SLIDE_TITLE_STYLE.lineHeight } })
    expect(plainTextOf(paragraphsOf(title))).toBe('タイトル')
  })

  it('lays out the cover with the title, the subtitle and the credits band', () => {
    for (const ratio of ['16:9', '4:3'] as const) {
      const { editor, slide } = setup(ratio)
      expect(editor.applySlideTemplate(slide.id, 'title')).toBe(true)
      const { layout, props } = layoutOf(editor, slide.id)
      const { slots } = props
      expect(props.layout).toBe('title')
      expect(slots.rows).toEqual([])
      expect(editor.index.childrenOf(layout.id)).toHaveLength(3)
      const cover = canvasCoverLayout(true, ratio)
      const credits = editor.getNode(slots.credits!)!
      near(boxOf(editor, credits.id), cover.credits!)
      expect(credits.props).toMatchObject({ label: '発表者・所属・日付', fill: { color: CANVAS_COVER_CREDITS_STYLE.fill } })
      // credits の左右の余白は 70
      expect(geoLabelBox(credits.props as GeoProps)).toMatchObject({ x: 70, y: 0 })
      // タイトルと副題は見出しの領域の幅で、まとめて上下中央に置く
      const title = editor.index.get(slots.title!)!
      const subtitle = editor.index.get(slots.subtitle!)!
      expect(title.node.x).toBeCloseTo(cover.headingArea.x)
      expect((title.node.props as TextProps).w).toBeCloseTo(cover.headingArea.w)
      expect(subtitle.node.y).toBeCloseTo(title.node.y + title.worldBounds.h + cover.subtitleGap)
      const center = (title.node.y + subtitle.node.y + subtitle.worldBounds.h) / 2
      expect(center).toBeCloseTo(cover.headingCenterY)
    }
  })

  it('does nothing on a slide that already has children, or on a non-slide', () => {
    const { editor, slide } = setup()
    const rect = editor.makeNode('geo', { x: 10, y: 10, parentId: slide.id })
    editor.createNodes([rect])
    expect(editor.applySlideTemplate(slide.id, 'table')).toBe(false)
    expect(editor.index.childrenOf(slide.id)).toEqual([rect.id])
    expect(editor.applySlideTemplate(rect.id, 'table')).toBe(false)
    expect(editor.applySlideTemplate('node:missing', 'table')).toBe(false)
    // 1 度置いたスライドにも、もう置かない
    const other = setup()
    expect(other.editor.applySlideTemplate(other.slide.id, 'bullets')).toBe(true)
    expect(other.editor.applySlideTemplate(other.slide.id, 'table')).toBe(false)
  })

  it('is undone in one step', () => {
    const { editor, slide } = setup()
    const before = editor.store.size
    editor.applySlideTemplate(slide.id, 'table')
    expect(editor.store.size).toBe(before + 1 + 1 + 1 + 6)
    editor.undo()
    expect(editor.store.size).toBe(before)
    expect(editor.index.childrenOf(slide.id)).toEqual([])
    editor.redo()
    const { slots } = layoutOf(editor, slide.id).props
    near(boxOf(editor, slots.panel!), canvasSlideLayout('table', 3).panel)
  })

  it('lists the children back to front: the panel and the figure behind the cells', () => {
    const roles = (kind: SlideLayoutKind) => slideTemplateChildren(kind).map((c) => c.role)
    expect(roles('title')).toEqual(['title', 'subtitle', 'credits'])
    expect(roles('bullets')).toEqual(['panel', 'title', 'body', 'body', 'body'])
    expect(roles('table')).toEqual(['panel', 'title', 'label', 'body', 'label', 'body', 'label', 'body'])
    expect(roles('table-image')).toEqual(['panel', 'figure', 'title', 'label', 'body', 'label', 'body', 'label', 'body'])
    expect(roles('table-images')).toEqual(['panel', 'figure', 'figure2', 'title', 'label', 'body'])
    // 本文のセルは上下中央（geo の文字はいつも上下中央）で、テーマも middle
    expect(canvasSlideBodyStyle(0).verticalAlign).toBe('middle')
    expect(slideCellProps(canvasSlideBodyStyle(0), 'x').labelPadding).toEqual({ top: 12, right: 38, bottom: 12, left: 38 })
  })
})
