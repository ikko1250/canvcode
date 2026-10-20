import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { handleClaude, parseStart } from './http.ts'
import { ClaudeJobs, type RunQuery } from './jobs.ts'
import { ClaudeStore } from './store.ts'

// 画面から Claude Code に頼む API

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const run: RunQuery = async function* () {
  yield { type: 'assistant', session_id: 's', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'こんにちは' }] } } as unknown as SDKMessage
  yield { type: 'result', subtype: 'success', is_error: false, session_id: 's', total_cost_usd: 0, duration_ms: 1, result: '' } as unknown as SDKMessage
}

function makeJobs(): ClaudeJobs {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-claude-http-'))
  const store = new ClaudeStore(dir)
  cleanups.push(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return new ClaudeJobs({ workspace: '/srv/ws', mcpUrl: 'x', store, run, deleteSession: async () => {} })
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
  })
})
