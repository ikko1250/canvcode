import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleClaude, parseStart } from './http.ts'
import { ClaudeJobs, type RunQuery } from './jobs.ts'
import { ClaudeStore } from './store.ts'

// 画面から Claude Code に頼む API

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// 送られた文ごとに「こんにちは」と答え（そのメッセージの uuid を付ける）、入れ物が閉じたら終わる偽の query
const run: RunQuery = ({ prompt }) => ({
  async *[Symbol.asyncIterator]() {
    for await (const message of prompt) {
      const stamp = { user_message_uuids: [message.uuid] }
      yield { type: 'assistant', session_id: 's', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'こんにちは' }] }, ...stamp } as unknown as SDKMessage
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 's', total_cost_usd: 0, duration_ms: 1, result: '', ...stamp } as unknown as SDKMessage
    }
  },
  interrupt: async () => {},
  stopTask: async () => {},
  setModel: async () => {},
  applyFlagSettings: async () => {},
  supportedModels: async () => [],
})

// 送られた文ごとに、Bash を使ってよいか canUseTool で尋ね、その答え（allow / deny）を文章にして返す偽の query
const askingRun: RunQuery = ({ prompt, options }) => ({
  async *[Symbol.asyncIterator]() {
    for await (const message of prompt) {
      const stamp = { user_message_uuids: [message.uuid] }
      yield { type: 'assistant', session_id: 's', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '使います' }] }, ...stamp } as unknown as SDKMessage
      const decision = await options.canUseTool!('Bash', { command: 'make' }, { signal: new AbortController().signal, toolUseID: 't', requestId: 'r' } as never)
      yield { type: 'assistant', session_id: 's', parent_tool_use_id: null, message: { content: [{ type: 'text', text: decision!.behavior }] }, ...stamp } as unknown as SDKMessage
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 's', total_cost_usd: 0, duration_ms: 1, result: '', ...stamp } as unknown as SDKMessage
    }
  },
  interrupt: async () => {},
  stopTask: async () => {},
  setModel: async () => {},
  applyFlagSettings: async () => {},
  supportedModels: async () => [],
})

function makeJobs(query: RunQuery = run): ClaudeJobs {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-claude-http-'))
  const store = new ClaudeStore(dir)
  cleanups.push(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const jobs = new ClaudeJobs({ workspace: '/srv/ws', mcpUrl: 'x', store, run: query, deleteSession: async () => {} })
  cleanups.push(() => jobs.dispose())
  return jobs
}

async function setup(jobs: ClaudeJobs | null): Promise<string> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!handleClaude(req, res, url.pathname, jobs)) res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => {
    server.closeAllConnections()
    return new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

// SSE を読み、条件に合うメッセージが来るまで待つ
async function readEvents(base: string, until: (messages: Record<string, unknown>[]) => boolean): Promise<Record<string, unknown>[]> {
  const controller = new AbortController()
  const res = await fetch(`${base}/api/claude/events`, { signal: controller.signal })
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const messages: Record<string, unknown>[] = []
  let buffer = ''
  while (!until(messages)) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let end: number
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      if (chunk.startsWith('data: ')) messages.push(JSON.parse(chunk.slice(6)) as Record<string, unknown>)
    }
  }
  controller.abort()
  return messages
}

