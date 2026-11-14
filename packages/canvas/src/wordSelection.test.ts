import { describe, expect, it, vi } from 'vitest'
import { Editor } from './editor.ts'
import { CanvasView } from './view.ts'
import type { PdfTextItem } from './quotes.ts'
import { SelectTool, type ToolContext, type ToolPointer, type WordSelectionEvent } from './tools.ts'
import { Workspace } from './workspace.ts'
import { pdfPageText, selectWords, sentencesAround, startColumnBoxes, wordIndexAt } from './wordSelection.ts'

// PDF のページの上で、なぞった語を選ぶ（MAI-99）

// 1 行の断片。文字の幅は 6 ポイント、高さは 10 ポイント
function line(text: string, x: number, y: number, eol = true): PdfTextItem {
  return { text, x, y, w: [...text].length * 6, h: 10, ...(eol ? { eol: true } : {}) }
}

// 語の番号を、語の文字で探す
function indexOf(page: ReturnType<typeof pdfPageText>, word: string, nth = 0): number {
  const found = page.words.flatMap((w, i) => (page.text.slice(w.start, w.end) === word ? [i] : []))
  return found[nth] ?? -1
}

describe('pdfPageText', () => {
  it('行の間は、英語なら空白、日本語なら何も入れずにつなぎ、行末の「-」で切れた英単語はつなぐ', () => {
    const page = pdfPageText([line('The model was trained on a large cor-', 0, 0), line('pus of text. 日本語の', 0, 12), line('文章です。', 0, 24)])
    expect(page.text).toBe('The model was trained on a large corpus of text. 日本語の文章です。')
    // 切れた語も 1 つの語になり、2 行に箱がある
    expect(indexOf(page, 'corpus')).toBeGreaterThanOrEqual(0)
    const corpus = page.words[indexOf(page, 'corpus')]!
    expect(new Set(page.lines.slice(corpus.start, corpus.end)).size).toBe(2)
  })

  it('大文字で始まる行の前の「-」は落とさない。行の間が大きく空いていれば改行にする', () => {
    const page = pdfPageText([line('state-', 0, 0), line('Of the art.', 0, 12), line('Next paragraph.', 0, 60)])
    expect(page.text).toBe('state- Of the art.\nNext paragraph.')
  })

  it('同じ行の、間の空いた断片は空白を挟んでつなぎ、文字のない断片の行の終わりも読む', () => {
    const page = pdfPageText([
      { text: 'deep', x: 0, y: 0, w: 24, h: 10 },
      { text: 'learning', x: 30, y: 0, w: 48, h: 10 },
      { text: '', x: 78, y: 0, w: 0, h: 10, eol: true },
      { text: 'works', x: 0, y: 12, w: 30, h: 10 },
    ])
    expect(page.text).toBe('deep learning works')
  })

  it('文字の幅の比を渡せば、断片の幅をその比で分ける', () => {
    // 「i」は「W」の 4 分の 1 の幅
    const page = pdfPageText([{ text: 'Wi Wi', x: 0, y: 0, w: 100, h: 10 }], (chars) => chars.map((ch) => (ch === 'W' ? 4 : ch === ' ' ? 2 : 1)))
    const expected = [
      [0, 4],
      [4, 1],
      [5, 2],
      [7, 4],
      [11, 1],
    ]
    page.boxes.forEach((box, i) => {
      expect(box!.x).toBeCloseTo((100 * expected[i]![0]!) / 12)
      expect(box!.w).toBeCloseTo((100 * expected[i]![1]!) / 12)
    })
  })

  it('PDF に書かれた順につなぐ（2 段組で、左の段の終わりから右の段の始めへ続く）', () => {
    const page = pdfPageText([line('left column ends', 0, 100), line('right column starts', 300, 0)])
    expect(page.text).toBe('left column ends right column starts')
  })
})

