import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { plainTextOf, richTextFromPlain, type NoteProps, type TextProps } from '@canvcode/nodes'
import {
  ANSWER_TEXT_FONT_SIZE,
  ANSWER_TEXT_GAP,
  ANSWER_CANDIDATE_LENGTH,
  ANSWER_TEXT_WIDTH,
  FOLLOW_UP_GAP,
  FOLLOW_UP_LENGTH,
  aiNoteMeta,
  answerCandidates,
  chatContext,
  firstLine,
  fitTurns,
  followUpContext,
  placeAnswerText,
  placeFollowUpAt,
  placeFollowUpNote,
  previousTurnsOf,
  questionOf,
  questionText,
  setAiAnswer,
  setAiNote,
  waitUntilIdle,
  type AiAnswer,
} from './answers.ts'
import { Editor } from './editor.ts'

// キャンバスの AI：付箋で聞き、答えは付箋に持たせる

function note(editor: Editor, text: string, at: { x: number; y: number }, extra: { parentId?: string; meta?: Record<string, unknown> } = {}): NodeRecord {
  const node = editor.makeNode('note', { ...at, ...(extra.parentId ? { parentId: extra.parentId } : {}), props: { paragraphs: richTextFromPlain(text) } })
  return extra.meta ? { ...node, meta: { ...node.meta, ...extra.meta } } : node
}

