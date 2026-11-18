import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnswerWriter, handleAnswer } from './answer.ts'
import { ClaudeOnce, type OnceQuery } from './once.ts'
import { KEPT_QUESTION_THINKING, RunningQuestions, handleQuestions, parseQuestionSource, type QuestionChange } from './questions.ts'

// 付箋で聞いている、動いている質問（サーバーのメモリに持ち、すべてのタブに流す）

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.useRealTimers()
})

const source = { noteId: 'node:q1', canvasId: 'canvas:c1', label: 'コンテキストとは？' }

function watch(questions: RunningQuestions): QuestionChange[] {
  const changes: QuestionChange[] = []
  questions.subscribe((change) => changes.push(change))
  return changes
}

describe('RunningQuestions', () => {
  it('lists a question from its start, passes its steps and thinking, and keeps it until it ends', () => {
    const questions = new RunningQuestions()
    const changes = watch(questions)
    const id = questions.start(source, { model: 'opus', effort: 'high' }, () => {})
    expect(questions.list()).toEqual([{ id, ...source, model: 'opus', effort: 'high', status: 'running', step: 'read', thinking: '', startedAt: expect.any(Number) }])
    questions.step(id, 'read')
    questions.step(id, 'search')
    questions.thinking(id, 'まず')
    questions.thinking(id, '')
    questions.thinking(id, '調べる')
    expect(questions.list()[0]).toMatchObject({ step: 'search', thinking: 'まず調べる' })
    expect(questions.end(id, 'failed', 'だめでした')).toBe(true)
    expect(questions.list()).toEqual([])
    expect(questions.end(id, 'done')).toBe(false)
    expect(changes.map((change) => change.type)).toEqual(['question', 'question', 'question-thinking', 'question-thinking', 'question-done'])
    // 変化には考えている中身を入れない（続きは question-thinking で流す）
    expect(changes[1]).toEqual({ type: 'question', question: { id, ...source, model: 'opus', effort: 'high', status: 'running', step: 'search', startedAt: expect.any(Number) } })
    expect(changes.at(-1)).toEqual({ type: 'question-done', id, status: 'failed', error: 'だめでした' })
  })

  it('keeps at most KEPT_QUESTION_THINKING characters of thinking, but passes all of it on', () => {
    const questions = new RunningQuestions()
    const changes = watch(questions)
    const id = questions.start(source, {}, () => {})
    questions.thinking(id, 'あ'.repeat(KEPT_QUESTION_THINKING - 1))
    questions.thinking(id, 'いう')
    expect(questions.list()[0]!.thinking).toBe(`${'あ'.repeat(KEPT_QUESTION_THINKING - 1)}い`)
    expect(changes.at(-1)).toEqual({ type: 'question-thinking', id, text: 'いう' })
  })

  it('waits for the screen to place the answer, and ends it as done when no word comes in time', () => {
    vi.useFakeTimers()
    const questions = new RunningQuestions({ placingTimeoutMs: 1000 })
    const changes = watch(questions)
    const id = questions.start(source, { model: 'sonnet' }, () => {})
    questions.placing(id, 'claude-sonnet-5-5')
    expect(questions.list()[0]).toMatchObject({ status: 'placing', step: 'write', model: 'claude-sonnet-5-5' })
    vi.advanceTimersByTime(999)
    expect(questions.list()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(questions.list()).toEqual([])
    expect(changes.at(-1)).toEqual({ type: 'question-done', id, status: 'done' })
  })

  it('cancel stops Claude while the answer is written, and ends it at once while it waits to be placed', () => {
    const questions = new RunningQuestions()
    const changes = watch(questions)
    const abort = vi.fn()
    const running = questions.start(source, {}, abort)
    expect(questions.cancel(running)).toBe(true)
    expect(abort).toHaveBeenCalledOnce()
    // 終えるのは、答えを書く仕組み（Claude が止まったら cancelled で終える）
    expect(questions.list()).toHaveLength(1)

    const placing = questions.start(source, {}, abort)
    questions.placing(placing)
    expect(questions.cancel(placing)).toBe(true)
    expect(abort).toHaveBeenCalledOnce()
    expect(changes.at(-1)).toEqual({ type: 'question-done', id: placing, status: 'cancelled' })
    expect(questions.cancel('nope')).toBe(false)
  })
})

describe('parseQuestionSource', () => {
  it('reads the note, the canvas and the label (one line, cut, or a default)', () => {
    expect(parseQuestionSource(undefined)).toBeUndefined()
    expect(parseQuestionSource({ noteId: 'node:a', canvasId: 'canvas:b', label: ' 一行目\n 二行目 ' })).toEqual({ noteId: 'node:a', canvasId: 'canvas:b', label: '一行目 二行目' })
    expect(parseQuestionSource({ noteId: 'node:a', canvasId: 'canvas:b' })!.label).toBe('（質問）')
    expect(Array.from(parseQuestionSource({ noteId: 'node:a', canvasId: 'canvas:b', label: 'あ'.repeat(100) })!.label)).toHaveLength(60)
  })

  it('rejects broken ids', () => {
    expect(() => parseQuestionSource({ noteId: 'canvas:a', canvasId: 'canvas:b' })).toThrow(expect.objectContaining({ status: 400 }))
    expect(() => parseQuestionSource({ noteId: 'node:a', canvasId: 'node:b' })).toThrow(expect.objectContaining({ status: 400 }))
    expect(() => parseQuestionSource('node:a')).toThrow(expect.objectContaining({ status: 400 }))
  })
})

// 答えを書く仕組みと、動いている質問の API を立てる
async function start(questions: RunningQuestions | null, run?: OnceQuery): Promise<string> {
  const writer = run ? new AnswerWriter({ once: new ClaudeOnce({ run }) }) : null
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://x').pathname
    if (handleAnswer(req, res, path, writer, questions)) return
    if (handleQuestions(req, res, path, questions)) return
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => {
    server.closeAllConnections()
    return new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const json = (url: string, body: unknown, type = 'application/json') => fetch(url, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) })

describe('POST /api/claude/questions/<id>/…', () => {
  it('cancel answers 204, or 404 when the question is gone', async () => {
    const questions = new RunningQuestions()
    const base = await start(questions)
    const abort = vi.fn()
    const id = questions.start(source, {}, abort)
    expect((await fetch(`${base}/api/claude/questions/${id}/cancel`, { method: 'POST' })).status).toBe(204)
    expect(abort).toHaveBeenCalledOnce()
    questions.end(id, 'cancelled')
    expect((await fetch(`${base}/api/claude/questions/${id}/cancel`, { method: 'POST' })).status).toBe(404)
  })

  it('finish ends the question with the status the screen sends; only as JSON, and 404 when gone', async () => {
    const questions = new RunningQuestions()
    const changes = watch(questions)
    const base = await start(questions)
    const id = questions.start(source, {}, () => {})
    questions.placing(id)
    const url = `${base}/api/claude/questions/${id}/finish`
    expect((await json(url, { status: 'done' }, 'text/plain')).status).toBe(415)
    expect((await json(url, { status: 'maybe' })).status).toBe(400)
    expect((await json(url, { status: 'failed', error: '付箋が見えなくなった' })).status).toBe(204)
    expect(changes.at(-1)).toEqual({ type: 'question-done', id, status: 'failed', error: '付箋が見えなくなった' })
    expect((await json(url, { status: 'done' })).status).toBe(404)
  })

  it('takes only POST, and leaves other paths alone', async () => {
    const base = await start(new RunningQuestions())
    expect((await fetch(`${base}/api/claude/questions/00000000-0000-0000-0000-000000000000/cancel`)).status).toBe(405)
    expect((await fetch(`${base}/api/claude/questions/x/cancel`, { method: 'POST' })).status).toBe(404)
    const off = await start(null)
    expect((await fetch(`${off}/api/claude/questions/00000000-0000-0000-0000-000000000000/cancel`, { method: 'POST' })).status).toBe(404)
  })
})

describe('the answer stream and the running questions', () => {
  // 考えている中身を流し、gate が開くまで待ってから答える偽の query（止められたら、そこで終わる）
  function gated(gate: Promise<void>): OnceQuery {
    return (params) =>
      (async function* () {
        yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '考える。' } } } as unknown as SDKMessage
        await Promise.race([gate, new Promise((resolve) => params.options.abortController!.signal.addEventListener('abort', resolve))])
        if (params.options.abortController!.signal.aborted) throw new Error('aborted')
        yield { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } } as unknown as SDKMessage
        const answer = { body: '答え', related: [] }
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 's',
          total_cost_usd: 0,
          duration_ms: 1,
          num_turns: 1,
          result: JSON.stringify(answer),
          structured_output: answer,
          modelUsage: { 'claude-opus-5-5': {} },
        } as unknown as SDKMessage
      })()
  }

  const ask = (base: string, body: unknown, signal?: AbortSignal) =>
    fetch(`${base}/api/claude/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })

  async function lines(response: Response): Promise<Record<string, unknown>[]> {
    return (await response.text())
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  it('lists the question with its source, gives its id first, passes the steps and the thinking, and waits for the screen to place it', async () => {
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => (open = resolve))
    const questions = new RunningQuestions()
    const changes = watch(questions)
    const base = await start(questions, gated(gate))
    const response = ask(base, { question: 'q', source, model: 'opus', effort: 'high' })
    await vi.waitFor(() => expect(questions.list()[0]?.thinking).toBe('考える。'))
    expect(questions.list()[0]).toMatchObject({ ...source, model: 'opus', effort: 'high', status: 'running', step: 'read' })
    open()
    const messages = await lines(await response)
    const id = questions.list()[0]!.id
    expect(messages[0]).toEqual({ type: 'start', id })
    expect(messages.at(-1)).toMatchObject({ type: 'answer', answer: { body: '答え' } })
    // 答えを渡したら、画面が付箋に書くのを待つ（実際に答えたモデルにする）
    expect(questions.list()[0]).toMatchObject({ status: 'placing', step: 'write', model: 'claude-opus-5-5' })
    expect(changes.filter((change) => change.type === 'question').map((change) => (change as { question: { status: string; step: string } }).question)).toEqual([
      expect.objectContaining({ status: 'running', step: 'read' }),
      expect.objectContaining({ status: 'running', step: 'write' }),
      expect.objectContaining({ status: 'placing', step: 'write' }),
    ])
    expect((await json(`${base}/api/claude/questions/${id}/finish`, { status: 'done' })).status).toBe(204)
    expect(questions.list()).toEqual([])
  })

  it('another tab can stop it: Claude stops, the asking screen gets a 499 line, and it ends as cancelled', async () => {
    const questions = new RunningQuestions()
    const changes = watch(questions)
    const base = await start(questions, gated(new Promise(() => {})))
    const response = ask(base, { question: 'q', source })
    await vi.waitFor(() => expect(questions.list()).toHaveLength(1))
    const id = questions.list()[0]!.id
    expect((await fetch(`${base}/api/claude/questions/${id}/cancel`, { method: 'POST' })).status).toBe(204)
    expect((await lines(await response)).at(-1)).toMatchObject({ type: 'error', status: 499 })
    expect(questions.list()).toEqual([])
    expect(changes.at(-1)).toEqual({ type: 'question-done', id, status: 'cancelled' })
  })

  it('ends it as cancelled when the asking screen goes away before the answer', async () => {
    const questions = new RunningQuestions()
    const changes = watch(questions)
    const base = await start(questions, gated(new Promise(() => {})))
    const controller = new AbortController()
    const response = ask(base, { question: 'q', source }, controller.signal)
    await vi.waitFor(() => expect(questions.list()).toHaveLength(1))
    const id = questions.list()[0]!.id
    controller.abort()
    await response.catch(() => undefined)
    await vi.waitFor(() => expect(questions.list()).toEqual([]))
    expect(changes.at(-1)).toEqual({ type: 'question-done', id, status: 'cancelled' })
  })

  it('does not list a question asked without a source, or as plain JSON', async () => {
    const questions = new RunningQuestions()
    const changes = watch(questions)
    let open: () => void = () => {}
    const base = await start(questions, gated(new Promise<void>((resolve) => (open = resolve))))
    open()
    const messages = await lines(await ask(base, { question: 'q' }))
    expect(messages.some((message) => message.type === 'start')).toBe(false)
    await json(`${base}/api/claude/answer`, { question: 'q', source })
    expect(changes).toEqual([])
  })
})
