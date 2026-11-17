import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { plainTextOf, richTextFromPlain, type ArrowProps, type ButtonProps, type FrameProps, type NoteProps } from '@canvcode/nodes'
import { makeBinding } from './bindings.ts'
import {
  ANSWER_COLUMN_WIDTH,
  ANSWER_GAP,
  ANSWER_PADDING,
  ASSUMPTION_COLOR,
  FOLLOW_UP_GAP,
  KEPT_VERSIONS,
  PLUS_COLOR,
  VERSION_BAR_CURRENT_COLOR,
  aiNoteMeta,
  answerContent,
  buttonTarget,
  placeAnswer,
  placeFollowUp,
  previousTurns,
  questionOf,
  questionText,
  replaceAnswer,
  restoreAnswerVersion,
  setAiNote,
  versionTooltip,
  waitUntilIdle,
  type CanvasAnswer,
} from './answers.ts'
import { Editor } from './editor.ts'

// キャンバスの AI：付箋で聞き、段落ごとの付箋とボタンをまとめたフレームで答える

const answer: CanvasAnswer = {
  title: 'Swift の開発環境',
  assumptions: ['iOS アプリを作る', 'Mac を使っている'],
  paragraphs: ['Xcode を入れれば、開発環境はほぼ整う。…', 'まず App Store から Xcode を入れる。…', '次に、シミュレータで動かす。…'],
  hints: [
    { label: 'Mac アプリ向けに', prompt: '対象を Mac のアプリにして書き直す' },
    { label: 'もっと簡単な言葉で', prompt: '初めての人にもわかる言葉で書き直す' },
  ],
}

function note(editor: Editor, text: string, at: { x: number; y: number }, parentId?: string): NodeRecord {
  return editor.makeNode('note', { ...at, ...(parentId ? { parentId } : {}), props: { paragraphs: richTextFromPlain(text) } })
}

function children(editor: Editor, frameId: string) {
  return editor.index.childrenOf(frameId).map((id) => editor.getNode(id)!)
}

function text(node: NodeRecord): string {
  return plainTextOf((node.props as NoteProps).paragraphs)
}

// AI が置いた、書き直すボタン（「＋」と版の帯を除く）
function hintButtons(editor: Editor, frameId: string) {
  return children(editor, frameId).filter((n) => n.type === 'button' && (n.props as ButtonProps).hint && !(n.props as ButtonProps).action)
}

function actionButtons(editor: Editor, frameId: string, action: ButtonProps['action']) {
  return children(editor, frameId).filter((n) => n.type === 'button' && (n.props as ButtonProps).action === action)
}

// Canvas 直下の矢印と、その端のつながり先
function arrows(editor: Editor) {
  return editor.index.childrenOf(editor.canvasId).flatMap((id) => {
    const node = editor.getNode(id)!
    if (node.type !== 'arrow') return []
    const ends = Object.fromEntries(editor.bindingsOfArrow(id).map((binding) => [binding.props.terminal, binding.toId]))
    return [{ id, start: ends.start, end: ends.end }]
  })
}

describe('questionOf', () => {
  it('joins the text of the chosen notes in reading order and skips empty notes and other nodes', () => {
    const editor = new Editor()
    const second = note(editor, '環境はどう整える？', { x: 0, y: 300 })
    const first = note(editor, 'Swift を始めたい', { x: 0, y: 0 })
    const empty = note(editor, '  ', { x: 0, y: 600 })
    const geo = editor.makeNode('geo', { x: 0, y: 900 })
    editor.createNodes([second, first, empty, geo])
    expect(questionOf(editor, [second.id, first.id, empty.id, geo.id])).toEqual({ question: 'Swift を始めたい\n\n環境はどう整える？', questionIds: [first.id, second.id] })
    expect(questionOf(editor, [empty.id, geo.id])).toBeNull()
    expect(questionText(editor, [first.id, 'node:gone'])).toBe('Swift を始めたい')
  })
})

