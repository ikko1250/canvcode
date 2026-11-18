import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyStreamMessage,
  ClaudeClient,
  KEPT_FINISHED_QUESTIONS,
  jobsOfThread,
  threadAsking,
  threadBusy,
  type ClaudeJob,
  type ClaudeState,
  type PendingPermission,
  type RunningQuestion,
  type ThreadSummary,
} from './claudeClient.ts'

// Claude の会話の状態に、SSE のメッセージを当てる

const job = (id: string, extra: Partial<ClaudeJob> = {}): ClaudeJob => ({
  id,
  threadId: id,
  prompt: id,
  status: 'running',
  createdAt: 0,
  eventCount: 0,
  events: [],
  ...extra,
})
const thread = (threadId: string, updatedAt: number, extra: Partial<ThreadSummary> = {}): ThreadSummary => ({
  threadId,
  title: threadId,
  createdAt: 0,
  updatedAt,
  jobCount: 1,
  running: false,
  ...extra,
})
const summary = ({ events: _events, ...rest }: ClaudeJob) => rest
const state = (extra: Partial<ClaudeState> = {}): ClaudeState => ({
  availability: 'on',
  threads: [],
  jobs: new Map(),
  loaded: new Set(),
  questions: [],
  finishedQuestions: new Map(),
  ...extra,
})
const question = (id: string, extra: Partial<RunningQuestion> = {}): RunningQuestion => ({
  id,
  noteId: `node:${id}`,
  canvasId: 'canvas:c',
  label: id,
  status: 'running',
  step: 'read',
  searched: false,
  thinking: '',
  startedAt: 0,
  ...extra,
})

describe('running questions', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('takes them from the snapshot, adds and updates them, keeping the thinking', () => {
    let { state: s } = applyStreamMessage(state(), { type: 'snapshot', threads: [], running: [], questions: [question('a', { thinking: 'まず' })] })
    expect(s.questions).toEqual([question('a', { thinking: 'まず' })])
    ;({ state: s } = applyStreamMessage(s, { type: 'question-thinking', id: 'a', text: '考える' }))
    const { thinking: _thinking, ...searching } = question('a', { step: 'search' })
    ;({ state: s } = applyStreamMessage(s, { type: 'question', question: searching }))
    expect(s.questions).toEqual([question('a', { step: 'search', thinking: 'まず考える' })])
    const { thinking: _new, ...fresh } = question('b')
    ;({ state: s } = applyStreamMessage(s, { type: 'question', question: fresh }))
    expect(s.questions.map((q) => q.id)).toEqual(['a', 'b'])
    // 前のサーバーの snapshot（questions がない）なら空
    expect(applyStreamMessage(s, { type: 'snapshot', threads: [], running: [] }).state.questions).toEqual([])
  })

  it('drops a finished one and remembers how it ended, newest first, up to KEPT_FINISHED_QUESTIONS', () => {
    let s = state({ questions: [question('a'), question('b')] })
    ;({ state: s } = applyStreamMessage(s, { type: 'question-done', id: 'a', status: 'cancelled' }))
    expect(s.questions.map((q) => q.id)).toEqual(['b'])
    expect(s.finishedQuestions.get('a')).toBe('cancelled')
    for (let i = 0; i < KEPT_FINISHED_QUESTIONS; i++) ({ state: s } = applyStreamMessage(s, { type: 'question-done', id: `x${i}`, status: 'done' }))
    expect(s.finishedQuestions.size).toBe(KEPT_FINISHED_QUESTIONS)
    expect(s.finishedQuestions.has('a')).toBe(false)
    expect([...s.finishedQuestions.keys()][0]).toBe(`x${KEPT_FINISHED_QUESTIONS - 1}`)
  })

  it('cancels and finishes through the server', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    const client = Object.create(ClaudeClient.prototype) as ClaudeClient
    await client.cancelQuestion('q1')
    await client.finishQuestion('q1', 'failed', '見えない')
    expect(fetch.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['/api/claude/questions/q1/cancel', '/api/claude/questions/q1/finish'])
    const init = (fetch.mock.calls[1] as unknown[])[1] as RequestInit
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual({ status: 'failed', error: '見えない' })
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'だめ' }), { status: 500 }))
    await expect(client.cancelQuestion('q1')).rejects.toThrow('だめ')
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }))
    await expect(client.cancelQuestion('q1')).resolves.toBeUndefined()
  })
})

