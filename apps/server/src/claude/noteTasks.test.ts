import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentHost } from '../agent/host.ts'
import { editCanvas } from '../agent/ops.ts'
import { RecordStore } from '../records.ts'
import { SyncHub } from '../sync.ts'
import type { ClaudeJobs, Job, JobEvent, JobListener, StartRequest } from './jobs.ts'
import { finalText, handleNoteTasks, NoteTasks, parseNoteTaskRequest, UndoFailed, type NoteTaskReport } from './noteTasks.ts'

// 付箋の作業（AI 付箋の文を指示にして、会話と同じジョブで動かす）。ジョブは偽物、付箋と Canvas の編集は本物の RecordStore と AgentHost

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// ClaudeJobs の代わり：start で動いているジョブを作り、end で終わらせて知らせる
function fakeJobs() {
  const listeners = new Set<JobListener>()
  const jobs = new Map<string, Job>()
  const started: StartRequest[] = []
  const api = {
    started,
    subscribe(listener: JobListener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start(request: StartRequest): Job {
      started.push(request)
      const id = randomUUID()
      const job: Job = {
        id,
        threadId: id,
        prompt: request.prompt,
        status: 'running',
        createdAt: 10,
        eventCount: 0,
        events: [],
        ...(request.note ? { note: request.note } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
      }
      jobs.set(id, job)
      return { ...job }
    },
    get(id: string): Job | undefined {
      return jobs.get(id)
    },
    thread(threadId: string) {
      const list = [...jobs.values()].filter((job) => job.threadId === threadId)
      return list.length > 0 ? { thread: {} as never, jobs: list, questions: [] } : undefined
    },
    // 終わらせて知らせる（終わったときの知らせは、足した出来事がない）
    end(id: string, events: JobEvent[], status: Job['status'] = 'done') {
      const job = jobs.get(id)!
      job.events = events
      job.eventCount = events.length
      job.status = status
      job.finishedAt = 20
      for (const listener of listeners) listener({ type: 'job', job, events: [], from: events.length, thread: {} as never })
    },
    // ほかの出来事の知らせ（終わったあとに足したもの）
    append(id: string, event: JobEvent) {
      const job = jobs.get(id)!
      job.events.push(event)
      for (const listener of listeners) listener({ type: 'job', job, events: [event], from: job.events.length - 1, thread: {} as never })
    },
    // バックグラウンドのジョブ（同じ会話）を足す
    background(threadId: string, note: Job['note']): string {
      const id = randomUUID()
      jobs.set(id, { id, threadId, prompt: 'バックグラウンドの作業', origin: 'background', status: 'running', createdAt: 30, eventCount: 0, events: [], ...(note ? { note } : {}) })
      return id
    },
  }
  return api
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-note-tasks-'))
  const records = new RecordStore(dir)
  const sync = new SyncHub(records)
  const host = new AgentHost({ records, sync })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.push(() => records.close())
  cleanups.push(() => host.dispose())
  const jobs = fakeJobs()
  const tasks = new NoteTasks({ jobs: jobs as unknown as ClaudeJobs, records, host })
  cleanups.push(() => tasks.dispose())
  const canvasId = records.rootCanvasId
  const made = editCanvas(host, {
    canvasId,
    ops: [
      { op: 'create', type: 'note', as: 'n', text: '表にして', x: 0, y: 0 },
      { op: 'create', type: 'note', as: 'near', text: '近くの付箋', x: 300, y: 0 },
    ],
  })
  const noteId = made.created.n!
  const nearId = made.created.near!
  const ai = () => (records.get(noteId)!.meta as { ai?: { task?: unknown; answer?: NoteTaskReport } }).ai
  return { records, host, jobs, tasks, canvasId, noteId, nearId, ai }
}

describe('NoteTasks', () => {
  it('starts a job for the note, marks the note while it runs, and writes the report when it ends', () => {
    const { host, jobs, tasks, canvasId, noteId, nearId, ai } = setup()
    const { job } = tasks.start({
      noteId,
      canvasId,
      instruction: '表にして',
      refs: [{ label: '2 個のノード', refId: 'ref:AAAAAAAAAA' }],
      candidates: [{ id: nearId, text: '近くの付箋' }],
      model: 'opus',
      effort: 'high',
    })
    const request = jobs.started[0]!
    expect(request).toMatchObject({ prompt: '表にして', canvasId, note: { noteId, canvasId }, model: 'opus', effort: 'high' })
    expect(request.materials).toContain('<canvas-places>\n- 2 個のノード：ref:AAAAAAAAAA\n</canvas-places>')
    expect(request.materials).toContain(`<canvas-candidate id="${nearId}">近くの付箋</canvas-candidate>`)
    expect(request.materials!.trimEnd().endsWith('次が、付箋に書かれた指示です。')).toBe(true)
    expect(ai()!.task).toEqual({ threadId: job.threadId, jobId: job.id, startedAt: 10 })

    // 作業：Canvas を編集し、ファイルを書き、コマンドを動かし、最後に報告する
    editCanvas(host, { canvasId, ops: [{ op: 'create', type: 'geo', x: 0, y: 300, w: 10, h: 10 }], label: '表を置く', threadId: job.threadId })
    jobs.end(job.id, [
      { kind: 'text', text: '作ります。' },
      { kind: 'tool', name: 'mcp__canvcode__edit_canvas', detail: '表を置く' },
      { kind: 'tool', name: 'Write', detail: 'notes/table.md' },
      { kind: 'tool', name: 'Edit', detail: 'notes/table.md' },
      { kind: 'tool', name: 'Bash', detail: 'wc -l notes/table.md' },
      { kind: 'text', text: '表を置きました。' },
      { kind: 'text', text: `\`notes/table.md\` にも書きました。\n\n<canvas-related>${nearId} ${noteId} node:gone</canvas-related>` },
    ])
    expect(ai()!.task).toBeUndefined()
    expect(ai()!.answer).toEqual({
      body: '表を置きました。\n\n`notes/table.md` にも書きました。',
      related: [nearId],
      model: 'opus',
      effort: 'high',
      question: '表にして',
      answeredAt: 20,
      threadId: job.threadId,
      jobId: job.id,
      status: 'done',
      changes: {
        canvas: [{ batch: expect.stringMatching(/^ai-/), label: '表を置く', canvasId }],
        files: ['notes/table.md'],
        commands: ['wc -l notes/table.md'],
      },
    })
  })

  it('writes a failed report with the error when the job stops without a report; ignores events added after it ended', () => {
    const { jobs, tasks, canvasId, noteId, ai } = setup()
    const { job } = tasks.start({ noteId, canvasId, instruction: '表にして' })
    expect(jobs.started[0]!.materials).toBeUndefined()
    jobs.end(job.id, [{ kind: 'error', message: '使用量の上限に達しました' }], 'failed')
    expect(ai()!.answer).toMatchObject({ body: '作業が止まりました：使用量の上限に達しました', status: 'failed', error: '使用量の上限に達しました' })
    const answeredAt = ai()!.answer!.answeredAt
    jobs.append(job.id, { kind: 'error', message: 'あとから' })
    expect(ai()!.answer!.answeredAt).toBe(answeredAt)
    expect(ai()!.answer!.error).toBe('使用量の上限に達しました')
  })

  it('refuses a note that is gone or on another canvas, and a note whose task is still running', () => {
    const { tasks, canvasId, noteId } = setup()
    expect(() => tasks.start({ noteId: 'node:gone', canvasId, instruction: 'x' })).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => tasks.start({ noteId, canvasId: 'canvas:other', instruction: 'x' })).toThrow(expect.objectContaining({ status: 409 }))
    tasks.start({ noteId, canvasId, instruction: 'x' })
    expect(() => tasks.start({ noteId, canvasId, instruction: 'x' })).toThrow(/前の作業が、まだ終わっていません/)
  })

  it('passes the record of the last run when sent again: its instruction, report and the changes still there', () => {
    const { host, jobs, tasks, canvasId, noteId } = setup()
    const first = tasks.start({ noteId, canvasId, instruction: '表にして' }).job
    editCanvas(host, { canvasId, ops: [{ op: 'create', type: 'geo', x: 0, y: 300, w: 10, h: 10 }], label: '表を置く', threadId: first.threadId })
    jobs.end(first.id, [
      { kind: 'tool', name: 'Write', detail: 'notes/table.md' },
      { kind: 'text', text: '表を置きました。' },
    ])
    tasks.start({ noteId, canvasId, instruction: '表にして。列は 3 つ', lastThreadId: first.threadId })
    const materials = jobs.started[1]!.materials!
    expect(materials).toContain('- <canvas-last-run> は、この付箋で前に頼んだ作業の記録です')
    expect(materials).toContain('<canvas-instruction>\n表にして\n</canvas-instruction>')
    expect(materials).toContain('<canvas-report>\n表を置きました。\n</canvas-report>')
    expect(materials).toContain(`キャンバスの変更（今も残っています。古い順）：\n- 表を置く（${canvasId}）`)
    expect(materials).toContain('書いたファイル（今も残っています）：\n- notes/table.md')
  })

  it('undoes the canvas edits of the last run before sending again, and says so; refuses to send when one cannot be undone', () => {
    const { records, host, jobs, tasks, canvasId, noteId, ai } = setup()
    const first = tasks.start({ noteId, canvasId, instruction: '箱を置いて' }).job
    const placed = editCanvas(host, { canvasId, ops: [{ op: 'create', type: 'geo', as: 'box', x: 0, y: 300, w: 10, h: 10 }], label: '箱を置く', threadId: first.threadId })
    jobs.end(first.id, [{ kind: 'tool', name: 'Bash', detail: 'touch x' }, { kind: 'text', text: '置きました。' }])
    const second = tasks.start({ noteId, canvasId, instruction: '丸を置いて', lastThreadId: first.threadId, undo: true })
    expect(second.undone).toEqual([{ batch: placed.batch, label: '箱を置く' }])
    expect(records.get(placed.created.box!)).toBeUndefined()
    const materials = jobs.started[1]!.materials!
    expect(materials).toContain('前の作業のキャンバスの変更は、ユーザーが戻しました')
    expect(materials).not.toContain('<canvas-report>')
    expect(materials).toContain('動かしたコマンド：\n- touch x')

    // 戻せない（そのあとに変わった）なら、送らない
    jobs.end(second.job.id, [{ kind: 'text', text: '丸を置きました。' }])
    const circle = editCanvas(host, { canvasId, ops: [{ op: 'create', type: 'geo', as: 'circle', x: 0, y: 400, w: 10, h: 10 }], label: '丸を置く', threadId: second.job.threadId })
    editCanvas(host, { canvasId, ops: [{ op: 'move', ids: [circle.created.circle!], dx: 5 }], label: '人が動かした' })
    let failure: unknown
    try {
      tasks.start({ noteId, canvasId, instruction: '三角', lastThreadId: second.job.threadId, undo: true })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(UndoFailed)
    expect((failure as UndoFailed).status).toBe(409)
    expect((failure as UndoFailed).summary).toMatchObject({ undone: [], failed: { label: '丸を置く' }, left: [] })
    expect(jobs.started).toHaveLength(2)
    expect(ai()!.answer!.body).toBe('丸を置きました。')
  })

  it('adds what a background job of the same thread wrote later to the report, with the changes so far', () => {
    const { jobs, tasks, canvasId, noteId, ai } = setup()
    const { job } = tasks.start({ noteId, canvasId, instruction: '調べて' })
    jobs.end(job.id, [{ kind: 'text', text: 'バックグラウンドで調べています。' }])
    const later = jobs.background(job.threadId, { noteId, canvasId })
    jobs.end(later, [{ kind: 'tool', name: 'Write', detail: 'notes/result.md' }, { kind: 'text', text: '調べ終えました。' }])
    expect(ai()!.answer!.body).toBe('バックグラウンドで調べています。\n\n### 続き（バックグラウンドの作業のあと）\n\n調べ終えました。')
    expect(ai()!.answer!.changes.files).toEqual(['notes/result.md'])
  })

  it('writes reports for notes left in the middle of a task when the server starts', () => {
    const { records, jobs, tasks, canvasId, noteId, nearId, ai } = setup()
    const { job } = tasks.start({ noteId, canvasId, instruction: '表にして' })
    // サーバーが止まった：ジョブは失敗にされている（ClaudeJobs が起動したときに直す）
    const stored = jobs.get(job.id)!
    stored.status = 'failed'
    stored.events = [{ kind: 'error', message: 'サーバーが止まったので途切れました' }]
    // ジョブの記録がない付箋の作業（claude.db を消した）
    const near = records.get(nearId)!
    records.apply([{ ...near, meta: { ai: { contexts: [], task: { threadId: 'x', jobId: 'gone', startedAt: 1 } } } }], [])
    expect(tasks.recover()).toBe(2)
    expect(ai()!.task).toBeUndefined()
    expect(ai()!.answer).toMatchObject({ status: 'failed', error: 'サーバーが止まったので途切れました' })
    expect((records.get(nearId)!.meta as { ai: Record<string, unknown> }).ai).toEqual({ contexts: [] })
    expect(tasks.recover()).toBe(0)
  })
})

describe('finalText', () => {
  it('reads the text after the last tool call, or all the text when there is none after it', () => {
    expect(finalText([{ kind: 'text', text: '前置き' }, { kind: 'tool', name: 'Bash' }, { kind: 'text', text: ' 報告 ' }, { kind: 'text', text: '続き' }])).toBe('報告\n\n続き')
    expect(finalText([{ kind: 'text', text: '先に書いた' }, { kind: 'tool', name: 'Bash' }])).toBe('先に書いた')
    expect(finalText([])).toBe('')
  })
})

describe('parseNoteTaskRequest', () => {
  const base = { noteId: 'node:n', canvasId: 'canvas:c', instruction: ' 表にして ' }
  const status = (body: unknown) => {
    try {
      parseNoteTaskRequest(body)
      return 200
    } catch (error) {
      return (error as { status: number }).status
    }
  }

  it('reads the note, the instruction, the places, the candidates, the previous tasks, the last run and the model', () => {
    expect(
      parseNoteTaskRequest({
        ...base,
        refs: [{ label: '範囲', refId: 'ref:AAAAAAAAAA' }],
        candidates: [{ id: 'node:a', text: 'a' }],
        previous: [{ question: '前の指示', answer: '前の報告' }],
        lastThreadId: '11111111-2222-4333-8444-555555555555',
        undo: true,
        model: 'opus',
        effort: 'high',
      }),
    ).toEqual({
      noteId: 'node:n',
      canvasId: 'canvas:c',
      instruction: '表にして',
      refs: [{ label: '範囲', refId: 'ref:AAAAAAAAAA' }],
      candidates: [{ id: 'node:a', text: 'a' }],
      previous: [{ question: '前の指示', answer: '前の報告' }],
      lastThreadId: '11111111-2222-4333-8444-555555555555',
      undo: true,
      model: 'opus',
      effort: 'high',
    })
    expect(parseNoteTaskRequest({ ...base, undo: false, refs: [], candidates: [] })).toEqual({ noteId: 'node:n', canvasId: 'canvas:c', instruction: '表にして' })
  })

  it('rejects broken requests', () => {
    expect(status(null)).toBe(400)
    expect(status({ ...base, noteId: 'canvas:x' })).toBe(400)
    expect(status({ ...base, canvasId: 'node:x' })).toBe(400)
    expect(status({ ...base, instruction: '  ' })).toBe(400)
    expect(status({ ...base, instruction: 'あ'.repeat(20_001) })).toBe(413)
    expect(status({ ...base, lastThreadId: 'abc' })).toBe(400)
    expect(status({ ...base, undo: 'yes' })).toBe(400)
    expect(status({ ...base, model: 'opus; rm' })).toBe(400)
    expect(status({ ...base, effort: 'huge' })).toBe(400)
    expect(status({ ...base, refs: [{ refId: 'nope' }] })).toBe(400)
  })
})

describe('POST /api/claude/note-tasks', () => {
  async function start(tasks: NoteTasks | null): Promise<string> {
    const server: Server = createServer((req, res) => {
      if (handleNoteTasks(req, res, new URL(req.url!, 'http://x').pathname, tasks)) return
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/claude/note-tasks`
  }
  const post = (url: string, body: unknown, type = 'application/json') =>
    fetch(url, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) })

  it('starts a task (201), tells why an undo failed (409 with what was undone), and rejects bad requests', async () => {
    const { host, jobs, tasks, canvasId, noteId } = setup()
    const url = await start(tasks)
    const response = await post(url, { noteId, canvasId, instruction: '箱を置いて' })
    expect(response.status).toBe(201)
    const { job } = (await response.json()) as { job: Job }
    expect(job).toMatchObject({ prompt: '箱を置いて', note: { noteId, canvasId } })
    const box = editCanvas(host, { canvasId, ops: [{ op: 'create', type: 'geo', as: 'box', x: 0, y: 300, w: 10, h: 10 }], label: '箱を置く', threadId: job.threadId })
    editCanvas(host, { canvasId, ops: [{ op: 'move', ids: [box.created.box!], dx: 5 }], label: '人が動かした' })
    jobs.end(job.id, [{ kind: 'text', text: '置きました。' }])
    const refused = await post(url, { noteId, canvasId, instruction: '丸', lastThreadId: job.threadId, undo: true })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: expect.stringMatching(/箱を置く/), undone: [], failed: { label: '箱を置く' }, left: [] })
    expect((await post(url, 'x', 'text/plain')).status).toBe(415)
    expect((await post(url, { noteId })).status).toBe(400)
    expect((await fetch(url)).status).toBe(405)
    expect((await post(await start(null), { noteId, canvasId, instruction: 'x' })).status).toBe(404)
  })
})
