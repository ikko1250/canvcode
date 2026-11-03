import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyStreamMessage,
  ClaudeClient,
  jobsOfThread,
  threadAsking,
  threadBusy,
  type ClaudeJob,
  type ClaudeState,
  type PendingPermission,
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
const state = (extra: Partial<ClaudeState> = {}): ClaudeState => ({ availability: 'on', threads: [], jobs: new Map(), loaded: new Set(), ...extra })

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
})