describe('wordIndexAt と selectWords', () => {
  const items = [line('Large language models are trained', 0, 0), line('on a corpus of text.', 0, 12)]
  const page = pdfPageText(items)

  it('点の下の語を返し、行の右の空いた所では、その行の最後の語にする', () => {
    expect(page.text.slice(page.words[wordIndexAt(page, { x: 3, y: 5 })]!.start, page.words[wordIndexAt(page, { x: 3, y: 5 })]!.end)).toBe('Large')
    expect(wordIndexAt(page, { x: 500, y: 5 })).toBe(indexOf(page, 'trained'))
    expect(wordIndexAt(page, { x: 500, y: 17 })).toBe(indexOf(page, 'text'))
  })

  it('押した語から今の語までを、読む順に選ぶ（逆向きでも、行をまたいでも）', () => {
    const a = indexOf(page, 'models')
    const b = indexOf(page, 'corpus')
    const selected = selectWords(page, b, a)!
    expect(selected.text).toBe('models are trained on a corpus')
    // 箱は行ごとに 1 つ。1 行目は models から行の終わりまで、2 行目は行の頭から corpus まで
    expect(selected.boxes).toHaveLength(2)
    expect(selected.boxes[0]).toMatchObject({ x: 'Large language '.length * 6, y: 0, h: 10 })
    expect(selected.boxes[0]!.x + selected.boxes[0]!.w).toBeCloseTo('Large language models are trained'.length * 6)
    expect(selected.boxes[1]).toMatchObject({ x: 0, y: 12, w: 'on a corpus'.length * 6 })
  })

  it('段落をまたいで選んでも改行を入れない（英語は空白、日本語は何も入れずにつなぐ。MAI-103）', () => {
    const page = pdfPageText([line('End of one.', 0, 0), line('Start of two', 0, 60), line('日本語の段落', 0, 120), line('次の段落', 0, 180)])
    expect(page.text).toBe('End of one.\nStart of two\n日本語の段落\n次の段落')
    expect(selectWords(page, indexOf(page, 'one'), indexOf(page, 'Start'))?.text).toBe('one. Start')
    expect(selectWords(page, indexOf(page, '段落'), indexOf(page, '次'))?.text).toBe('段落次')
  })

  it('出典の範囲は、選び始めた段の部分だけを囲む（2 段組をまたいだとき。MAI-103）', () => {
    const left = [{ x: 50, y: 600, w: 200, h: 10 }, { x: 40, y: 612, w: 210, h: 10 }]
    const right = [{ x: 320, y: 100, w: 220, h: 10 }, { x: 320, y: 112, w: 100, h: 10 }]
    expect(startColumnBoxes([...left, ...right])).toEqual(left)
    // 同じ段なら全部（行の途中から始まっていても）
    expect(startColumnBoxes([{ x: 150, y: 0, w: 100, h: 10 }, { x: 40, y: 12, w: 210, h: 10 }, { x: 40, y: 24, w: 60, h: 10 }])).toHaveLength(3)
    expect(startColumnBoxes([])).toEqual([])
  })

  it('1 つの語だけも選べる', () => {
    const i = indexOf(page, 'corpus')
    expect(selectWords(page, i, i)).toMatchObject({ text: 'corpus', context: 'Large language models are trained on a corpus of text.' })
  })

  it('日本語の文も語に分け、熟語をなぞって選べる', () => {
    const ja = pdfPageText([line('本研究では機械学習を用いて', 0, 0), line('画像を分類した。', 0, 12)])
    expect(ja.text).toBe('本研究では機械学習を用いて画像を分類した。')
    const from = wordIndexAt(ja, { x: 5 * 6 + 1, y: 5 })
    const to = wordIndexAt(ja, { x: 8 * 6 + 1, y: 5 })
    expect(selectWords(ja, from, to)?.text).toBe('機械学習')
  })

  it('語がなければ -1・null', () => {
    const empty = pdfPageText([])
    expect(wordIndexAt(empty, { x: 0, y: 0 })).toBe(-1)
    expect(selectWords(empty, 0, 0)).toBeNull()
  })
})

describe('sentencesAround', () => {
  const text = 'First sentence. Second has the word. Third one. Fourth one.'

  it('選んだ所を含む文と、その前後の文を返す', () => {
    const start = text.indexOf('word')
    expect(sentencesAround(text, start, start + 4)).toBe('First sentence. Second has the word. Third one.')
  })

  it('長ければ、選んだ所のまわりだけにする', () => {
    const long = `${'a '.repeat(2000)}target ${'b '.repeat(2000)}`
    const start = long.indexOf('target')
    const context = sentencesAround(long, start, start + 6, 100)
    expect(context).toContain('target')
    expect(context.length).toBeLessThanOrEqual(100)
  })
})