describe('placeAnswer', () => {
  it('puts a frame below the question with an arrow from it: the assumptions, one note per paragraph, then the buttons between two ＋', () => {
    const editor = new Editor()
    const question = note(editor, 'Swift の開発環境ってどうやって整えたら良いの？', { x: 100, y: 50 })
    editor.createNodes([question])
    editor.setSelection([question.id])
    const frameId = placeAnswer(editor, [question.id], answer)!
    const frame = editor.getNode(frameId)!
    const source = editor.index.get(question.id)!.worldBounds
    expect(frame).toMatchObject({ type: 'frame', parentId: editor.canvasId, x: 100, y: source.y + source.h + ANSWER_GAP })
    expect((frame.props as FrameProps).name).toBe('Swift の開発環境')
    expect((frame.props as FrameProps).w).toBe(ANSWER_COLUMN_WIDTH + ANSWER_PADDING * 2)

    const inside = children(editor, frameId)
    expect(inside.map((n) => n.type)).toEqual(['note', 'note', 'note', 'note', 'button', 'button', 'button', 'button'])
    expect((inside[0].props as NoteProps).color).toBe(ASSUMPTION_COLOR)
    expect(text(inside[0])).toBe('この答えの前提\niOS アプリを作る\nMac を使っている')
    expect(inside.slice(1, 4).map(text)).toEqual(answer.paragraphs)
    const hints = hintButtons(editor, frameId)
    expect(hints.map((n) => (n.props as ButtonProps).label)).toEqual(['Mac アプリ向けに', 'もっと簡単な言葉で'])
    expect(hints[0]!.props as ButtonProps).toMatchObject({ prompt: '対象を Mac のアプリにして書き直す', hint: true, questionIds: [question.id] })
    // 版が 1 つなので、帯はない
    expect(actionButtons(editor, frameId, 'version')).toHaveLength(0)

    // 上から重ならずに並び、フレームの中に収まる。「＋」はボタンの並びの左右の端で、並びと同じ高さ
    const box = (n: NodeRecord) => editor.index.get(n.id)!.worldBounds
    const boxes = inside.slice(0, 4).map(box)
    for (let i = 1; i < 4; i++) expect(boxes[i].y).toBeGreaterThan(boxes[i - 1].y + boxes[i - 1].h)
    const [mac, simple] = hints.map(box)
    expect(mac!.y).toBeGreaterThan(boxes[3].y + boxes[3].h)
    expect(simple!.x).toBeGreaterThan(mac!.x + mac!.w)
    const [left] = actionButtons(editor, frameId, 'ask-left')
    const [right] = actionButtons(editor, frameId, 'ask-right')
    expect(left!.props as ButtonProps).toMatchObject({ label: '＋', color: PLUS_COLOR, tooltip: '左に続きの質問を置く', hint: true })
    const frameBox = editor.index.get(frameId)!.worldBounds
    expect(box(left!)).toMatchObject({ x: frameBox.x + ANSWER_PADDING, y: mac!.y, h: mac!.h })
    expect(box(left!).x + box(left!).w).toBeLessThan(mac!.x)
    expect(box(right!).x + box(right!).w).toBe(frameBox.x + frameBox.w - ANSWER_PADDING)
    for (const n of inside) expect(box(n).y + box(n).h).toBeLessThanOrEqual(frameBox.y + frameBox.h)

    // 質問の付箋の下の辺から、フレームの上の辺への矢印
    const [arrow] = arrows(editor)
    expect(arrow).toMatchObject({ start: question.id, end: frameId })

    // 選択は変えず、1 回の Undo で矢印ごと消える
    expect([...editor.session.get().selectedIds]).toEqual([question.id])
    editor.undo()
    expect(editor.getNode(frameId)).toBeUndefined()
    expect(editor.getNode(arrow!.id)).toBeUndefined()
    expect(inside.every((n) => editor.getNode(n.id) === undefined)).toBe(true)
  })

  it('moves further down past anything in the way, including a frame that holds the question (the answer goes on the canvas root)', () => {
    const editor = new Editor()
    const question = note(editor, 'Swift を始めたい', { x: 20, y: 20 })
    const wall = editor.makeNode('geo', { x: 0, y: 200, props: { w: 300, h: 600 } })
    editor.createNodes([question, wall])
    expect(editor.getNode(placeAnswer(editor, [question.id], answer)!)).toMatchObject({ x: 20, y: 800 + ANSWER_GAP / 2 })

    const nested = new Editor()
    const holder = nested.makeNode('frame', { x: 0, y: 0, props: { w: 2000, h: 1000 } })
    const inside = note(nested, 'Swift を始めたい', { x: 20, y: 20 }, holder.id)
    nested.createNodes([holder, inside])
    const frameId = placeAnswer(nested, [inside.id], answer)!
    expect(nested.getNode(frameId)).toMatchObject({ parentId: nested.canvasId, x: 20, y: 1000 + ANSWER_GAP / 2 })
  })

  it('leaves out the assumptions note when there are none, and still puts the ＋ on both sides', () => {
    const editor = new Editor()
    const question = note(editor, '1 + 1 は？', { x: 0, y: 0 })
    editor.createNodes([question])
    const frameId = placeAnswer(editor, [question.id], { title: '', assumptions: [], paragraphs: ['2 です。'], hints: [] })!
    expect(children(editor, frameId).filter((n) => n.type === 'note').map(text)).toEqual(['2 です。'])
    expect(children(editor, frameId).filter((n) => n.type === 'button').map((n) => (n.props as ButtonProps).action)).toEqual(['ask-left', 'ask-right'])
    expect((editor.getNode(frameId)!.props as FrameProps).name).toBe('答え')
  })

  it('draws the arrow from the lowest of several question notes, and ends the AI mode of the question notes', () => {
    const editor = new Editor()
    const upper = note(editor, 'Swift を始めたい', { x: 0, y: 0 })
    const lower = note(editor, '環境は？', { x: 300, y: 200 })
    editor.createNodes([upper, lower])
    setAiNote(editor, lower.id, { contexts: [] })
    expect(aiNoteMeta(editor.getNode(lower.id))).toEqual({ contexts: [] })
    const frameId = placeAnswer(editor, [upper.id, lower.id], answer)!
    expect(arrows(editor)).toEqual([expect.objectContaining({ start: lower.id, end: frameId })])
    expect(aiNoteMeta(editor.getNode(lower.id))).toBeNull()
    expect(editor.getNode(frameId)!.x).toBe(0)
  })
})

