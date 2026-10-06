import { describe, expect, it } from 'vitest'
import {
  CANVAS_COVER_CREDITS_STYLE,
  CANVAS_COVER_SUBTITLE_STYLE,
  CANVAS_COVER_TITLE_STYLE,
  CANVAS_SLIDE_FIGURE_STYLE,
  CANVAS_SLIDE_FONT_FAMILY,
  CANVAS_SLIDE_LABEL_STYLE,
  CANVAS_SLIDE_PANEL_STYLE,
  CANVAS_SLIDE_TITLE_STYLE,
  canvasSlideBodyFill,
  canvasSlideBodyStyle,
  canvasSlideBulletLevelStyle,
} from './canvas-slide-theme.ts'

// スライド v2 のテーマ：v1 の色・タイポグラフィ・slide.css のセルの地と余白と同じ値になること

describe('canvas slide theme', () => {
  it('uses the bundled M PLUS 1p font', () => {
    expect(CANVAS_SLIDE_FONT_FAMILY).toBe('M PLUS 1p')
    expect(CANVAS_SLIDE_TITLE_STYLE.fontFamily).toBe('M PLUS 1p')
  })

  it('matches the v1 title, label and body typography', () => {
    expect(CANVAS_SLIDE_TITLE_STYLE).toMatchObject({
      fontSize: 46,
      lineHeight: 1.18,
      letterSpacingEm: -0.02,
      fontWeight: 700,
      fill: null,
    })
    expect(CANVAS_SLIDE_LABEL_STYLE).toMatchObject({
      fontSize: 37,
      lineHeight: 1.38,
      letterSpacingEm: -0.015,
      fontWeight: 700,
      fill: '#ffffff',
      padding: { top: 8, right: 18, bottom: 8, left: 18 },
      align: 'center',
      verticalAlign: 'middle',
    })
    expect(canvasSlideBodyStyle(0)).toMatchObject({
      fontSize: 31,
      lineHeight: 1.38,
      letterSpacingEm: -0.025,
      fontWeight: 400,
      fill: '#fff7e2',
      padding: { top: 12, right: 38, bottom: 12, left: 38 },
      align: 'left',
      verticalAlign: 'middle',
    })
  })

  it('fills body cells cream A for rows 1-2 and cream B from row 3', () => {
    expect([0, 1, 2, 3, 5].map(canvasSlideBodyFill)).toEqual([
      '#fff7e2',
      '#fff7e2',
      '#fff5dc',
      '#fff5dc',
      '#fff5dc',
    ])
  })

  it('returns the bullet levels with the marker at the parent indent', () => {
    expect(canvasSlideBulletLevelStyle(0)).toEqual({
      fontSize: 31,
      lineHeight: 1.38,
      indentPx: 0,
      marker: '',
      markerIndentPx: 0,
    })
    expect(canvasSlideBulletLevelStyle(1)).toMatchObject({ fontSize: 28, indentPx: 48, marker: '・', markerIndentPx: 0 })
    expect(canvasSlideBulletLevelStyle(2)).toMatchObject({ fontSize: 25, indentPx: 96, marker: '－', markerIndentPx: 48 })
    expect(canvasSlideBulletLevelStyle(5)).toEqual(canvasSlideBulletLevelStyle(2))
  })

  it('matches the v1 panel, figure and cover styles', () => {
    expect(CANVAS_SLIDE_PANEL_STYLE.fill).toBe('#d9d9d9')
    expect(CANVAS_SLIDE_FIGURE_STYLE).toEqual({
      fill: '#ffffff',
      stroke: '#cfcfcf',
      strokeWidth: 1,
      cornerRadius: 16,
      padding: 20,
    })
    expect(CANVAS_COVER_TITLE_STYLE).toMatchObject({
      fontSize: 64,
      lineHeight: 1.25,
      fontWeight: 700,
      align: 'center',
      padding: { top: 0, right: 40, bottom: 0, left: 40 },
    })
    expect(CANVAS_COVER_SUBTITLE_STYLE).toMatchObject({ fontSize: 40, lineHeight: 1.4, letterSpacingEm: -0.025 })
    expect(CANVAS_COVER_CREDITS_STYLE).toMatchObject({
      fontSize: 31,
      lineHeight: 1.6,
      fill: '#d9d9d9',
      padding: { top: 0, right: 70, bottom: 0, left: 70 },
      verticalAlign: 'middle',
    })
  })
})
