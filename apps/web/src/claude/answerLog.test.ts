import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestAnswer } from './answer.ts'
import { AnswerLog, KEPT_ANSWERS, KEPT_THINKING, thinkingBlocks } from './answerLog.ts'

// 付箋で聞いた答え（キャンバスの AI）の記録と、考えている中身の受け取り

function memoryStorage() {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), data }
}

describe('AnswerLog', () => {
  it('records a running answer, streams its thinking, and keeps it in the browser once finished', () => {
    const storage = memoryStorage()
    const log = new AnswerLog(storage)
    const changes = vi.fn()
    log.subscribe(changes)
    const id = log.start({ canvasId: 'canvas:1', kind: 'ask', label: 'Swift を始めたい' })
    log.appendThinking(id, 'まず')
    log.appendThinking(id, '質問を読む。')
    expect(log.getSnapshot()[0]).toMatchObject({ id, status: 'running', thinking: 'まず質問を読む。' })
    // 回答中のものは残さない
    expect(storage.data.size).toBe(0)
    log.finish(id, { status: 'done', noteId: 'node:f' })
    expect(log.getSnapshot()[0]).toMatchObject({ status: 'done', noteId: 'node:f' })
    expect(changes).toHaveBeenCalledTimes(4)

    // 開き直すと、終わったものが戻る
    expect(new AnswerLog(storage).getSnapshot()).toEqual([expect.objectContaining({ id, status: 'done', thinking: 'まず質問を読む。', noteId: 'node:f' })])
  })

  it('keeps at most KEPT_ANSWERS finished answers, cuts long thinking, and clears only the finished ones', () => {
    const storage = memoryStorage()
    const log = new AnswerLog(storage)
    for (let i = 0; i < KEPT_ANSWERS + 3; i++) {
      const id = log.start({ canvasId: 'canvas:1', kind: 'rewrite', label: `書き直し ${i}` })
      if (i === KEPT_ANSWERS + 2) log.appendThinking(id, 'あ'.repeat(KEPT_THINKING + 10))
      log.finish(id, { status: 'failed', error: 'だめ' })
    }
    const running = log.start({ canvasId: 'canvas:1', kind: 'follow-up', label: '続き' })
    const reloaded = new AnswerLog(storage).getSnapshot()
    expect(reloaded).toHaveLength(KEPT_ANSWERS)
    expect(reloaded[0]!.label).toBe(`書き直し ${KEPT_ANSWERS + 2}`)
    expect(reloaded[0]!.thinking.length).toBe(KEPT_THINKING + 1)
    log.clearFinished()
    expect(log.getSnapshot().map((entry) => entry.id)).toEqual([running])
    expect(new AnswerLog(storage).getSnapshot()).toEqual([])
  })

  it('ignores broken saved data', () => {
    const storage = memoryStorage()
    storage.setItem('canvcode.claude.answers', '{oops')
    expect(new AnswerLog(storage).getSnapshot()).toEqual([])
    storage.setItem('canvcode.claude.answers', JSON.stringify([{ id: 1 }, { id: 'a', canvasId: 'c', label: 'l', thinking: '', startedAt: 1, kind: 'ask', status: 'running' }]))
    expect(new AnswerLog(storage).getSnapshot()).toEqual([])
  })
})

describe('thinkingBlocks', () => {
  it('splits the thinking into paragraphs and runs of search lines, dropping the extra blank lines between them', () => {
    const text =
      'The user wants me to run searches,\nso I will fire off several.\n\n― Web で調べる：容量市場 問題点\n\n\n\n― Web で調べる：容量拠出金 新電力\n\n\n\n― ページを読む：https://www.occto.or.jp/\n\nI am reading the results.\n\n\n\nNow I write.'
    expect(thinkingBlocks(text)).toEqual([
      { kind: 'text', text: 'The user wants me to run searches,\nso I will fire off several.' },
      { kind: 'tool', lines: ['Web で調べる：容量市場 問題点', 'Web で調べる：容量拠出金 新電力', 'ページを読む：https://www.occto.or.jp/'] },
      { kind: 'text', text: 'I am reading the results.' },
      { kind: 'text', text: 'Now I write.' },
    ])
    expect(thinkingBlocks('')).toEqual([])
  })
})

describe('requestAnswer', () => {
  afterEach(() => vi.unstubAllGlobals())

  const answer = { body: '### 題\n本文', related: ['node:a', 3], model: 'claude-sonnet-5-5' }

  // 行を 1 つずつ流す NDJSON の答え（行の途中で切れて届くこともある）
  function ndjson(chunks: string[]): Response {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } })
  }

  it('asks for NDJSON, passes the steps and the thinking as they come, and returns the answer', async () => {
    const fetch = vi.fn(async () =>
      ndjson([
        `{"type":"step","step":"read"}\n{"type":"thinking","text":"まず"}\n{"type":"thi`,
        `nking","text":"考える。"}\n{"type":"step","step":"write"}\n{"type":"step","step":"nope"}\n`,
        `${JSON.stringify({ type: 'answer', answer })}\n`,
      ]),
    )
    vi.stubGlobal('fetch', fetch)
    const thoughts: string[] = []
    const steps: string[] = []
    const result = await requestAnswer({ question: 'q' }, { model: 'opus' }, { onThinking: (text) => thoughts.push(text), onStep: (step) => steps.push(step) })
    expect(thoughts).toEqual(['まず', '考える。'])
    expect(steps).toEqual(['read', 'write'])
    expect(result).toEqual({ body: '### 題\n本文', related: ['node:a'], model: 'claude-sonnet-5-5' })
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toMatchObject({ accept: 'application/x-ndjson' })
    expect(JSON.parse(init.body as string)).toEqual({ question: 'q', model: 'opus' })
  })

  it('throws the error line, an error status, or a stream that ends without an answer', async () => {
    vi.stubGlobal('fetch', async () => ndjson([`{"type":"thinking","text":"…"}\n{"type":"error","status":502,"error":"答えられませんでした：短く"}\n`]))
    await expect(requestAnswer({ question: 'q' }, {})).rejects.toThrow('答えられませんでした：短く')
    vi.stubGlobal('fetch', async () => ndjson([`{"type":"thinking","text":"…"}\n`]))
    await expect(requestAnswer({ question: 'q' }, {})).rejects.toThrow('答えが返ってきませんでした')
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: '多すぎます' }), { status: 429, headers: { 'content-type': 'application/json' } }))
    await expect(requestAnswer({ question: 'q' }, {})).rejects.toThrow('多すぎます')
  })
})