describe('buttonTarget and answerContent', () => {
  it('finds the frame around a button and reads its assumptions and notes in reading order', () => {
    const editor = new Editor()
    const question = note(editor, 'Swift を始めたい', { x: 0, y: 0 })
    editor.createNodes([question])
    const frameId = placeAnswer(editor, [question.id], answer)!
    const [mac] = children(editor, frameId).filter((n) => n.type === 'button')
    expect(buttonTarget(editor, mac.id)).toEqual({ frameId, instruction: '対象を Mac のアプリにして書き直す', questionIds: [question.id] })
    const content = answerContent(editor, frameId)!
    expect(content.title).toBe('Swift の開発環境')
    expect(content.assumptions).toEqual([
      { text: 'iOS アプリを作る', edited: false },
      { text: 'Mac を使っている', edited: false },
    ])
    expect(content.notes).toEqual(answer.paragraphs.map((text) => ({ text, edited: false })))
    expect(content).toMatchObject({ buttons: [], history: [] })

    // 人が付箋を書き換えると、edited の印が付き、待っている間の印も変わる
    const first = children(editor, frameId)[1]
    editor.transact('edit', (tx) => tx.put({ ...first, props: { ...(first.props as NoteProps), paragraphs: richTextFromPlain('書き換えた') } }))
    expect(answerContent(editor, frameId)!.notes[0]).toEqual({ text: '書き換えた', edited: true })
    expect(answerContent(editor, frameId)!.notes[1]!.edited).toBe(false)
    expect(answerContent(editor, frameId)!.signature).not.toBe(content.signature)

    // 人が足した付箋も edited
    const added = note(editor, '人が足した段落', { x: 24, y: 5000 }, frameId)
    editor.createNodes([added])
    expect(answerContent(editor, frameId)!.notes.at(-1)).toEqual({ text: '人が足した段落', edited: true })

    // 前提の付箋を書き換えると、書き換えた前提を読み、edited の印を付ける
    const premise = children(editor, frameId)[0]
    const lines = (premise.props as NoteProps).paragraphs
    editor.transact('edit', (tx) => tx.put({ ...premise, props: { ...(premise.props as NoteProps), paragraphs: [lines[0], { ...lines[1], runs: [{ text: 'Android アプリを作る' }] }, lines[2]] } }))
    expect(answerContent(editor, frameId)!.assumptions).toEqual([
      { text: 'Android アプリを作る', edited: true },
      { text: 'Mac を使っている', edited: false },
    ])

    // フレームの名前を変えても、印が変わる
    const before = answerContent(editor, frameId)!.signature
    const frame = editor.getNode(frameId)!
    editor.transact('rename', (tx) => tx.put({ ...frame, props: { ...(frame.props as FrameProps), name: '別の名前' } }))
    expect(answerContent(editor, frameId)!.signature).not.toBe(before)
  })

  it('reads a copied assumptions note without meta by its heading, also when the heading was edited', () => {
    const editor = new Editor()
    const frame = editor.makeNode('frame', { x: 0, y: 0, props: { w: 400, h: 400 } })
    const premise = editor.makeNode('note', { parentId: frame.id, x: 24, y: 24, props: { paragraphs: richTextFromPlain('この答えの前提：\niOS アプリを作る') } })
    const body = note(editor, '本文', { x: 24, y: 200 }, frame.id)
    editor.createNodes([frame, premise, body])
    expect(answerContent(editor, frame.id)).toMatchObject({ assumptions: [{ text: 'iOS アプリを作る', edited: true }], notes: [{ text: '本文', edited: true }] })
  })

  it('a button the user placed in the frame uses the question of the AI buttons, and is sent as a kept button', () => {
    const editor = new Editor()
    const question = note(editor, 'Swift を始めたい', { x: 0, y: 0 })
    editor.createNodes([question])
    const frameId = placeAnswer(editor, [question.id], answer)!
    const mine = editor.makeNode('button', { parentId: frameId, x: 24, y: 2000, props: { label: '表にして', prompt: '表の形で書き直す' } })
    editor.createNodes([mine])
    expect(buttonTarget(editor, mine.id)).toEqual({ frameId, instruction: '表の形で書き直す', questionIds: [question.id] })
    expect(answerContent(editor, frameId)!.buttons).toEqual(['表にして'])
  })

  it('a button outside any frame has no target', () => {
    const editor = new Editor()
    const button = editor.makeNode('button', { x: 0, y: 0 })
    editor.createNodes([button])
    expect(buttonTarget(editor, button.id)).toBeNull()
  })
})