describe('SelectTool: 単語を調べる（なぞって選ぶ）', () => {
  function setup() {
    const workspace = new Workspace({ rootCanvasId: 'canvas:root' })
    const root = new Editor({ workspace })
    const pdf = root.importPdf({ title: '論文', asset: { id: 'asset:abc', hash: 'abc', size: 1 }, pageSizes: [{ width: 600, height: 800 }], center: { x: 0, y: 0 } })
    const editor = new Editor({ workspace, canvasId: pdf.canvasId })
    const pageId = editor.index.allIds()[0]!
    const page = editor.index.get(pageId)!.worldBounds
    const events: WordSelectionEvent[] = []
    const cursors: (string | null)[] = []
    const ctx: ToolContext = {
      editor,
      setTool: (id) => editor.session.set({ toolId: id }),
      lift: () => {},
      drop: () => {},
      setCursor: (cursor) => cursors.push(cursor),
      startEditing: () => false,
      openPortal: () => {},
      editDocument: () => false,
      createDocumentAt: () => {},
      quoteRegion: () => {},
      wordSelection: (event) => events.push(event),
      openCitations: () => {},
      moveToCanvas: () => {},
    }
    const pointer = (u: number, v: number): ToolPointer => {
      const world = { x: page.x + page.w * u, y: page.y + page.h * v }
      return { screen: world, world, button: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }
    }
    return { editor, pageId, events, cursors, ctx, tool: new SelectTool(ctx), pointer }
  }

  it('押した所から離した所までを、ページの中の割合で知らせ、一度だけで終わる（ノードは動かさない）', () => {
    const { editor, pageId, events, tool, pointer } = setup()
    editor.session.set({ wordLookupArmed: true })
    const before = editor.getNode(pageId)
    tool.onPointerDown(pointer(0.1, 0.2))
    expect(editor.session.get().wordLookupArmed).toBe(false)
    tool.onPointerMove(pointer(0.3, 0.25))
    tool.onPointerUp(pointer(0.5, 0.3))
    expect(events.map((e) => e.phase)).toEqual(['move', 'move', 'end'])
    const end = events.at(-1)!
    expect(end).toMatchObject({ phase: 'end', pageId })
    if (end.phase !== 'end') throw new Error('unreachable')
    expect(end.from.x).toBeCloseTo(0.1)
    expect(end.from.y).toBeCloseTo(0.2)
    expect(end.to.x).toBeCloseTo(0.5)
    expect(end.to.y).toBeCloseTo(0.3)
    expect(editor.getNode(pageId)).toBe(before)
    expect(editor.session.get().selectedIds.size).toBe(0)
    // 次のドラッグは、いつもの選択
    events.length = 0
    tool.onPointerDown(pointer(0.1, 0.2))
    tool.onPointerUp(pointer(0.1, 0.2))
    expect(events).toEqual([{ phase: 'cancel' }])
  })

  it('Esc（cancel）でやめる。なぞる前でも、なぞっている途中でも', () => {
    const { editor, events, tool, pointer } = setup()
    editor.session.set({ wordLookupArmed: true })
    expect(tool.cancel()).toBe(true)
    expect(editor.session.get().wordLookupArmed).toBe(false)
    expect(events.map((e) => e.phase)).toEqual(['cancel'])
    editor.session.set({ wordLookupArmed: true })
    tool.onPointerDown(pointer(0.1, 0.2))
    expect(tool.cancel()).toBe(true)
    tool.onPointerUp(pointer(0.5, 0.3))
    expect(events.map((e) => e.phase)).toEqual(['cancel', 'move', 'cancel'])
  })

  it.each(['escape', 'click', 'quote', 'none'] as const)('文字の読込待ちを離したあとも中止できる（%s）', async (action) => {
    const { editor, ctx, tool, pointer } = setup()
    let finish!: () => void
    const loaded = new Promise<void>((resolve) => { finish = resolve })
    const lookup = vi.fn()
    const view = Object.create(CanvasView.prototype) as CanvasView
    Object.assign(view, {
      editorRef: editor,
      tool,
      root: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
      options: { onWordLookup: lookup, notify: vi.fn() },
      updateCursor: vi.fn(),
      selectedWords: async () => {
        await loaded
        return { words: { text: 'model', context: 'The model' }, world: [{ x: 100, y: 100, w: 20, h: 20 }], rect: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } }
      },
    })
    const handler = view as unknown as { onWordSelection(event: WordSelectionEvent): Promise<void> }
    const pending: Promise<void>[] = []
    ctx.wordSelection = (event) => { pending.push(handler.onWordSelection(event)) }
    editor.session.set({ wordLookupArmed: true })
    tool.onPointerDown(pointer(0.1, 0.2))
    tool.onPointerUp(pointer(0.5, 0.3))
    if (action === 'escape') tool.cancel()
    if (action === 'click') tool.onPointerDown(pointer(-1, -1))
    if (action === 'quote') view.armQuoteRegion()
    finish()
    await Promise.all(pending)
    expect(lookup).toHaveBeenCalledTimes(action === 'none' ? 1 : 0)
    if (action !== 'none') expect(editor.session.get().wordHighlight).toBeNull()
  })

  it('ページの外を押したら、やめて、いつもの操作に進む', () => {
    const { editor, events, tool, pointer } = setup()
    editor.session.set({ wordLookupArmed: true })
    tool.onPointerDown(pointer(-1, -1))
    tool.onPointerUp(pointer(-1, -1))
    expect(editor.session.get().wordLookupArmed).toBe(false)
    expect(events.map((e) => e.phase)).toEqual(['cancel'])
  })
})
