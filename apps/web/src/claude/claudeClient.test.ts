import { describe, expect, it } from 'vitest'
import { applyStreamMessage, jobsOfThread, type ClaudeJob, type ClaudeState, type ThreadSummary } from './claudeClient.ts'

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
