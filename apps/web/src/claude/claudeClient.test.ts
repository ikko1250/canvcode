import { describe, expect, it } from 'vitest'
import { applyStreamMessage, threadsOf, type ClaudeJob } from './claudeClient.ts'

// Claude のジョブの表に、SSE のメッセージを当てる

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
const summary = ({ events: _events, ...rest }: ClaudeJob) => rest

describe('applyStreamMessage', () => {
  it('replaces everything with a snapshot', () => {
    const { jobs } = applyStreamMessage(new Map([['old', job('old')]]), { type: 'snapshot', jobs: [job('a')] })
    expect([...jobs.keys()]).toEqual(['a'])
  })

  it('appends new events from their position, without doubling ones it already has', () => {
    const a = job('a', { events: [{ kind: 'text', text: '1' }] })
    let { jobs } = applyStreamMessage(new Map([['a', a]]), { type: 'job', job: summary(a), events: [{ kind: 'text', text: '2' }], from: 1 })
    expect(jobs.get('a')!.events).toEqual([
      { kind: 'text', text: '1' },
      { kind: 'text', text: '2' },
    ])
    // 先に応答で入れたジョブに、同じ出来事がもう一度届いても重ならない
    ;({ jobs } = applyStreamMessage(jobs, { type: 'job', job: { ...summary(a), status: 'done' }, events: [{ kind: 'text', text: '2' }], from: 1 }))
    expect(jobs.get('a')!.events).toHaveLength(2)
    expect(jobs.get('a')!.status).toBe('done')
  })

  it('reports a job whose earlier events it missed', () => {
    const { jobs, missing } = applyStreamMessage(new Map(), { type: 'job', job: summary(job('a')), events: [{ kind: 'text', text: '3' }], from: 2 })
    expect(missing).toBe('a')
    expect(jobs.get('a')!.events).toEqual([])
  })
})

describe('threadsOf', () => {
  it('groups jobs by thread, oldest first, with the latest thread first', () => {
    const threads = threadsOf([
      job('b2', { threadId: 'b', createdAt: 4 }),
      job('a', { createdAt: 1 }),
      job('b', { createdAt: 2 }),
      job('c', { createdAt: 3 }),
    ])
    expect(threads.map((t) => [t.threadId, t.jobs.map((j) => j.id)])).toEqual([
      ['b', ['b', 'b2']],
      ['c', ['c']],
      ['a', ['a']],
    ])
  })
})