function answer(body: string, question = 'コンテキストとは？'): AiAnswer {
  return { body, related: [], model: 'claude-opus-5-5', effort: 'high', question, answeredAt: 1 }
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

describe('answerCandidates', () => {
  it('lists the notes with text nearest to the question first, leaving out the question, empty notes and other nodes', () => {
    const editor = new Editor()
    const question = note(editor, 'Q', { x: 0, y: 0 })
    const far = note(editor, '遠い', { x: 3000, y: 0 })
    const near = note(editor, '近い\n  二行目', { x: 300, y: 0 })
    const frame = editor.makeNode('frame', { x: 0, y: 600, props: { w: 400, h: 400, name: 'F' } })
    const inFrame = note(editor, 'フレームの中', { x: 10, y: 10 }, { parentId: frame.id })
    const empty = note(editor, ' ', { x: 0, y: 300 })
    const geo = editor.makeNode('geo', { x: 0, y: 300 })
    editor.createNodes([question, far, near, frame, inFrame, empty, geo])
    expect(answerCandidates(editor, [question.id])).toEqual([
      { id: near.id, text: '近い 二行目' },
      { id: inFrame.id, text: 'フレームの中' },
      { id: far.id, text: '遠い' },
    ])
    expect(answerCandidates(editor, [question.id], 1).map((candidate) => candidate.id)).toEqual([near.id])
    expect(answerCandidates(editor, ['node:gone'])).toEqual([])
  })

  it('cuts long text', () => {
    const editor = new Editor()
    const question = note(editor, 'Q', { x: 0, y: 0 })
    const long = note(editor, 'あ'.repeat(ANSWER_CANDIDATE_LENGTH + 5), { x: 300, y: 0 })
    editor.createNodes([question, long])
    expect(Array.from(answerCandidates(editor, [question.id])[0]!.text)).toHaveLength(ANSWER_CANDIDATE_LENGTH)
  })
})

describe('aiNoteMeta', () => {
  it('reads the contexts, the model and the answer, and drops what does not fit', () => {
    const editor = new Editor()
    const target = { canvasId: editor.canvasId, rect: { x: 0, y: 0, w: 10, h: 10 }, nodes: [] }
    const ai = {
      contexts: [
        { kind: 'answer', noteId: 'node:a', canvasId: 'canvas:b', label: '前', turns: [{ question: 'Q', answer: 'A' }, { question: 1 }] },
        { kind: 'answer', frameId: 'node:old', label: '前の作りの札' },
        { kind: 'canvas', label: '範囲', target },
        'broken',
      ],
      model: 'opus',
      effort: 'high',
      answer: { body: '本文', related: ['node:x', 3], model: 'claude-opus-5-5', question: 'Q', answeredAt: 5 },
    }
    const node = note(editor, 'Q', { x: 0, y: 0 }, { meta: { ai } })
    expect(aiNoteMeta(node)).toEqual({
      contexts: [
        { kind: 'answer', noteId: 'node:a', canvasId: 'canvas:b', label: '前', turns: [{ question: 'Q', answer: 'A' }] },
        { kind: 'canvas', label: '範囲', target },
      ],
      model: 'opus',
      effort: 'high',
      answer: { body: '本文', related: ['node:x'], model: 'claude-opus-5-5', question: 'Q', answeredAt: 5 },
    })
    expect(aiNoteMeta(note(editor, 'Q', { x: 0, y: 0 }, { meta: { ai: { contexts: [], answer: { body: 1 } } } }))).toEqual({ contexts: [] })
    expect(aiNoteMeta(note(editor, 'Q', { x: 0, y: 0 }))).toBeNull()
    expect(aiNoteMeta({ ...editor.makeNode('geo', { x: 0, y: 0 }), meta: { ai } })).toBeNull()
  })
})

describe('setAiAnswer', () => {
  it('writes the answer to the note, makes it an AI note if it was not, keeps the contexts and the model, and comes back with one undo', () => {
    const editor = new Editor()
    const plain = note(editor, 'コンテキストとは？', { x: 0, y: 0 })
    const target = { canvasId: editor.canvasId, rect: { x: 0, y: 0, w: 10, h: 10 }, nodes: [] }
    const ai = note(editor, '続き', { x: 0, y: 300 }, { meta: { ai: { contexts: [{ kind: 'canvas', label: '範囲', target }], model: 'sonnet' } } })
    editor.createNodes([plain, ai])

    expect(setAiAnswer(editor, plain.id, answer('トークンの量のこと。'))).toBe(true)
    expect(aiNoteMeta(editor.getNode(plain.id))).toEqual({ contexts: [], answer: answer('トークンの量のこと。') })
    editor.undo()
    expect(aiNoteMeta(editor.getNode(plain.id))).toBeNull()

    setAiAnswer(editor, ai.id, answer('一度目'))
    setAiAnswer(editor, ai.id, answer('二度目'))
    expect(aiNoteMeta(editor.getNode(ai.id))).toEqual({ contexts: [{ kind: 'canvas', label: '範囲', target }], model: 'sonnet', answer: answer('二度目') })
    editor.undo()
    expect(aiNoteMeta(editor.getNode(ai.id))?.answer?.body).toBe('一度目')

    const geo = editor.makeNode('geo', { x: 0, y: 0 })
    editor.createNodes([geo])
    expect(setAiAnswer(editor, geo.id, answer('x'))).toBe(false)
    expect(setAiAnswer(editor, 'node:gone', answer('x'))).toBe(false)
  })

  it('ending the AI mode removes the answer too, and undo brings it back', () => {
    const editor = new Editor()
    const question = note(editor, 'Q', { x: 0, y: 0 })
    editor.createNodes([question])
    setAiAnswer(editor, question.id, answer('A'))
    setAiNote(editor, question.id, null)
    expect(aiNoteMeta(editor.getNode(question.id))).toBeNull()
    editor.undo()
    expect(aiNoteMeta(editor.getNode(question.id))?.answer?.body).toBe('A')
  })
})

describe('follow-up contexts', () => {
  it('carries the earlier turns of the note and adds its own question and answer, keeping the last three', () => {
    const turns = [1, 2, 3].map((n) => ({ question: `Q${n}`, answer: `A${n}` }))
    const meta = { contexts: [{ kind: 'answer' as const, noteId: 'node:prev', canvasId: 'canvas:x', label: 'Q3', turns }], answer: answer('A4', '**Q4** の続き\n二行目') }
    expect(followUpContext('node:me', 'canvas:me', meta)).toEqual({
      kind: 'answer',
      noteId: 'node:me',
      canvasId: 'canvas:me',
      label: 'Q4 の続き',
      turns: [turns[1], turns[2], { question: '**Q4** の続き\n二行目', answer: 'A4' }],
    })
    expect(previousTurnsOf(meta)).toEqual(turns)
    expect(followUpContext('node:me', 'canvas:me', { contexts: [] })).toBeNull()
    expect(followUpContext('node:me', 'canvas:me', null)).toBeNull()
  })

  it('drops older turns past the length, and cuts the answer of a single turn that is still too long', () => {
    const long = 'あ'.repeat(FOLLOW_UP_LENGTH)
    expect(fitTurns([{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: long }])).toEqual([{ question: 'Q2', answer: `${'あ'.repeat(FOLLOW_UP_LENGTH - 3)}…` }])
    const fitted = fitTurns([{ question: 'Q', answer: long + long }])[0]!
    expect(fitted.question.length + fitted.answer.length).toBeLessThanOrEqual(FOLLOW_UP_LENGTH)
    expect(fitTurns([])).toEqual([])
  })

  it('makes a chat context from an answer in the chat, reads it back, and carries its copy on to the follow-up', () => {
    const context = chatContext({ threadId: 't1', jobId: 'j1', title: '付箋UIの\nレビュー', question: 'レビューして', answer: '直すところは 3 つです' })
    expect(context).toEqual({ kind: 'chat', threadId: 't1', jobId: 'j1', label: '会話『付箋UIの レビュー』の答え', turns: [{ question: 'レビューして', answer: '直すところは 3 つです' }] })
    // 長い答えは収め、長い題は切る
    const long = chatContext({ threadId: 't1', jobId: 'j1', title: 'あ'.repeat(40), question: 'Q', answer: 'い'.repeat(FOLLOW_UP_LENGTH * 2) })
    expect(long.label).toBe(`会話『${'あ'.repeat(19)}…』の答え`)
    expect(long.turns[0]!.question.length + long.turns[0]!.answer.length).toBeLessThanOrEqual(FOLLOW_UP_LENGTH)
    // 付箋の meta から読み、送るときの前の答えにする
    const meta = aiNoteMeta(note(new Editor(), 'コンテキストとは？', { x: 0, y: 0 }, { meta: { ai: { contexts: [context, { kind: 'chat', threadId: 1 }] } } }))
    // 形の合わない id は落とす（写しがあれば、札としては読む）
    expect(meta!.contexts).toEqual([context, { kind: 'chat', label: '', turns: [] }])
    expect(previousTurnsOf(meta)).toEqual(context.turns)
    // その付箋で「続けて聞く」と、会話の答えの写しを引き継ぐ
    const asked = { ...meta!, answer: answer('答え', 'コンテキストとは？') }
    expect(followUpContext('node:me', 'canvas:me', asked)!.turns).toEqual([...context.turns, { question: 'コンテキストとは？', answer: '答え' }])
  })

  it('makes a chat context for a question asked from the chat, with its earlier answer, even outside a thread', () => {
    const previous = [{ question: '前の依頼', answer: '前の答え' }]
    expect(chatContext({ questionId: 'q1', question: '**コンテキスト**とは？', answer: '答え', previous })).toEqual({
      kind: 'chat',
      questionId: 'q1',
      label: '「コンテキストとは？」の答え',
      turns: [...previous, { question: '**コンテキスト**とは？', answer: '答え' }],
    })
    expect(chatContext({ threadId: 't1', questionId: 'q1', title: '題', question: 'Q', answer: 'A' }).label).toBe('会話『題』の答え')
  })

  it('names the context by the first line of the question, without formatting', () => {
    expect(firstLine('### **見出し**\n本文')).toBe('見出し')
    expect(firstLine('  ')).toBe('（質問）')
    expect(firstLine('あ'.repeat(70), 30)).toBe(`${'あ'.repeat(29)}…`)
  })
})

describe('placeFollowUpNote', () => {
  it('puts an AI note below the note, as wide as it, with the context and an arrow from the note, in the same transaction', () => {
    const editor = new Editor()
    const question = note(editor, 'Q', { x: 100, y: 50 })
    const wide = { ...question, props: { ...(question.props as NoteProps), w: 300 } }
    editor.createNodes([wide])
    setAiAnswer(editor, wide.id, answer('A'))
    const context = followUpContext(wide.id, editor.canvasId, aiNoteMeta(editor.getNode(wide.id)))!
    const tx = editor.begin('続けて聞く')
    const id = placeFollowUpNote(editor, tx, wide.id, context)!
    tx.commit()
    const source = editor.index.get(wide.id)!.worldBounds
    const placed = editor.getNode(id)!
    expect(placed).toMatchObject({ type: 'note', parentId: editor.canvasId, x: 100, y: source.y + source.h + FOLLOW_UP_GAP })
    expect((placed.props as NoteProps).w).toBe(300)
    expect(aiNoteMeta(placed)).toEqual({ contexts: [context] })
    expect(arrows(editor).map((arrow) => [arrow.start, arrow.end])).toEqual([[wide.id, id]])

    editor.undo()
    expect(editor.getNode(id)).toBeUndefined()
    expect(arrows(editor)).toEqual([])
  })

  it('moves further down past anything in the way, including a frame that holds the note', () => {
    const editor = new Editor()
    const frame = editor.makeNode('frame', { x: 0, y: 0, props: { w: 600, h: 400, name: 'F' } })
    const question = note(editor, 'Q', { x: 20, y: 20 }, { parentId: frame.id })
    editor.createNodes([frame, question])
    const tx = editor.begin('続けて聞く')
    const id = placeFollowUpNote(editor, tx, question.id, { kind: 'answer', noteId: question.id, canvasId: editor.canvasId, label: 'Q', turns: [] })!
    tx.commit()
    expect(editor.getNode(id)!.parentId).toBe(editor.canvasId)
    expect(editor.index.get(id)!.worldBounds.y).toBe(400 + FOLLOW_UP_GAP / 2)
  })

  it('does nothing for a node that is not a note', () => {
    const editor = new Editor()
    const geo = editor.makeNode('geo', { x: 0, y: 0 })
    editor.createNodes([geo])
    const tx = editor.begin('続けて聞く')
    expect(placeFollowUpNote(editor, tx, geo.id, { kind: 'answer', noteId: geo.id, canvasId: editor.canvasId, label: '', turns: [] })).toBeNull()
    tx.cancel()
  })

  it('the arrow goes away with either end, and comes back with undo', () => {
    const editor = new Editor()
    const question = note(editor, 'Q', { x: 0, y: 0 })
    editor.createNodes([question])
    const tx = editor.begin('続けて聞く')
    const id = placeFollowUpNote(editor, tx, question.id, { kind: 'answer', noteId: question.id, canvasId: editor.canvasId, label: 'Q', turns: [] })!
    tx.commit()
    editor.deleteNodes([id])
    expect(arrows(editor)).toEqual([])
    editor.undo()
    expect(arrows(editor)).toHaveLength(1)
    editor.deleteNodes([question.id])
    expect(arrows(editor)).toEqual([])
  })
})

describe('placeFollowUpAt', () => {
  it('puts an AI note with its middle at the point, without an arrow', () => {
    const editor = new Editor()
    const tx = editor.begin('続けて聞く')
    const context = { kind: 'answer' as const, noteId: 'node:far', canvasId: 'canvas:other', label: 'Q', turns: [{ question: 'Q', answer: 'A' }] }
    const id = placeFollowUpAt(editor, tx, { x: 500, y: 400 }, context)
    tx.commit()
    const box = editor.index.get(id)!.worldBounds
    expect(box.x + box.w / 2).toBe(500)
    expect(box.y + box.h / 2).toBe(400)
    expect(aiNoteMeta(editor.getNode(id))).toEqual({ contexts: [context] })
    expect(arrows(editor)).toEqual([])
  })
})

describe('placeAnswerText', () => {
  const body = '### なぜ気にするのか\n会話が長くなると、**前のやり取り**も読み直される。\n\n- 古い部分から切り捨て\n- 取り違えが起きやすい'

  it('puts the answer as one formatted text right of the note, with an arrow from the note, and takes it back with one undo', () => {
    const editor = new Editor()
    const question = note(editor, 'Q', { x: 100, y: 50 })
    editor.createNodes([question])
    const id = placeAnswerText(editor, body, { noteId: question.id })!
    const text = editor.getNode(id)! as NodeRecord<TextProps>
    const source = editor.index.get(question.id)!.worldBounds
    expect(text).toMatchObject({ type: 'text', parentId: editor.canvasId, x: source.x + source.w + ANSWER_TEXT_GAP, y: 50 })
    expect(text.props).toMatchObject({ w: ANSWER_TEXT_WIDTH, autoWidth: false, fontSize: ANSWER_TEXT_FONT_SIZE })
    const paragraphs = text.props.paragraphs
    expect(plainTextOf(paragraphs)).toBe('なぜ気にするのか\n会話が長くなると、前のやり取りも読み直される。\n\n古い部分から切り捨て\n取り違えが起きやすい')
    expect(paragraphs[0]!.runs[0]!.format?.fontWeight).toBe(700)
    expect(paragraphs[1]!.runs.find((run) => run.text === '前のやり取り')?.format?.fontWeight).toBe(700)
    expect(paragraphs.filter((paragraph) => paragraph.list?.type === 'bullet')).toHaveLength(2)
    expect(arrows(editor).map((arrow) => [arrow.start, arrow.end])).toEqual([[question.id, id]])

    editor.undo()
    expect(editor.getNode(id)).toBeUndefined()
    expect(arrows(editor)).toEqual([])
  })

  it('moves right past anything in the way', () => {
    const editor = new Editor()
    const question = note(editor, 'Q', { x: 0, y: 0 })
    const other = note(editor, '隣', { x: 300, y: 0 })
    editor.createNodes([question, other])
    const id = placeAnswerText(editor, body, { noteId: question.id })!
    const right = editor.index.get(other.id)!.worldBounds
    expect(editor.index.get(id)!.worldBounds.x).toBe(right.x + right.w + ANSWER_TEXT_GAP / 2)
  })

  it('puts it with its middle at a point without an arrow, and does nothing for a note that is gone', () => {
    const editor = new Editor()
    const id = placeAnswerText(editor, body, { center: { x: 1000, y: 800 } })!
    const box = editor.index.get(id)!.worldBounds
    expect(box.x + box.w / 2).toBeCloseTo(1000)
    expect(box.y + box.h / 2).toBeCloseTo(800)
    expect(arrows(editor)).toEqual([])
    expect(placeAnswerText(editor, body, { noteId: 'node:gone' })).toBeNull()
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