describe('replaceAnswer', () => {
  it('replaces the notes and the AI buttons, keeps the rest below the new answer, fits the height and comes back with one undo', () => {
    const editor = new Editor()
    const question = note(editor, 'Swift を始めたい', { x: 0, y: 0 })
    editor.createNodes([question])
    const frameId = placeAnswer(editor, [question.id], answer)!
    // 人が置いた図形とボタン（図形の下にボタン。並びはそのまま、新しい答えの下へずらす）
    const image = editor.makeNode('geo', { parentId: frameId, x: 24, y: 100, props: { w: 100, h: 100 } })
    const mine = editor.makeNode('button', { parentId: frameId, x: 24, y: 220, props: { label: '表にして' } })
    editor.createNodes([image, mine])
    const before = children(editor, frameId).map((n) => n.id)
    const rewritten: CanvasAnswer = {
      title: 'Swift の開発環境（Mac）',
      assumptions: ['Mac アプリを作る'],
      paragraphs: ['Mac のアプリも Xcode で作る。…'],
      hints: [{ label: 'iOS アプリ向けに', prompt: '対象を iOS のアプリに戻して書き直す' }],
    }
    expect(replaceAnswer(editor, frameId, rewritten, [question.id])).toBe(true)
    const after = children(editor, frameId)
    // 書き直すボタン 1・「＋」2・版の帯 2・人のボタン 1
    expect(after.map((n) => n.type).sort()).toEqual(['button', 'button', 'button', 'button', 'button', 'button', 'geo', 'note', 'note'])
    expect(after.filter((n) => n.type === 'note').map(text)).toEqual(['この答えの前提\nMac アプリを作る', 'Mac のアプリも Xcode で作る。…'])
    expect(hintButtons(editor, frameId).map((n) => (n.props as ButtonProps).label)).toEqual(['iOS アプリ向けに'])
    expect(after.filter((n) => n.type === 'button' && !(n.props as ButtonProps).hint).map((n) => (n.props as ButtonProps).label)).toEqual(['表にして'])
    const frame = editor.getNode(frameId)!.props as FrameProps
    expect(frame.name).toBe('Swift の開発環境（Mac）')
    // 残した子は、並びを保ったまま新しい答え（AI のボタンと版の帯）の下へ。フレームはそれが収まる高さ
    const aiBottom = Math.max(...after.filter((n) => (n.props as ButtonProps).hint).map((n) => n.y + editor.index.get(n.id)!.localBounds.h))
    const keptImage = editor.getNode(image.id)!
    const keptButton = editor.getNode(mine.id)!
    expect(keptImage.y).toBeGreaterThan(aiBottom)
    expect(keptButton.y - keptImage.y).toBe(120)
    expect(frame.h).toBe(keptButton.y + editor.index.get(mine.id)!.localBounds.h + ANSWER_PADDING)

    editor.undo()
    expect(children(editor, frameId).map((n) => n.id)).toEqual(before)
    expect((editor.getNode(frameId)!.props as FrameProps).name).toBe('Swift の開発環境')
  })

  it('remembers the instructions applied to the frame, and the new notes start unedited', () => {
    const editor = new Editor()
    const question = note(editor, 'Swift を始めたい', { x: 0, y: 0 })
    editor.createNodes([question])
    const frameId = placeAnswer(editor, [question.id], answer)!
    replaceAnswer(editor, frameId, answer, [question.id], { instruction: '対象を Mac のアプリにして書き直す' })
    replaceAnswer(editor, frameId, answer, [question.id], { instruction: '短く' })
    const content = answerContent(editor, frameId)!
    expect(content.history).toEqual(['対象を Mac のアプリにして書き直す', '短く'])
    expect(content.notes.every((item) => !item.edited)).toBe(true)
    expect(content.assumptions.every((item) => !item.edited)).toBe(true)
  })

  it('an arrow kept in the frame keeps the shape it got when its notes were removed (not the old copy)', () => {
    const setup = () => {
      const editor = new Editor({ canvasId: 'canvas:1' })
      const question = note(editor, 'q', { x: 0, y: 0 })
      editor.createNodes([question])
      const frameId = placeAnswer(editor, [question.id], { title: 't', assumptions: [], paragraphs: ['a', 'b'], hints: [] })!
      const [first, second] = editor.index.childrenOf(frameId)
      const arrow = editor.makeNode('arrow', { x: 0, y: 0, parentId: frameId, props: { start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, bend: 0 } })
      editor.transact('arrow', (tx) => {
        tx.put(arrow)
        tx.put(makeBinding(arrow.id, first!, { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false }))
        tx.put(makeBinding(arrow.id, second!, { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false }))
      })
      return { editor, question, frameId, arrow, notes: [first!, second!] }
    }
    // 付箋を消しただけのときの矢印の形
    const control = setup()
    control.editor.deleteNodes(control.notes)
    const frozen = control.editor.getNode(control.arrow.id)!.props as ArrowProps

    const { editor, question, frameId, arrow } = setup()
    replaceAnswer(editor, frameId, { title: 't', assumptions: [], paragraphs: ['c'], hints: [] }, [question.id])
    expect(editor.bindingsOfArrow(arrow.id)).toHaveLength(0)
    const after = editor.getNode(arrow.id)!.props as ArrowProps
    expect(after.start).toEqual(frozen.start)
    expect(after.end).toEqual(frozen.end)
  })
})

