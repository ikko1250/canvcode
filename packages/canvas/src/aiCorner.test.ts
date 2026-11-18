import { describe, expect, it } from 'vitest'
import { applyMat, type NodeRecord } from '@canvcode/core'
import { richTextFromPlain } from '@canvcode/nodes'
import {
  AI_CORNER_HOVER_SCALE,
  AI_CORNER_MIN_ALPHA,
  AI_CORNER_SIZE,
  aiCornerAlpha,
  aiCornerHitSize,
  aiCornerSize,
  drawAiCorners,
  hasAiCorner,
  hitAiCorner,
} from './aiCorner.ts'
import { Editor } from './editor.ts'
import { SelectTool, type ToolContext, type ToolPointer } from './tools.ts'

// 付箋の角の三角（答えを見るボタン）

const answer = { body: '答え', related: [], model: 'claude-opus-5-5', question: 'Q', answeredAt: 1 }

// 大きさを決めた付箋（answered なら答えを持つ）
function note(editor: Editor, at: { x: number; y: number }, options: { w?: number; h?: number; answered?: boolean; rotation?: number } = {}): NodeRecord {
  const node = editor.makeNode('note', {
    ...at,
    ...(options.rotation ? { rotation: options.rotation } : {}),
    props: { paragraphs: richTextFromPlain('Q'), w: options.w ?? 200, h: options.h ?? 200, sizing: 'fixed' },
  })
  return options.answered === false ? node : { ...node, meta: { ...node.meta, ai: { contexts: [], answer } } }
}

function setZoom(editor: Editor, zoom: number): void {
  editor.session.set({ camera: { x: 0, y: 0, zoom } })
}

describe('which notes have the corner', () => {
  it('a note with an answer, or a note being answered; not a plain note or another node', () => {
    const editor = new Editor()
    const answered = note(editor, { x: 0, y: 0 })
    const plain = note(editor, { x: 0, y: 0 }, { answered: false })
    const geo = editor.makeNode('geo', { x: 0, y: 0 })
    expect(hasAiCorner(answered, new Set())).toBe(true)
    expect(hasAiCorner(plain, new Set())).toBe(false)
    expect(hasAiCorner(plain, new Set([plain.id]))).toBe(true)
    expect(hasAiCorner(geo, new Set([geo.id]))).toBe(false)
    expect(hasAiCorner(undefined, new Set())).toBe(false)
  })
})

describe('size and hit area', () => {
  it('draws the same size in the world at any zoom, and hits at least AI_CORNER_HIT_PX on the screen, up to half the note', () => {
    expect(aiCornerSize(200, 200)).toBe(AI_CORNER_SIZE)
    expect(aiCornerHitSize(200, 200, 1)).toBe(24)
    expect(aiCornerHitSize(200, 200, 4)).toBe(AI_CORNER_SIZE)
    expect(aiCornerHitSize(200, 200, 0.25)).toBe(96)
    expect(aiCornerHitSize(200, 60, 0.25)).toBe(30)
  })

  it('shrinks on a small note', () => {
    expect(aiCornerSize(30, 30)).toBe(10)
    expect(aiCornerHitSize(30, 30, 1)).toBe(15)
  })

  it('blinks between AI_CORNER_MIN_ALPHA and 1', () => {
    expect(aiCornerAlpha(0)).toBe(1)
    expect(aiCornerAlpha(600)).toBeCloseTo(AI_CORNER_MIN_ALPHA)
    expect(aiCornerAlpha(1200)).toBe(1)
  })
})

describe('hitAiCorner', () => {
  it('hits the top right corner of a note with the corner, not the rest of the note', () => {
    const editor = new Editor()
    const answered = note(editor, { x: 100, y: 100 })
    editor.createNodes([answered])
    setZoom(editor, 1)
    expect(hitAiCorner(editor, { x: 298, y: 102 })).toBe(answered.id)
    expect(hitAiCorner(editor, { x: 278, y: 122 })).toBe(answered.id)
    expect(hitAiCorner(editor, { x: 270, y: 102 })).toBeNull()
    expect(hitAiCorner(editor, { x: 150, y: 150 })).toBeNull()
  })

  it('grows the hit area when zoomed out, but not past half the note', () => {
    const editor = new Editor()
    const answered = note(editor, { x: 0, y: 0 })
    editor.createNodes([answered])
    setZoom(editor, 0.25)
    expect(hitAiCorner(editor, { x: 110, y: 90 })).toBe(answered.id)
    expect(hitAiCorner(editor, { x: 90, y: 90 })).toBeNull()
  })

  it('has no corner on a note too small on the screen', () => {
    const editor = new Editor()
    const answered = note(editor, { x: 0, y: 0 })
    editor.createNodes([answered])
    setZoom(editor, 0.05)
    expect(hitAiCorner(editor, { x: 199, y: 1 })).toBeNull()
  })

  it('needs an answer or the answering mark, and takes the frontmost note', () => {
    const editor = new Editor()
    // 1 つずつ置く（あとから置いた方が手前）
    const back = note(editor, { x: 0, y: 0 })
    editor.createNodes([back])
    const front = note(editor, { x: 0, y: 0 }, { answered: false })
    editor.createNodes([front])
    setZoom(editor, 1)
    expect(hitAiCorner(editor, { x: 195, y: 5 })).toBe(back.id)
    expect(hitAiCorner(editor, { x: 195, y: 5 }, new Set([front.id]))).toBe(front.id)
  })

  it('follows the turn of a rotated note', () => {
    const editor = new Editor()
    const turned = note(editor, { x: 0, y: 0 }, { rotation: Math.PI / 2 })
    editor.createNodes([turned])
    setZoom(editor, 1)
    // 付箋のローカルの (195, 5)（右上の角）を、回した先のワールドの点にして押す
    const matrix = editor.index.get(turned.id)!.worldMatrix
    const corner = applyMat(matrix, { x: 195, y: 5 })
    expect(hitAiCorner(editor, corner)).toBe(turned.id)
    // 付箋のほかの角は当たらない
    expect(hitAiCorner(editor, applyMat(matrix, { x: 5, y: 195 }))).toBeNull()
    expect(hitAiCorner(editor, applyMat(matrix, { x: 5, y: 5 }))).toBeNull()
  })
})

