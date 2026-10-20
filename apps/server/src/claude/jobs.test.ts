import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { ClaudeJobs, MAX_RUNNING, type Job, type RunQuery } from './jobs.ts'

// 画面から頼んだ Claude Code のジョブ（Agent SDK の query は偽物に差し替える）

const WS = '/srv/ws'

// SDK のメッセージのうち、ジョブが読むところだけを作る
const init = (session: string, mcp = 'connected') =>
  ({ type: 'system', subtype: 'init', session_id: session, mcp_servers: [{ name: 'canvcode', status: mcp }] }) as unknown as SDKMessage
const assistant = (session: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  ({ type: 'assistant', session_id: session, parent_tool_use_id: null, message: { content }, ...extra }) as unknown as SDKMessage
const success = (session: string) =>
  ({ type: 'result', subtype: 'success', is_error: false, session_id: session, total_cost_usd: 0.01, duration_ms: 1200, result: 'ok' }) as unknown as SDKMessage

interface Call {
  prompt: string
  options: Options
}

// messages を順に返す偽の query。release を呼ぶまで最後のメッセージを返さない
function fakeRun(messages: SDKMessage[], options: { hold?: boolean } = {}) {
  const calls: Call[] = []
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  const run: RunQuery = async function* (params) {
    calls.push(params)
    for (let i = 0; i < messages.length; i++) {
      if (options.hold && i === messages.length - 1) {
        await Promise.race([held, new Promise((resolve) => params.options.abortController!.signal.addEventListener('abort', resolve))])
        if (params.options.abortController!.signal.aborted) throw new Error('aborted')
      }
      yield messages[i]
    }
  }
  return { run, calls, release: () => release() }
}

function until(jobs: ClaudeJobs, id: string, done: (job: Job) => boolean): Promise<Job> {
  return new Promise((resolve) => {
    const check = () => {
      const job = jobs.get(id)!
      if (done(job)) {
        unsubscribe()
        resolve(job)
      }
    }
    const unsubscribe = jobs.subscribe(check)
    check()
  })
}
const finished = (jobs: ClaudeJobs, id: string) => until(jobs, id, (job) => job.status !== 'running')

describe('ClaudeJobs', () => {
  it('runs a prompt with the selected place, and turns messages into events', async () => {
    const fake = fakeRun([
      init('s1'),
      assistant('s1', [
        { type: 'text', text: '読みます' },
        { type: 'tool_use', name: 'mcp__canvcode__resolve_reference', input: { id: 'ref:Ab12Cd34Ef' } },
        { type: 'tool_use', name: 'Read', input: { file_path: `${WS}/notes/a.md` } },
        { type: 'tool_use', name: 'TodoWrite', input: {} },
      ]),
      assistant('s1', [{ type: 'text', text: '付箋にしました' }]),
      success('s1'),
    ])
    const jobs = new ClaudeJobs({ workspace: WS, mcpUrl: 'http://127.0.0.1:1/mcp', run: fake.run })
    const job = jobs.start({ prompt: '  要約して ', refId: 'ref:Ab12Cd34Ef', canvasId: 'canvas:x' })
    expect(job.status).toBe('running')
    const done = await finished(jobs, job.id)

    expect(done.status).toBe('done')
    expect(done.costUsd).toBe(0.01)
    expect(done.durationMs).toBe(1200)
    expect(done.events).toEqual([
      { kind: 'text', text: '読みます' },
      { kind: 'tool', name: 'mcp__canvcode__resolve_reference', detail: 'ref:Ab12Cd34Ef' },
      { kind: 'tool', name: 'Read', detail: 'notes/a.md' },
      { kind: 'text', text: '付箋にしました' },
    ])
    const [call] = fake.calls
    expect(call.prompt).toBe('要約して\n\n（選んだ場所：ref:Ab12Cd34Ef）')
    expect(call.options.cwd).toBe(WS)
    expect(call.options.mcpServers).toEqual({ canvcode: { type: 'http', url: 'http://127.0.0.1:1/mcp', alwaysLoad: true } })
    expect(call.options.strictMcpConfig).toBe(true)
    expect(call.options.tools).not.toContain('Bash')
    expect(call.options.resume).toBeUndefined()
    const append = (call.options.systemPrompt as { append: string }).append
    expect(append).toContain('canvas:x')
  })

  it('continues a thread with the session of its last job', async () => {
    const first = fakeRun([init('s1'), success('s1')])
    const runs = [first.run, fakeRun([init('s1'), success('s1')]).run]
    const calls: Call[] = []
    const jobs = new ClaudeJobs({
      workspace: WS,
      mcpUrl: 'x',
      run: (params) => {
        calls.push(params)
        return runs.shift()!(params)
      },
    })
    const a = jobs.start({ prompt: 'a' })
    await finished(jobs, a.id)
    const b = jobs.start({ prompt: 'b', threadId: a.threadId })
    await finished(jobs, b.id)
    expect(b.threadId).toBe(a.id)
    expect(calls[1].options.resume).toBe('s1')
    expect(() => jobs.start({ prompt: 'c', threadId: 'nope' })).toThrow(/もうありません/)
  })

  it('refuses to continue a thread while its last job is running, and limits running jobs', async () => {
    const jobs = new ClaudeJobs({ workspace: WS, mcpUrl: 'x', run: fakeRun([init('s1'), success('s1')], { hold: true }).run })
    const started = Array.from({ length: MAX_RUNNING }, () => jobs.start({ prompt: 'x' }))
    expect(() => jobs.start({ prompt: 'y', threadId: started[0].threadId })).toThrow(/まだ終わっていません/)
    expect(() => jobs.start({ prompt: 'y' })).toThrow(/同時に/)
    for (const job of started) jobs.cancel(job.id)
  })

  it('cancels a running job', async () => {
    const fake = fakeRun([init('s1'), assistant('s1', [{ type: 'text', text: '途中' }]), success('s1')], { hold: true })
    const jobs = new ClaudeJobs({ workspace: WS, mcpUrl: 'x', run: fake.run })
    const job = jobs.start({ prompt: 'x' })
    await until(jobs, job.id, (j) => j.events.length > 0)
    jobs.cancel(job.id)
    const done = await finished(jobs, job.id)
    expect(done.status).toBe('cancelled')
    expect(done.events).toEqual([{ kind: 'text', text: '途中' }])
  })

  it('reports errors: a failed run, an error result, a missing login, an MCP that did not connect', async () => {
    const failing: RunQuery = async function* () {
      yield init('s1')
      throw new Error('spawn claude ENOENT')
    }
    let jobs = new ClaudeJobs({ workspace: WS, mcpUrl: 'x', run: failing })
    let done = await finished(jobs, jobs.start({ prompt: 'x' }).id)
    expect(done.status).toBe('failed')
    expect(done.events).toEqual([{ kind: 'error', message: 'spawn claude ENOENT' }])

    const maxTurns = { type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's1', total_cost_usd: 0, duration_ms: 1, errors: [] }
    jobs = new ClaudeJobs({
      workspace: WS,
      mcpUrl: 'x',
      run: fakeRun([init('s1', 'failed'), assistant('s1', [], { error: 'authentication_failed' }), maxTurns as unknown as SDKMessage]).run,
    })
    done = await finished(jobs, jobs.start({ prompt: 'x' }).id)
    expect(done.status).toBe('failed')
    expect(done.events.map((e) => e.kind === 'error' && e.message)).toEqual([
      expect.stringContaining('MCP につながりませんでした'),
      expect.stringContaining('ログインしていません'),
      expect.stringContaining('ターン数の上限'),
    ])
  })

  it('records the tools it denied', async () => {
    let decision: unknown
    const run: RunQuery = async function* (params) {
      yield init('s1')
      decision = await params.options.canUseTool!('Bash', { command: 'rm -rf /' }, { signal: new AbortController().signal, toolUseID: 't' } as never)
      yield success('s1')
    }
    const jobs = new ClaudeJobs({ workspace: WS, mcpUrl: 'x', run })
    const done = await finished(jobs, jobs.start({ prompt: 'x' }).id)
    expect(decision).toMatchObject({ behavior: 'deny' })
    expect(done.events).toEqual([{ kind: 'denied', name: 'Bash', reason: expect.stringContaining('Bash') }])
  })

  it('notifies listeners with the new events', async () => {
    const jobs = new ClaudeJobs({ workspace: WS, mcpUrl: 'x', run: fakeRun([init('s1'), assistant('s1', [{ type: 'text', text: 'a' }]), success('s1')]).run })
    const seen: [string, number, number][] = []
    jobs.subscribe((job, events, from) => seen.push([job.status, events.length, from]))
    await finished(jobs, jobs.start({ prompt: 'x' }).id)
    expect(seen).toEqual([
      ['running', 0, 0],
      ['running', 1, 0],
      ['done', 0, 1],
    ])
  })

  it('rejects an empty or too long prompt', () => {
    const jobs = new ClaudeJobs({ workspace: WS, mcpUrl: 'x', run: fakeRun([]).run })
    expect(() => jobs.start({ prompt: '   ' })).toThrow(/空/)
    expect(() => jobs.start({ prompt: 'x'.repeat(20_001) })).toThrow(/長すぎ/)
  })
})