describe('versions', () => {
  const second: CanvasAnswer = {
    title: 'Swift の開発環境（やさしく）',
    assumptions: ['Mac を使っている'],
    paragraphs: ['Xcode を入れれば、すぐ始められます。'],
    hints: [{ label: 'もっと詳しく', prompt: '詳しく書き直す' }],
  }

  function setup() {
    const editor = new Editor()
    const question = note(editor, 'Swift を始めたい', { x: 0, y: 0 })
    editor.createNodes([question])
    const frameId = placeAnswer(editor, [question.id], answer)!
    return { editor, question, frameId }
  }

  it('keeps the answer before a rewrite as a version, with a bar per version and the current one dark', () => {
    const { editor, question, frameId } = setup()
    replaceAnswer(editor, frameId, second, [question.id], { instruction: '初めての人にもわかる言葉で', via: 'もっと簡単な言葉で' })
    const bars = actionButtons(editor, frameId, 'version')
    expect(bars.map((n) => (n.props as ButtonProps).version)).toEqual([0, 1])
    expect((bars[1]!.props as ButtonProps).color).toBe(VERSION_BAR_CURRENT_COLOR)
    expect((bars[0]!.props as ButtonProps).color).not.toBe(VERSION_BAR_CURRENT_COLOR)
    expect((bars[0]!.props as ButtonProps).tooltip).toBe('ひとつ前の回答に戻る（「もっと簡単な言葉で」を押す前）')
    expect((bars[1]!.props as ButtonProps).tooltip).toBe('今の回答（「もっと簡単な言葉で」）')
    // 帯は「＋」の並びの下
    const plus = actionButtons(editor, frameId, 'ask-left')[0]!
    expect(bars[0]!.y).toBeGreaterThan(plus.y + editor.index.get(plus.id)!.localBounds.h)
  })

  it('goes back to an older version and forward again without Claude, keeping what the person rewrote and its edited mark', () => {
    const { editor, question, frameId } = setup()
    // 最初の答えの 2 段落目を人が書き換えてから、書き直す
    const target = children(editor, frameId).filter((n) => n.type === 'note')[2]!
    editor.transact('edit', (tx) => tx.put({ ...target, props: { ...(target.props as NoteProps), paragraphs: richTextFromPlain('人が書き換えた段落') } }))
    replaceAnswer(editor, frameId, second, [question.id], { via: 'もっと簡単な言葉で' })
    expect(answerContent(editor, frameId)!.notes.map((n) => n.text)).toEqual(['Xcode を入れれば、すぐ始められます。'])

    expect(restoreAnswerVersion(editor, frameId, 0)).toBe(true)
    const back = answerContent(editor, frameId)!
    expect(back.title).toBe('Swift の開発環境')
    expect(back.notes).toEqual([
      { text: answer.paragraphs[0], edited: false },
      { text: '人が書き換えた段落', edited: true },
      { text: answer.paragraphs[2], edited: false },
    ])
    expect(hintButtons(editor, frameId).map((n) => (n.props as ButtonProps).label)).toEqual(['Mac アプリ向けに', 'もっと簡単な言葉で'])
    const bars = actionButtons(editor, frameId, 'version')
    expect((bars[0]!.props as ButtonProps).color).toBe(VERSION_BAR_CURRENT_COLOR)
    expect((bars[1]!.props as ButtonProps).tooltip).toBe('ひとつ後の回答に進む（「もっと簡単な言葉で」）')
    // 今の版には戻せない
    expect(restoreAnswerVersion(editor, frameId, 0)).toBe(false)

    // 進むと、2 つ目の版に戻る。1 回の Undo で、戻した版のまま
    expect(restoreAnswerVersion(editor, frameId, 1)).toBe(true)
    expect(answerContent(editor, frameId)!.notes.map((n) => n.text)).toEqual(['Xcode を入れれば、すぐ始められます。'])
    editor.undo()
    expect(answerContent(editor, frameId)!.notes[1]).toEqual({ text: '人が書き換えた段落', edited: true })
  })

  it('a rewrite while looking at an older version adds the new answer as the last version, and keeps at most KEPT_VERSIONS', () => {
    const { editor, question, frameId } = setup()
    replaceAnswer(editor, frameId, second, [question.id], { via: 'A' })
    restoreAnswerVersion(editor, frameId, 0)
    replaceAnswer(editor, frameId, { ...second, title: '三つ目' }, [question.id], { via: 'B' })
    let bars = actionButtons(editor, frameId, 'version')
    expect(bars).toHaveLength(3)
    expect((bars[2]!.props as ButtonProps).color).toBe(VERSION_BAR_CURRENT_COLOR)
    for (let i = 0; i < KEPT_VERSIONS + 2; i++) replaceAnswer(editor, frameId, { ...second, title: `版 ${i}` }, [question.id], { via: `押した ${i}` })
    bars = actionButtons(editor, frameId, 'version')
    expect(bars).toHaveLength(KEPT_VERSIONS)
    expect(bars.map((n) => (n.props as ButtonProps).version)).toEqual([...Array(KEPT_VERSIONS).keys()])
    expect(restoreAnswerVersion(editor, frameId, 0)).toBe(true)
    expect(answerContent(editor, frameId)!.title).toBe('版 2')
  })

  it('describes the bars', () => {
    const versions = [{}, { via: 'A' }, { via: 'B' }, { via: 'C' }]
    expect(versionTooltip(versions, 0, 2)).toBe('2 つ前の回答に戻る（「A」を押す前）')
    expect(versionTooltip(versions, 3, 1)).toBe('2 つ後の回答に進む（「C」）')
    expect(versionTooltip(versions, 0, 0)).toBe('今の回答')
  })
})