describe('drawAiCorners', () => {
  // 描いた三角（デバイスのピクセル）と、そのときの不透明度
  function recorder() {
    const shapes: { points: { x: number; y: number }[]; alpha: number }[] = []
    let points: { x: number; y: number }[] = []
    const ctx = {
      globalAlpha: 1,
      fillStyle: '',
      save() {},
      restore() {},
      setTransform() {},
      beginPath: () => (points = []),
      moveTo: (x: number, y: number) => points.push({ x, y }),
      lineTo: (x: number, y: number) => points.push({ x, y }),
      closePath() {},
      fill() {
        shapes.push({ points, alpha: ctx.globalAlpha })
      },
    }
    return { ctx: ctx as unknown as CanvasRenderingContext2D, shapes }
  }

  it('draws a right triangle at the top right of each visible note with the corner, bigger when hovered, fading while answered', () => {
    const editor = new Editor()
    const answered = note(editor, { x: 0, y: 0 })
    const answering = note(editor, { x: 300, y: 0 }, { answered: false })
    const plain = note(editor, { x: 600, y: 0 }, { answered: false })
    const far = note(editor, { x: 5000, y: 0 })
    editor.createNodes([answered, answering, plain, far])
    const { ctx, shapes } = recorder()
    const view = { camera: { x: 0, y: 0, zoom: 1 }, width: 1000, height: 800, dpr: 2 }
    const drawn = drawAiCorners(ctx, editor, view, { answeringIds: new Set([answering.id]), hoveredId: answered.id, now: 600 })
    expect(drawn).toBe(2)
    const at = (right: number) => shapes.find((shape) => shape.points[1]!.x === right)!
    const size = AI_CORNER_SIZE * AI_CORNER_HOVER_SCALE * 2
    expect(at(400).points).toEqual([
      { x: 400 - size, y: 0 },
      { x: 400, y: 0 },
      { x: 400, y: size },
    ])
    expect(at(400).alpha).toBe(1)
    expect(at(1000).points[0]).toEqual({ x: 1000 - AI_CORNER_SIZE * 2, y: 0 })
    expect(at(1000).alpha).toBeCloseTo(AI_CORNER_MIN_ALPHA)
  })
})

describe('pressing the corner with the select tool', () => {
  function setup() {
    const editor = new Editor({ canvasId: 'canvas:1' })
    const opened: string[] = []
    const edited: string[] = []
    const cursors: (string | null)[] = []
    const ctx: ToolContext = {
      editor,
      setTool: (id) => editor.session.set({ toolId: id }),
      lift: () => {},
      drop: () => {},
      setCursor: (cursor) => void cursors.push(cursor),
      startEditing: (id) => {
        edited.push(id)
        return true
      },
      openPortal: () => {},
      editDocument: () => false,
      createDocumentAt: () => {},
      quoteRegion: () => {},
      openCitations: () => {},
      moveToCanvas: () => {},
      openAnswer: (id) => void opened.push(id),
    }
    const pointer = (x: number, y: number): ToolPointer => ({ screen: { x, y }, world: { x, y }, button: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false })
    const answered = note(editor, { x: 100, y: 100 })
    editor.createNodes([answered])
    return { editor, ctx, pointer, opened, edited, cursors, answered, tool: new SelectTool(ctx) }
  }

  it('a click opens the answer without selecting the note; the rest of the note selects it as usual', () => {
    const { editor, tool, pointer, opened, answered } = setup()
    tool.onPointerDown(pointer(295, 105))
    tool.onPointerUp(pointer(295, 105))
    expect(opened).toEqual([answered.id])
    expect(editor.session.get().selectedIds.size).toBe(0)
    tool.onPointerDown(pointer(150, 200))
    tool.onPointerUp(pointer(150, 200))
    expect(opened).toEqual([answered.id])
    expect([...editor.session.get().selectedIds]).toEqual([answered.id])
  })

  it('dragging from the corner does nothing: no answer, no move', () => {
    const { editor, tool, pointer, opened, answered } = setup()
    tool.onPointerDown(pointer(295, 105))
    tool.onPointerMove(pointer(400, 300))
    tool.onPointerUp(pointer(400, 300))
    expect(opened).toEqual([])
    expect(editor.getNode(answered.id)).toMatchObject({ x: 100, y: 100 })
  })

  it('a double click opens it once and does not start editing the text', () => {
    const { tool, pointer, opened, edited, answered } = setup()
    tool.onPointerDown(pointer(295, 105))
    tool.onPointerUp(pointer(295, 105))
    tool.onPointerDown(pointer(295, 105))
    tool.onPointerUp(pointer(295, 105))
    tool.onDoubleClick(pointer(295, 105))
    expect(opened).toEqual([answered.id])
    expect(edited).toEqual([])
  })

  it('hovering marks the corner and shows the pointer; leaving clears it', () => {
    const { editor, tool, pointer, cursors, answered } = setup()
    tool.onPointerMove(pointer(295, 105))
    expect(editor.session.get().hoveredAiCorner).toBe(answered.id)
    expect(cursors.at(-1)).toBe('pointer')
    tool.onPointerMove(pointer(150, 200))
    expect(editor.session.get().hoveredAiCorner).toBeNull()
  })
})
