import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnswerError, requestAnswer } from './answer.ts'

// 付箋で聞く答えを NDJSON で受ける

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

  it('sends the canvas the user is viewing (canvasId) with the question', async () => {
    const fetch = vi.fn(async () => ndjson([`${JSON.stringify({ type: 'answer', answer })}\n`]))
    vi.stubGlobal('fetch', fetch)
    await requestAnswer({ question: 'ここの要点は？', canvasId: 'canvas:abc', source: { kind: 'chat', label: 'ここの要点は？' } }, { model: 'sonnet' })
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ question: 'ここの要点は？', canvasId: 'canvas:abc', source: { kind: 'chat', label: 'ここの要点は？' }, model: 'sonnet' })
  })

  it('passes the id of the running question from the first line, and throws the status of an error line', async () => {
    vi.stubGlobal('fetch', async () => ndjson([`{"type":"start","id":"q-1"}\n{"type":"error","status":499,"error":"頼むのをやめました"}\n`]))
    const started: string[] = []
    const failure = await requestAnswer({ question: 'q', source: { noteId: 'node:a', canvasId: 'canvas:b', label: 'q' } }, {}, { onStart: (id) => started.push(id) }).catch((error: unknown) => error)
    expect(started).toEqual(['q-1'])
    expect(failure).toBeInstanceOf(AnswerError)
    expect(failure).toMatchObject({ status: 499, message: '頼むのをやめました' })
  })

  it('passes the thread of a question from the chat from the first line (a new thread when none was chosen)', async () => {
    vi.stubGlobal('fetch', async () => ndjson([`{"type":"start","id":"q-2","threadId":"q-2"}\n{"type":"error","status":499,"error":"x"}\n`]))
    const started: [string, string | undefined][] = []
    await requestAnswer({ question: 'q', source: { kind: 'chat', label: 'q' } } as never, {}, { onStart: (id, threadId) => started.push([id, threadId]) }).catch(() => undefined)
    expect(started).toEqual([['q-2', 'q-2']])
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