describe('follow-up questions', () => {
  it('puts an AI-mode note beside the answer at the height of the question, linked to the answer, with an arrow from the frame', () => {
    const editor = new Editor()
    const question = note(editor, 'Swift を始めたい', { x: 0, y: 0 })
    editor.createNodes([question])
    const frameId = placeAnswer(editor, [question.id], answer)!
    const frameBox = editor.index.get(frameId)!.worldBounds
    const tx = editor.begin('follow-up')
    const noteId = placeFollowUp(editor, tx, frameId, 'right')!
    tx.commit()
    const placed = editor.index.get(noteId)!
    expect(placed.worldBounds).toMatchObject({ x: frameBox.x + frameBox.w + FOLLOW_UP_GAP, y: 0 })
    expect(aiNoteMeta(placed.node)).toEqual({ contexts: [{ kind: 'answer', frameId, label: 'Swift の開発環境' }] })
    expect(arrows(editor).at(-1)).toMatchObject({ start: frameId, end: noteId })

    // 左に置くときは、フレームの左。重なれば、さらに外へ
    const blocker = editor.makeNode('geo', { x: -200, y: 0, props: { w: 100, h: 100 } })
    editor.createNodes([blocker])
    const tx2 = editor.begin('follow-up')
    const leftId = placeFollowUp(editor, tx2, frameId, 'left')!
    tx2.commit()
    const left = editor.index.get(leftId)!.worldBounds
    expect(left.x + left.w).toBe(-200 - FOLLOW_UP_GAP)

    // 1 回の Undo で、付箋も矢印も消える
    editor.undo()
    expect(editor.getNode(leftId)).toBeUndefined()
    expect(arrows(editor).some((arrow) => arrow.end === leftId)).toBe(false)
  })

  it('the arrows it draws go away with either end (deleting the follow-up note, the question or the answer), and come back with undo', () => {
    const editor = new Editor()
    const question = note(editor, 'Swift を始めたい', { x: 0, y: 0 })
    const other = note(editor, '別の付箋', { x: 2000, y: 2000 })
    editor.createNodes([question, other])
    const frameId = placeAnswer(editor, [question.id], answer)!
    const tx = editor.begin('follow-up')
    const noteId = placeFollowUp(editor, tx, frameId, 'right')!
    tx.commit()
    // 人が引いた矢印（答え → 別の付箋）は、端を止めて残す
    const mine = editor.makeNode('arrow', { x: 0, y: 0, props: { start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, bend: 0 } })
    editor.transact('arrow', (tx) => {
      tx.put(mine)
      tx.put(makeBinding(mine.id, frameId, { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false }))
      tx.put(makeBinding(mine.id, other.id, { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false }))
    })
    expect(arrows(editor)).toHaveLength(3)

    editor.deleteNodes([noteId])
    expect(arrows(editor).map((arrow) => `${arrow.start}->${arrow.end}`)).toEqual([`${question.id}->${frameId}`, `${frameId}->${other.id}`])
    editor.undo()
    expect(arrows(editor)).toHaveLength(3)

    editor.deleteNodes([frameId])
    const left = arrows(editor)
    expect(left.map((arrow) => arrow.id)).toEqual([mine.id])
    expect(left[0]!.start).toBeUndefined()

    editor.undo()
    editor.deleteNodes([question.id])
    expect(arrows(editor).some((arrow) => arrow.start === question.id || arrow.end === frameId && arrow.id !== mine.id)).toBe(false)
  })

  it('a follow-up answer remembers the previous answer, and previousTurns walks back up to three answers, oldest first', () => {
    const editor = new Editor()
    const question = note(editor, 'Swift を始めたい', { x: 0, y: 0 })
    editor.createNodes([question])
    let frameId = placeAnswer(editor, [question.id], answer)!
    const asked: string[] = []
    for (let i = 1; i <= 4; i++) {
      const tx = editor.begin('follow-up')
      const noteId = placeFollowUp(editor, tx, frameId, 'right')!
      tx.put({ ...nodeInTx(editor, tx, noteId), props: { ...(nodeInTx(editor, tx, noteId).props as NoteProps), paragraphs: richTextFromPlain(`続き ${i}`) } })
      tx.commit()
      asked.push(`続き ${i}`)
      frameId = placeAnswer(editor, [noteId], { ...answer, title: `答え ${i}` }, { followUpOf: frameId })!
    }
    const turns = previousTurns(editor, frameId)
    expect(turns.map((turn) => turn.title)).toEqual(['答え 2', '答え 3', '答え 4'])
    expect(turns.map((turn) => turn.question)).toEqual(['続き 2', '続き 3', '続き 4'])
    expect(turns[0]!.paragraphs).toEqual(answer.paragraphs)
  })
})

