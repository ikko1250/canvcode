import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeStore } from './store.ts'

// Claude の会話の保存（.canvcode/claude.db）

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-claude-store-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function open(dir: string): ClaudeStore {
  const store = new ClaudeStore(dir)
  cleanups.push(() => store.close())
  return store
}

const job = (id: string, threadId: string, createdAt: number, extra: Record<string, unknown> = {}) => ({
  id,
  threadId,
  prompt: `prompt ${id}`,
  status: 'done' as const,
  createdAt,
  eventCount: 0,
  events: [],
  ...extra,
})

describe('ClaudeStore', () => {
  it('saves jobs, events and sessions, and reads them back after reopening', () => {
    const dir = dataDir()
    const store = new ClaudeStore(dir)
    store.insertJob(job('a', 'a', 1, { status: 'running', refId: 'ref:Ab12Cd34Ef', canvasId: 'canvas:x' }))
    store.appendEvent('a', 0, { kind: 'text', text: 'はい' })
    store.appendEvent('a', 1, { kind: 'tool', name: 'Bash', detail: 'ls' })
    store.setSession('a', 's1')
    store.finishJob({ id: 'a', status: 'done', finishedAt: 5, costUsd: 0.02, durationMs: 4 })
    store.close()

    const reopened = open(dir)
    expect(reopened.job('a')).toEqual({
      id: 'a',
      threadId: 'a',
      prompt: 'prompt a',
      refId: 'ref:Ab12Cd34Ef',
      canvasId: 'canvas:x',
      status: 'done',
      createdAt: 1,
      finishedAt: 5,
      costUsd: 0.02,
      durationMs: 4,
      sessionId: 's1',
      eventCount: 2,
      events: [
        { kind: 'text', text: 'はい' },
        { kind: 'tool', name: 'Bash', detail: 'ls' },
      ],
    })
  })

  it('lists threads by their last activity, titled by their first prompt', () => {
    const store = open(dataDir())
    store.insertJob(job('a', 'a', 1, { finishedAt: 2 }))
    store.insertJob(job('b', 'b', 3, { finishedAt: 4 }))
    store.insertJob(job('a2', 'a', 5, { status: 'running' }))
    expect(store.threads()).toEqual([
      { threadId: 'a', title: 'prompt a', createdAt: 1, updatedAt: 5, jobCount: 2, running: true },
      { threadId: 'b', title: 'prompt b', createdAt: 3, updatedAt: 4, jobCount: 1, running: false },
    ])
    expect(store.lastOfThread('a')?.id).toBe('a2')
    expect(store.threadJobs('a').map((j) => j.id)).toEqual(['a', 'a2'])
  })

  it('deletes a thread with its events and returns its sessions', () => {
    const store = open(dataDir())
    store.insertJob(job('a', 'a', 1, { sessionId: 's1', events: [{ kind: 'text', text: 'x' }] }))
    store.insertJob(job('a2', 'a', 2, { sessionId: 's1' }))
    store.insertJob(job('b', 'b', 3))
    expect(store.deleteThread('a')).toEqual(['s1'])
    expect(store.threads().map((t) => t.threadId)).toEqual(['b'])
    expect(store.job('a')).toBeUndefined()
  })

  it('moves a broken database aside and starts over', () => {
    const dir = dataDir()
    writeFileSync(join(dir, 'claude.db'), 'not a database'.repeat(100))
    const store = open(dir)
    expect(store.threads()).toEqual([])
    expect(readdirSync(dir).some((name) => name.startsWith('claude.db.broken-'))).toBe(true)
    expect(existsSync(join(dir, 'claude.db'))).toBe(true)
  })
})