describe('applyStreamMessage', () => {
  it('replaces the threads and the running jobs with a snapshot, and forgets what was loaded', () => {
    const before = state({ jobs: new Map([['old', job('old')]]), loaded: new Set(['old']) })
    const { state: after } = applyStreamMessage(before, { type: 'snapshot', threads: [thread('a', 1)], running: [job('a')] })
    expect(after.threads.map((t) => t.threadId)).toEqual(['a'])
    expect([...after.jobs.keys()]).toEqual(['a'])
    expect(after.loaded.size).toBe(0)
  })

  it('appends new events from their position, without doubling ones it already has, and moves the thread to the top', () => {
    const a = job('a', { events: [{ kind: 'text', text: '1' }] })
    let { state: s } = applyStreamMessage(state({ threads: [thread('b', 5), thread('a', 1)], jobs: new Map([['a', a]]) }), {
      type: 'job',
      job: summary(a),
      events: [{ kind: 'text', text: '2' }],
      from: 1,
      thread: thread('a', 9, { running: true }),
    })
    expect(s.jobs.get('a')!.events).toEqual([
      { kind: 'text', text: '1' },
      { kind: 'text', text: '2' },
    ])
    expect(s.threads.map((t) => [t.threadId, t.running])).toEqual([
      ['a', true],
      ['b', false],
    ])
    // 先に応答で入れたジョブに、同じ出来事がもう一度届いても重ならない
    ;({ state: s } = applyStreamMessage(s, { type: 'job', job: { ...summary(a), status: 'done' }, events: [{ kind: 'text', text: '2' }], from: 1, thread: thread('a', 10) }))
    expect(s.jobs.get('a')!.events).toHaveLength(2)
    expect(s.jobs.get('a')!.status).toBe('done')
  })

  it('reports a job whose earlier events it missed', () => {
    const { state: s, missing } = applyStreamMessage(state(), { type: 'job', job: summary(job('a')), events: [{ kind: 'text', text: '3' }], from: 2, thread: thread('a', 1) })
    expect(missing).toBe('a')
    expect(s.jobs.get('a')!.events).toEqual([])
  })

  it('replaces a thread whose background tasks changed, keeping its jobs', () => {
    const before = state({ threads: [thread('a', 1), thread('b', 2)], jobs: new Map([['a', job('a')]]) })
    const tasks = [{ id: 'ag1', description: '論文を探す', type: 'local_agent' }]
    const { state: s } = applyStreamMessage(before, { type: 'thread', thread: thread('a', 3, { tasks }) })
    expect(s.threads.map((t) => [t.threadId, t.tasks])).toEqual([
      ['a', tasks],
      ['b', undefined],
    ])
    expect(s.jobs).toBe(before.jobs)
  })

  it('removes a deleted thread and its jobs', () => {
    const before = state({ threads: [thread('a', 1), thread('b', 2)], jobs: new Map([['a', job('a')], ['b', job('b')]]), loaded: new Set(['a']) })
    const { state: s } = applyStreamMessage(before, { type: 'thread-deleted', threadId: 'a' })
    expect(s.threads.map((t) => t.threadId)).toEqual(['b'])
    expect([...s.jobs.keys()]).toEqual(['b'])
    expect(s.loaded.has('a')).toBe(false)
  })
})

describe('jobsOfThread', () => {
  it('returns the jobs of a thread, oldest first', () => {
    const s = state({ jobs: new Map([['b2', job('b2', { threadId: 'b', createdAt: 4 })], ['a', job('a', { createdAt: 1 })], ['b', job('b', { createdAt: 2 })]]) })
    expect(jobsOfThread(s, 'b').map((j) => j.id)).toEqual(['b', 'b2'])
  })
})

const permission: PendingPermission = { id: 'p1', jobId: 'a', name: 'Bash', detail: 'rm -rf build', createdAt: 0, expiresAt: 600_000 }

describe('threadBusy', () => {
  it('is busy while a job runs, a background task is left, or a question waits for an answer', () => {
    expect(threadBusy(thread('a', 1))).toBe(false)
    expect(threadBusy(thread('a', 1, { tasks: [] }))).toBe(false)
    expect(threadBusy(thread('a', 1, { running: true }))).toBe(true)
    expect(threadBusy(thread('a', 1, { tasks: [{ id: 'x', description: 'x', type: 'local_bash' }] }))).toBe(true)
    expect(threadBusy(thread('a', 1, { permissions: [permission] }))).toBe(true)
  })
})

describe('questions waiting for an answer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('replaces the questions of a thread when it changes, and tells which threads are asking', () => {
    const before = state({ threads: [thread('a', 1, { permissions: [permission] })] })
    expect(threadAsking(before.threads[0]!)).toBe(true)
    const { state: s } = applyStreamMessage(before, { type: 'thread', thread: thread('a', 2, { permissions: [] }) })
    expect(s.threads[0]!.permissions).toEqual([])
    expect(threadAsking(s.threads[0]!)).toBe(false)
    expect(threadAsking(thread('b', 1))).toBe(false)
  })

  it('answers with a JSON POST (the server takes only JSON), and throws the error of the server', async () => {
    const calls: [string, RequestInit | undefined][] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push([url, init])
        // 使えるかの確かめ（GET /api/claude/threads）は切ってあることにする（SSE をつながない）
        if (!init) return new Response('{}', { status: 404 })
        if (url.endsWith('/p2')) return new Response(JSON.stringify({ error: 'その問い合わせはもうありません' }), { status: 404 })
        return new Response(null, { status: 204 })
      }),
    )
    const client = new ClaudeClient()
    await client.answerPermission('t1', 'p1', 'allow')
    const [url, init] = calls.at(-1)!
    expect(url).toBe('/api/claude/threads/t1/permissions/p1')
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"decision":"allow"}' })
    await expect(client.answerPermission('t1', 'p2', 'deny')).rejects.toThrow('その問い合わせはもうありません')
    client.dispose()
  })

  it('reads the models again after a while when the server could not ask Claude Code for them (MAI-106)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      let catalog = { models: [{ value: 'opus', label: 'Opus', efforts: [] }], default: {}, fromClaude: false }
      let reads = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.endsWith('/models')) {
            reads++
            return new Response(JSON.stringify(catalog))
          }
          return new Response(JSON.stringify({ threads: [] }))
        }),
      )
      vi.stubGlobal('EventSource', class { close() {} })
      const client = new ClaudeClient()
      await vi.waitFor(() => expect(client.state.availability).toBe('on'))
      await client.loadModels()
      await client.loadModels()
      expect(reads).toBe(1)
      expect(client.state.models?.fromClaude).toBe(false)
      // 1 分たてば読み直す。Claude Code に聞けた一覧は、もう読み直さない
      catalog = { ...catalog, fromClaude: true }
      vi.setSystemTime(Date.now() + 60_000)
      await client.loadModels()
      expect(reads).toBe(2)
      expect(client.state.models?.fromClaude).toBe(true)
      vi.setSystemTime(Date.now() + 120_000)
      await client.loadModels()
      expect(reads).toBe(2)
      client.dispose()
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})