function nodeInTx(editor: Editor, tx: { get(id: string): unknown }, id: string): NodeRecord {
  void editor
  return tx.get(id) as NodeRecord
}

describe('sticky-note Markdown', () => {
  const formatted: CanvasAnswer = {
    title: 'Swift の開発環境',
    assumptions: ['`Xcode` を使う'],
    paragraphs: ['**Xcode** を入れれば、開発環境はほぼ整う。', 'まず `xcode-select --install` を打つ。'],
    hints: [],
  }

  it('turns the Markdown of the answer into formatted notes, and reads it back as the same Markdown, unedited', () => {
    const editor = new Editor()
    const question = note(editor, 'Swift を始めたい', { x: 0, y: 0 })
    editor.createNodes([question])
    const frameId = placeAnswer(editor, [question.id], formatted)!
    const [premise, first, second] = children(editor, frameId)
    expect((premise!.props as NoteProps).paragraphs[1]).toEqual({ runs: [{ text: 'Xcode', format: { fontFamily: 'monospace' } }, { text: ' を使う' }], list: { type: 'bullet', level: 0 } })
    expect((first!.props as NoteProps).paragraphs).toEqual([{ runs: [{ text: 'Xcode', format: { fontWeight: 700 } }, { text: ' を入れれば、開発環境はほぼ整う。' }] }])
    expect((second!.props as NoteProps).paragraphs[0]!.runs[1]).toEqual({ text: 'xcode-select --install', format: { fontFamily: 'monospace' } })
    const content = answerContent(editor, frameId)!
    expect(content.assumptions).toEqual([{ text: '`Xcode` を使う', edited: false }])
    expect(content.notes).toEqual(formatted.paragraphs.map((text) => ({ text, edited: false })))
  })

  it('sends formatting the person added, and marks a note whose formatting alone changed as edited', () => {
    const editor = new Editor()
    const question = editor.makeNode('note', { x: 0, y: 0, props: { paragraphs: [{ runs: [{ text: 'Swift', format: { color: '#e03131' } }, { text: ' を始めたい' }] }] } })
    editor.createNodes([question])
    expect(questionOf(editor, [question.id])!.question).toBe('[Swift]{color=#e03131} を始めたい')
    const frameId = placeAnswer(editor, [question.id], formatted)!
    const second = children(editor, frameId)[2]!
    const props = second.props as NoteProps
    // 文字はそのまま、最初の語に下線だけを付ける
    const [lead, ...rest] = props.paragraphs[0]!.runs
    editor.transact('underline', (tx) => tx.put({ ...second, props: { ...props, paragraphs: [{ runs: [{ ...lead!, format: { underline: true } }, ...rest] }] } }))
    const content = answerContent(editor, frameId)!
    expect(content.notes[1]).toEqual({ text: "[まず ]{.underline}`xcode-select --install` を打つ。", edited: true })
    expect(content.notes[0]!.edited).toBe(false)
  })
})

describe('waitUntilIdle', () => {
  it('waits while a transaction is open, and returns when it closes or when aborted', async () => {
    const editor = new Editor()
    const tx = editor.begin('drag')
    let done = false
    const waiting = waitUntilIdle(editor, undefined, 5).then(() => (done = true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(done).toBe(false)
    editor.finish(tx)
    await waiting
    expect(done).toBe(true)

    const open = editor.begin('edit text')
    const abort = new AbortController()
    const stopped = waitUntilIdle(editor, abort.signal, 5)
    abort.abort()
    await stopped
    expect(editor.store.activeTransaction).toBe(open)
    open.cancel()
  })
})
