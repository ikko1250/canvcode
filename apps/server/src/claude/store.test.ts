import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
  it('makes a thread of questions only, and gives a thread with jobs the first question and the last time of its questions (docs/ai-note-tasks-plan.md の 10)', () => {
    const store = open(dataDir())
    const question = (id: string, threadId: string, createdAt: number, extra: Record<string, unknown> = {}) => ({
      id,
      threadId,
      question: `質問 ${id}`,
      previous: [],
      status: 'done' as const,
      createdAt,
      answeredAt: createdAt + 1,
      ...extra,
    })
    // モデルは最後の質問のもの
    store.insertQuestion(question('q1', 'only', 5, { model: 'haiku' }))
    store.insertQuestion(question('q2', 'only', 7, { status: 'running', answeredAt: undefined, model: 'opus' }))
    store.insertJob(job('chat', 'chat', 3))
    expect(store.thread('only')).toMatchObject({ threadId: 'only', title: '質問 q1', createdAt: 5, updatedAt: 7, jobCount: 0, running: true, model: 'opus' })
    expect(store.threads().map((thread) => thread.threadId)).toEqual(['only', 'chat'])
    // 質問だけの会話で頼むと、ジョブのある会話になる。題は最初の質問のまま、最後に動いた時刻は遅い方
    store.insertJob(job('j', 'only', 10))
    expect(store.thread('only')).toMatchObject({ title: '質問 q1', createdAt: 5, updatedAt: 10, jobCount: 1 })
    // ジョブのある会話のあとで聞いた質問の時刻も、一覧の順に効く
    store.insertQuestion(question('q3', 'chat', 20))
    expect(store.threads().map((thread) => thread.threadId)).toEqual(['chat', 'only'])
    expect(store.thread('chat')).toMatchObject({ title: 'prompt chat', updatedAt: 21 })
  })

  it('keeps the note of a note task, and leaves threads with only note tasks out of the list (docs/ai-note-tasks-plan.md)', () => {
    const store = open(dataDir())
    const note = { noteId: 'node:n', canvasId: 'canvas:c' }
    store.insertJob(job('chat', 'chat', 1))
    store.insertJob(job('task', 'task', 2, { note }))
    store.insertJob(job('task-bg', 'task', 3, { note, origin: 'background' }))
    expect(store.job('task')).toMatchObject({ note })
    expect(store.job('chat')!.note).toBeUndefined()
    expect(store.threads().map((thread) => thread.threadId)).toEqual(['chat'])
    // どの会話も、id を指せば読める（付箋の「チャットで続ける」）
    expect(store.thread('task')).toMatchObject({ threadId: 'task', note, noteOnly: true, jobCount: 2 })
    // 会話から 1 つでも頼んだら、一覧に出る
    store.insertJob(job('follow', 'task', 4))
    expect(store.threads().map((thread) => thread.threadId)).toEqual(['task', 'chat'])
    expect(store.thread('task')).toMatchObject({ note })
    expect(store.thread('task')!.noteOnly).toBeUndefined()
  })

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

  it('adds the origin column to a database made before it, keeping its jobs', () => {
    const dir = dataDir()
    // origin のない、前のサーバーの claude.db
    const old = new DatabaseSync(join(dir, 'claude.db'))
    old.exec(`
      CREATE TABLE jobs (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, prompt TEXT NOT NULL, ref_id TEXT, canvas_id TEXT, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, finished_at INTEGER, cost_usd REAL, duration_ms INTEGER, session_id TEXT, event_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE events (job_id TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (job_id, seq));
      INSERT INTO jobs (id, thread_id, prompt, status, created_at, event_count) VALUES ('a', 'a', 'old', 'done', 1, 0);
      PRAGMA user_version = 1;
    `)
    old.close()
    let store = new ClaudeStore(dir)
    expect(store.job('a')).toMatchObject({ prompt: 'old', status: 'done' })
    expect(store.job('a')!.origin).toBeUndefined()
    store.insertJob(job('b', 'a', 2, { origin: 'background' }))
    store.close()
    // 開き直しても、もう一度足そうとしない
    store = open(dir)
    expect(store.threadJobs('a').map((j) => [j.id, j.origin])).toEqual([
      ['a', undefined],
      ['b', 'background'],
    ])
    expect(readdirSync(dir).some((name) => name.startsWith('claude.db.broken-'))).toBe(false)
  })

  it('adds the model and effort columns, and lists a thread with those of its last request, not of a background turn (MAI-106)', () => {
    const dir = dataDir()
    // origin はあるが model・effort のない claude.db
    const old = new DatabaseSync(join(dir, 'claude.db'))
    old.exec(`
      CREATE TABLE jobs (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, prompt TEXT NOT NULL, origin TEXT, ref_id TEXT, canvas_id TEXT, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, finished_at INTEGER, cost_usd REAL, duration_ms INTEGER, session_id TEXT, event_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE events (job_id TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (job_id, seq));
      INSERT INTO jobs (id, thread_id, prompt, status, created_at, event_count) VALUES ('a', 'a', 'old', 'done', 1, 0);
      PRAGMA user_version = 1;
    `)
    old.close()
    let store = new ClaudeStore(dir)
    expect(store.thread('a')).not.toHaveProperty('model')
    expect(store.job('a')).not.toHaveProperty('model')
    store.insertJob(job('b', 'a', 2, { model: 'opus', effort: 'high' }))
    // バックグラウンドのターンは、会話の値にしない
    store.insertJob(job('c', 'a', 3, { origin: 'background', model: 'haiku', effort: 'low' }))
    store.close()
    store = open(dir)
    expect(store.thread('a')).toMatchObject({ model: 'opus', effort: 'high', jobCount: 3 })
    expect(store.threads()[0]).toMatchObject({ threadId: 'a', model: 'opus', effort: 'high' })
    expect(store.job('c')).toMatchObject({ model: 'haiku', effort: 'low' })
    // 既定（model なし）で頼んだら、会話の値も既定
    store.insertJob(job('d', 'a', 4))
    expect(store.thread('a')).not.toHaveProperty('model')
    expect(store.thread('a')).not.toHaveProperty('effort')
  })

  it('adds the ref_label and imports columns and the questions table to an older database, keeping its jobs (claude-chat-tab-plan 8)', () => {
    const dir = dataDir()
    // model・effort まではあるが、ref_label・imports の列と questions の表のない claude.db
    const old = new DatabaseSync(join(dir, 'claude.db'))
    old.exec(`
      CREATE TABLE jobs (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, prompt TEXT NOT NULL, origin TEXT, ref_id TEXT, canvas_id TEXT, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, finished_at INTEGER, cost_usd REAL, duration_ms INTEGER, session_id TEXT, event_count INTEGER NOT NULL DEFAULT 0, model TEXT, effort TEXT);
      CREATE TABLE events (job_id TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (job_id, seq));
      INSERT INTO jobs (id, thread_id, prompt, ref_id, status, created_at, event_count) VALUES ('a', 'a', 'old', 'ref:Ab12Cd34Ef', 'done', 1, 0);
      PRAGMA user_version = 1;
    `)
    old.close()
    let store = new ClaudeStore(dir)
    expect(store.job('a')).toMatchObject({ prompt: 'old', refId: 'ref:Ab12Cd34Ef' })
    expect(store.job('a')).not.toHaveProperty('refLabel')
    expect(store.job('a')).not.toHaveProperty('imports')
    const imports = [{ label: '質問', question: '質問', answer: '答え', noteId: 'node:n', canvasId: 'canvas:c' }]
    store.insertJob(job('b', 'a', 2, { refId: 'ref:Ab12Cd34Ef', refLabel: '3 個のノード', imports }))
    store.close()
    store = open(dir)
    expect(store.job('b')).toMatchObject({ refLabel: '3 個のノード', imports })
    expect(store.threadQuestions('a')).toEqual([])
    // 版は上げない（古いサーバーが壊れたものとして脇に移さないように）
    store.close()
    const raw = new DatabaseSync(join(dir, 'claude.db'))
    expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1)
    raw.close()
    expect(readdirSync(dir).some((name) => name.startsWith('claude.db.broken-'))).toBe(false)
  })

  it('keeps the questions asked from the chat, lists the answered ones, and deletes them with their thread (claude-chat-tab-plan 7)', () => {
    const dir = dataDir()
    let store = new ClaudeStore(dir)
    store.insertJob(job('t', 't', 1))
    const previous = [{ question: '前の質問', answer: '前の答え' }]
    store.insertQuestion({ id: 'q1', threadId: 't', question: 'コンテキストとは？', previous, model: 'sonnet', effort: 'medium', status: 'running', createdAt: 2 })
    store.insertQuestion({ id: 'q2', question: '会話の外', previous: [], status: 'running', createdAt: 3 })
    store.insertQuestion({ id: 'q3', threadId: 't', question: '止めた', previous: [], status: 'running', createdAt: 4 })
    expect(store.question('q1')).toEqual({ id: 'q1', threadId: 't', question: 'コンテキストとは？', previous, model: 'sonnet', effort: 'medium', status: 'running', createdAt: 2 })
    store.finishQuestion('q1', { status: 'done', body: '答え', model: 'claude-sonnet-5-5', answeredAt: 5 })
    store.finishQuestion('q2', { status: 'done', body: '外の答え', answeredAt: 6 })
    store.finishQuestion('q3', { status: 'cancelled', answeredAt: 7 })
    expect(store.question('q1')).toMatchObject({ status: 'done', body: '答え', model: 'claude-sonnet-5-5', answeredAt: 5 })
    expect(store.threadQuestions('t').map((q) => [q.id, q.status])).toEqual([
      ['q1', 'done'],
      ['q3', 'cancelled'],
    ])
    // 答えたものだけ、答えた時刻の新しいものから
    expect(store.answeredQuestions().map((q) => q.id)).toEqual(['q2', 'q1'])
    // 答えを作っていることになっているものは、開き直すと（サーバーが止まって途切れた）失敗にする
    store.insertQuestion({ id: 'q4', threadId: 't', question: '途中', previous: [], status: 'running', createdAt: 8 })
    store.interruptRunning('途切れました', 9)
    expect(store.question('q4')).toMatchObject({ status: 'failed', error: '途切れました', answeredAt: 9 })
    store.close()
    store = open(dir)
    // 会話を消すと、その会話の質問も消える（会話の外のものは残る）
    store.deleteThread('t')
    expect(store.question('q1')).toBeUndefined()
    expect(store.threadQuestions('t')).toEqual([])
    expect(store.question('q2')).toMatchObject({ body: '外の答え' })
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