describe('/api/claude', () => {
  it('starts a job and streams its events', async () => {
    const base = await setup(makeJobs())
    const done = (messages: Record<string, unknown>[]) =>
      messages.some((m) => m.type === 'job' && (m.job as { status: string }).status === 'done')
    const streamed = readEvents(base, done)
    // つないでから頼む（snapshot が先に届く）
    await new Promise((resolve) => setTimeout(resolve, 50))
    const res = await post(`${base}/api/claude/jobs`, { prompt: 'やあ', refId: 'ref:Ab12Cd34Ef', canvasId: 'canvas:x' })
    expect(res.status).toBe(201)
    const { job } = (await res.json()) as { job: { id: string; refId: string } }
    expect(job.refId).toBe('ref:Ab12Cd34Ef')

    const messages = await streamed
    expect(messages[0]).toEqual({ type: 'snapshot', threads: [], running: [] })
    const events = messages.filter((m) => m.type === 'job').flatMap((m) => m.events as unknown[])
    expect(events).toEqual([{ kind: 'text', text: 'こんにちは' }])

    const one = (await (await fetch(`${base}/api/claude/jobs/${job.id}`)).json()) as { job: { status: string } }
    expect(one.job.status).toBe('done')
    const { threads } = (await (await fetch(`${base}/api/claude/threads`)).json()) as { threads: { threadId: string; title: string }[] }
    expect(threads).toMatchObject([{ threadId: job.id, title: 'やあ', jobCount: 1, running: false }])
    const thread = (await (await fetch(`${base}/api/claude/threads/${job.id}`)).json()) as { jobs: { id: string }[] }
    expect(thread.jobs.map((j) => j.id)).toEqual([job.id])

    expect((await fetch(`${base}/api/claude/threads/${job.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await fetch(`${base}/api/claude/threads/${job.id}`)).status).toBe(404)
    expect((await fetch(`${base}/api/claude/threads/${job.id}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('rejects bad requests', async () => {
    const base = await setup(makeJobs())
    expect((await post(`${base}/api/claude/jobs`, { prompt: '' })).status).toBe(400)
    expect((await post(`${base}/api/claude/jobs`, { prompt: 'x', threadId: '00000000-0000-0000-0000-000000000000' })).status).toBe(404)
    expect((await post(`${base}/api/claude/jobs/00000000-0000-0000-0000-000000000000/cancel`, {})).status).toBe(404)
    expect((await fetch(`${base}/api/claude/jobs`, { method: 'DELETE' })).status).toBe(405)
  })

  it('stops a thread or one of its background tasks', async () => {
    const base = await setup(makeJobs())
    const { job } = (await (await post(`${base}/api/claude/jobs`, { prompt: 'やあ' })).json()) as { job: { id: string } }
    const thread = `${base}/api/claude/threads/${job.id}`
    expect((await post(`${thread}/stop`, {})).status).toBe(204)
    // 動いていない作業・正しくない id
    expect((await post(`${thread}/tasks/ag1/stop`, {})).status).toBe(404)
    expect((await post(`${thread}/tasks/a%20b/stop`, {})).status).toBe(400)
    expect((await fetch(`${thread}/stop`)).status).toBe(405)
    expect((await post(`${base}/api/claude/threads/00000000-0000-0000-0000-000000000000/stop`, {})).status).toBe(404)
  })

  it('shows a question on the thread (also in the snapshot of a tab that connects later), and takes the answer as JSON', async () => {
    const base = await setup(makeJobs(askingRun))
    const { job } = (await (await post(`${base}/api/claude/jobs`, { prompt: 'ビルドして' })).json()) as { job: { id: string } }
    // あとからつないだタブも、snapshot で待っている問い合わせを受け取る
    const asked = (messages: Record<string, unknown>[]) =>
      messages.some((m) => m.type === 'snapshot' && (m.threads as { permissions: unknown[] }[])[0]?.permissions.length === 1) ||
      messages.some((m) => m.type === 'thread' && (m.thread as { permissions: unknown[] }).permissions.length === 1)
    const messages = await readEvents(base, asked)
    const thread = (messages.at(-1)!.type === 'snapshot' ? (messages.at(-1)!.threads as unknown[])[0] : messages.at(-1)!.thread) as {
      permissions: { id: string; name: string; detail: string; jobId: string }[]
    }
    const [question] = thread.permissions
    expect(question).toMatchObject({ name: 'Bash', detail: 'make', jobId: job.id })
    const { threads } = (await (await fetch(`${base}/api/claude/threads`)).json()) as { threads: { permissions: unknown[] }[] }
    expect(threads[0]!.permissions).toHaveLength(1)

    const url = `${base}/api/claude/threads/${job.id}/permissions/${question!.id}`
    // JSON でなければ受けない（別のサイトのフォームから送らせない）。答えの形が違えば 400、POST でなければ 405
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'decision=allow' })).status).toBe(415)
    expect((await fetch(url, { method: 'POST', body: '{"decision":"allow"}' })).status).toBe(415)
    expect((await post(url, { decision: 'yes' })).status).toBe(400)
    expect((await fetch(url)).status).toBe(405)
    expect((await post(`${base}/api/claude/threads/${job.id}/permissions/not-a-uuid`, { decision: 'allow' })).status).toBe(404)
    expect((await post(`${base}/api/claude/threads/00000000-0000-0000-0000-000000000000/permissions/${question!.id}`, { decision: 'allow' })).status).toBe(404)

    expect((await post(url, { decision: 'allow' })).status).toBe(204)
    // もう待っていない
    expect((await post(url, { decision: 'deny' })).status).toBe(404)
    await vi.waitFor(async () => {
      const one = (await (await fetch(`${base}/api/claude/jobs/${job.id}`)).json()) as { job: { status: string; events: { kind: string; text?: string }[] } }
      expect(one.job.status).toBe('done')
      expect(one.job.events.map((event) => event.kind)).toEqual(['text', 'ask', 'answer', 'text'])
      expect(one.job.events.at(-1)!.text).toBe('allow')
    })
  })

  it('lists the models to choose from (MAI-106)', async () => {
    const base = await setup(
      makeJobs(() => ({
        async *[Symbol.asyncIterator]() {},
        interrupt: async () => {},
        stopTask: async () => {},
        setModel: async () => {},
        applyFlagSettings: async () => {},
        supportedModels: async () => [{ value: 'sonnet', displayName: 'Sonnet 5.5', description: 'd', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }],
      })),
    )
    const res = await fetch(`${base}/api/claude/models`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ models: [{ value: 'sonnet', label: 'Sonnet 5.5', description: 'd', efforts: ['low', 'high'] }], default: {}, fromClaude: true })
    expect((await post(`${base}/api/claude/models`, {})).status).toBe(405)
  })

  it('answers 404 when disabled', async () => {
    const base = await setup(null)
    expect((await fetch(`${base}/api/claude/threads`)).status).toBe(404)
  })
})

describe('parseStart', () => {
  it('normalizes the ref id and drops empty fields', () => {
    expect(parseStart({ prompt: 'x', refId: 'Ab12Cd34Ef', canvasId: '', threadId: null })).toEqual({ prompt: 'x', refId: 'ref:Ab12Cd34Ef' })
    expect(() => parseStart({ prompt: 'x', refId: '!!' })).toThrow(/refId/)
    expect(() => parseStart({ prompt: 1 })).toThrow(/prompt/)
    // モデルと effort（MAI-106）。空なら既定
    expect(parseStart({ prompt: 'x', model: 'opus[1m]', effort: 'xhigh' })).toEqual({ prompt: 'x', model: 'opus[1m]', effort: 'xhigh' })
    expect(parseStart({ prompt: 'x', model: '', effort: null })).toEqual({ prompt: 'x' })
    expect(() => parseStart({ prompt: 'x', model: 'opus; rm -rf /' })).toThrow(/invalid model/)
    expect(() => parseStart({ prompt: 'x', model: '--model' })).toThrow(/invalid model/)
    expect(() => parseStart({ prompt: 'x', effort: 'extreme' })).toThrow(/invalid effort/)
  })
})
