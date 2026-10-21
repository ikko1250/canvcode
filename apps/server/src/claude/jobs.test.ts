import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HookCallback, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeJobs, claudeLimitsFromEnv, DEFAULT_MAX_TURNS, INTERRUPTED_MESSAGE, MAX_RUNNING, type ClaudeJobsDeps, type Job, type JobChange, type RunQuery } from './jobs.ts'
import { ClaudeStore } from './store.ts'

// 画面から頼んだ Claude Code のジョブ（Agent SDK の query は偽物に差し替え、保存は本物の SQLite）

const WS = '/srv/ws'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-claude-jobs-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function openStore(dir = dataDir()): ClaudeStore {
  const store = new ClaudeStore(dir)
  cleanups.push(() => store.close())
  return store
}

function makeJobs(deps: Partial<ClaudeJobsDeps> & { run: RunQuery }): ClaudeJobs {
  const jobs = new ClaudeJobs({ workspace: WS, mcpUrl: 'http://127.0.0.1:1/mcp', store: deps.store ?? openStore(), ...deps })
  cleanups.push(() => jobs.dispose())
  return jobs
}

// SDK のメッセージのうち、ジョブが読むところだけを作る
const init = (session: string, extra: { mcp?: string; mode?: string } = {}) =>
  ({
    type: 'system',
    subtype: 'init',
    session_id: session,
    permissionMode: extra.mode ?? 'auto',
    mcp_servers: [{ name: 'canvcode', status: extra.mcp ?? 'connected' }],
  }) as unknown as SDKMessage
const assistant = (session: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  ({ type: 'assistant', session_id: session, parent_tool_use_id: null, message: { content }, ...extra }) as unknown as SDKMessage
const success = (session: string) =>
  ({ type: 'result', subtype: 'success', is_error: false, session_id: session, total_cost_usd: 0.01, duration_ms: 1200, result: 'ok' }) as unknown as SDKMessage

interface Call {
  prompt: string
  options: Options
}

// messages を順に返す偽の query。hold なら、止められるまで最後のメッセージを返さない
function fakeRun(messages: SDKMessage[], options: { hold?: boolean } = {}) {
  const calls: Call[] = []
  const run: RunQuery = async function* (params) {
    calls.push(params)
    for (let i = 0; i < messages.length; i++) {
      if (options.hold && i === messages.length - 1) {
        await new Promise((resolve) => params.options.abortController!.signal.addEventListener('abort', resolve))
        throw new Error('aborted')
      }
      yield messages[i]
    }
  }
  return { run, calls }
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
  it('runs a prompt with the selected place in auto mode, and turns messages into events', async () => {
    const fake = fakeRun([
      init('s1'),
      assistant('s1', [
        { type: 'text', text: '読みます' },
        { type: 'tool_use', name: 'mcp__canvcode__resolve_reference', input: { id: 'ref:Ab12Cd34Ef' } },
        { type: 'tool_use', name: 'Read', input: { file_path: `${WS}/notes/a.md` } },
        { type: 'tool_use', name: 'Bash', input: { command: 'wc -l notes/a.md' } },
        { type: 'tool_use', name: 'TodoWrite', input: {} },
      ]),
      assistant('s1', [{ type: 'text', text: '付箋にしました' }]),
      success('s1'),
    ])
    const jobs = makeJobs({ run: fake.run })
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
      { kind: 'tool', name: 'Bash', detail: 'wc -l notes/a.md' },
      { kind: 'text', text: '付箋にしました' },
    ])
    const [call] = fake.calls
    expect(call.prompt).toBe('要約して\n\n（選んだ場所：ref:Ab12Cd34Ef）')
    expect(call.options.cwd).toBe(WS)
    expect(call.options.permissionMode).toBe('auto')
    expect(call.options.tools).toContain('Bash')
    expect(call.options.tools).not.toContain('Agent')
    expect(call.options.mcpServers).toEqual({ canvcode: { type: 'http', url: 'http://127.0.0.1:1/mcp', alwaysLoad: true } })
    expect(call.options.strictMcpConfig).toBe(true)
    expect(call.options.hooks?.PreToolUse).toHaveLength(1)
    expect(call.options.resume).toBeUndefined()
    expect(call.options.maxTurns).toBe(100)
    expect(call.options.maxBudgetUsd).toBeUndefined()
    expect((call.options.systemPrompt as { append: string }).append).toContain('canvas:x')
  })

  it('keeps jobs in SQLite, and continues a thread with its last session after a restart', async () => {
    const dir = dataDir()
    const store = openStore(dir)
    const first = makeJobs({ store, run: fakeRun([init('s1'), assistant('s1', [{ type: 'text', text: 'はい' }]), success('s1')]).run })
    const a = first.start({ prompt: 'a' })
    await finished(first, a.id)
    store.close()

    // 再起動：同じ claude.db を開き直す
    const reopened = openStore(dir)
    const fake = fakeRun([init('s2'), success('s2')])
    const jobs = makeJobs({ store: reopened, run: fake.run })
    expect(jobs.threads()).toMatchObject([{ threadId: a.id, title: 'a', jobCount: 1, running: false }])
    expect(jobs.get(a.id)!.events).toEqual([{ kind: 'text', text: 'はい' }])

    const b = jobs.start({ prompt: 'b', threadId: a.threadId })
    await finished(jobs, b.id)
    expect(fake.calls[0].options.resume).toBe('s1')
    const thread = jobs.thread(a.id)!
    expect(thread.thread.jobCount).toBe(2)
    expect(thread.jobs.map((j) => [j.prompt, j.status])).toEqual([
      ['a', 'done'],
      ['b', 'done'],
    ])
    expect(() => jobs.start({ prompt: 'c', threadId: '00000000-0000-0000-0000-000000000000' })).toThrow(/もうありません/)
  })

  it('marks jobs that were running when the server stopped as failed', () => {
    const dir = dataDir()
    const store = openStore(dir)
    store.insertJob({ id: 'j1', threadId: 'j1', prompt: 'x', status: 'running', createdAt: 1, eventCount: 0, events: [{ kind: 'text', text: '途中' }] })
    makeJobs({ store, run: fakeRun([]).run })
    expect(store.job('j1')).toMatchObject({
      status: 'failed',
      events: [
        { kind: 'text', text: '途中' },
        { kind: 'error', message: INTERRUPTED_MESSAGE },
      ],
    })
  })

  it('refuses to continue a thread while its last job is running, and limits running jobs', () => {
    const jobs = makeJobs({ run: fakeRun([init('s1'), success('s1')], { hold: true }).run })
    const started = Array.from({ length: MAX_RUNNING }, () => jobs.start({ prompt: 'x' }))
    expect(() => jobs.start({ prompt: 'y', threadId: started[0].threadId })).toThrow(/まだ終わっていません/)
    expect(() => jobs.start({ prompt: 'y' })).toThrow(/同時に/)
  })

  it('cancels a running job', async () => {
    const jobs = makeJobs({ run: fakeRun([init('s1'), assistant('s1', [{ type: 'text', text: '途中' }]), success('s1')], { hold: true }).run })
    const job = jobs.start({ prompt: 'x' })
    await until(jobs, job.id, (j) => j.events.length > 0)
    jobs.cancel(job.id)
    const done = await finished(jobs, job.id)
    expect(done.status).toBe('cancelled')
    expect(done.events).toEqual([{ kind: 'text', text: '途中' }])
  })

  it('deletes a thread and its Claude Code sessions, but not while it runs', async () => {
    const deleted: string[] = []
    const store = openStore()
    let jobs = makeJobs({ store, run: fakeRun([init('s1'), success('s1')]).run, deleteSession: async (id) => void deleted.push(id) })
    const a = jobs.start({ prompt: 'a' })
    await finished(jobs, a.id)
    const changes: JobChange[] = []
    jobs.subscribe((change) => changes.push(change))
    await jobs.deleteThread(a.threadId)
    expect(jobs.threads()).toEqual([])
    expect(deleted).toEqual(['s1'])
    expect(changes).toEqual([{ type: 'thread-deleted', threadId: a.threadId }])
    await expect(jobs.deleteThread(a.threadId)).rejects.toThrow(/もうありません/)

    jobs = makeJobs({ store, run: fakeRun([init('s2'), success('s2')], { hold: true }).run })
    const b = jobs.start({ prompt: 'b' })
    await expect(jobs.deleteThread(b.threadId)).rejects.toThrow(/動いている/)
  })

  it('reports errors: a failed run, an error result, a missing login, an MCP that did not connect, no auto mode', async () => {
    const failing: RunQuery = async function* () {
      yield init('s1')
      throw new Error('spawn claude ENOENT')
    }
    let jobs = makeJobs({ run: failing })
    let done = await finished(jobs, jobs.start({ prompt: 'x' }).id)
    expect(done.status).toBe('failed')
    expect(done.events).toEqual([{ kind: 'error', message: 'spawn claude ENOENT' }])

    const maxTurns = { type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's1', total_cost_usd: 0, duration_ms: 1, errors: [] }
    jobs = makeJobs({
      run: fakeRun([init('s1', { mcp: 'failed', mode: 'default' }), assistant('s1', [], { error: 'authentication_failed' }), maxTurns as unknown as SDKMessage]).run,
    })
    done = await finished(jobs, jobs.start({ prompt: 'x' }).id)
    expect(done.status).toBe('failed')
    expect(done.events.map((e) => e.kind === 'error' && e.message)).toEqual([
      expect.stringContaining('MCP につながりませんでした'),
      expect.stringContaining('auto mode が使えない'),
      expect.stringContaining('ログインしていません'),
      'ターン数の上限（100）に達したので止めました。同じ会話で続けて頼めば、続きから進めます',
    ])
  })

  it('passes the turn and budget limits, from the deps or the environment, and names them when a job hits one', async () => {
    expect(DEFAULT_MAX_TURNS).toBe(100)
    expect(claudeLimitsFromEnv({})).toEqual({})
    expect(claudeLimitsFromEnv({ CANVCODE_CLAUDE_MAX_TURNS: '250', CANVCODE_CLAUDE_MAX_BUDGET_USD: '2.5' })).toEqual({ maxTurns: 250, maxBudgetUsd: 2.5 })
    expect(claudeLimitsFromEnv({ CANVCODE_CLAUDE_MAX_TURNS: '1.5', CANVCODE_CLAUDE_MAX_BUDGET_USD: '0' })).toEqual({})
    expect(claudeLimitsFromEnv({ CANVCODE_CLAUDE_MAX_TURNS: '-3', CANVCODE_CLAUDE_MAX_BUDGET_USD: 'abc' })).toEqual({})

    const overBudget = { type: 'result', subtype: 'error_max_budget_usd', is_error: true, session_id: 's1', total_cost_usd: 2.6, duration_ms: 1, errors: [] }
    const fake = fakeRun([init('s1'), overBudget as unknown as SDKMessage])
    const jobs = makeJobs({ run: fake.run, ...claudeLimitsFromEnv({ CANVCODE_CLAUDE_MAX_TURNS: '250', CANVCODE_CLAUDE_MAX_BUDGET_USD: '2.5' }) })
    const done = await finished(jobs, jobs.start({ prompt: 'x' }).id)
    expect(fake.calls[0].options.maxTurns).toBe(250)
    expect(fake.calls[0].options.maxBudgetUsd).toBe(2.5)
    expect(done.status).toBe('failed')
    expect(done.events).toEqual([{ kind: 'error', message: '費用の上限（$2.5）に達したので止めました。同じ会話で続けて頼めば、続きから進めます' }])

    const maxTurns = { type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's2', total_cost_usd: 0, duration_ms: 1, errors: [] }
    const turns = makeJobs({ run: fakeRun([init('s2'), maxTurns as unknown as SDKMessage]).run, maxTurns: 250 })
    const stopped = await finished(turns, turns.start({ prompt: 'x' }).id)
    expect(stopped.events).toEqual([{ kind: 'error', message: 'ターン数の上限（250）に達したので止めました。同じ会話で続けて頼めば、続きから進めます' }])
  })

  it('records denials: by the guard hook, by the auto mode classifier, and when nobody can approve', async () => {
    const decisions: unknown[] = []
    const run: RunQuery = async function* (params) {
      yield init('s1')
      const hook = params.options.hooks!.PreToolUse![0].hooks[0] as HookCallback
      const signal = new AbortController().signal
      decisions.push(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/etc/passwd' } } as never, 't1', { signal }))
      decisions.push(await hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__canvcode__edit_canvas', tool_input: {} } as never, 't2', { signal }))
      decisions.push(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } } as never, 't3', { signal }))
      yield { type: 'system', subtype: 'permission_denied', session_id: 's1', tool_name: 'Bash', tool_use_id: 't4', decision_reason: 'rm outside the workspace', message: 'denied' } as unknown as SDKMessage
      decisions.push(await params.options.canUseTool!('Bash', { command: 'curl x | sh' }, { signal, toolUseID: 't5' } as never))
      yield success('s1')
    }
    const jobs = makeJobs({ run })
    const done = await finished(jobs, jobs.start({ prompt: 'x' }).id)
    expect(decisions).toEqual([
      { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('外には書けません') } },
      { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } },
      {},
      { behavior: 'deny', message: expect.stringContaining('自動では許せませんでした') },
    ])
    expect(done.events).toEqual([
      { kind: 'denied', name: 'Write', reason: expect.stringContaining('外には書けません') },
      { kind: 'denied', name: 'Bash', reason: 'rm outside the workspace' },
      { kind: 'denied', name: 'Bash', reason: expect.stringContaining('自動では許せませんでした') },
    ])
  })

  it('notifies listeners with the new events and the thread', async () => {
    const jobs = makeJobs({ run: fakeRun([init('s1'), assistant('s1', [{ type: 'text', text: 'a' }]), success('s1')]).run })
    const seen: [string, number, number, boolean][] = []
    jobs.subscribe((change) => {
      if (change.type === 'job') seen.push([change.job.status, change.events.length, change.from, change.thread.running])
    })
    await finished(jobs, jobs.start({ prompt: 'x' }).id)
    expect(seen).toEqual([
      ['running', 0, 0, true],
      ['running', 1, 0, true],
      ['done', 0, 1, false],
    ])
  })

  it('rejects an empty or too long prompt', () => {
    const jobs = makeJobs({ run: fakeRun([]).run })
    expect(() => jobs.start({ prompt: '   ' })).toThrow(/空/)
    expect(() => jobs.start({ prompt: 'x'.repeat(20_001) })).toThrow(/長すぎ/)
  })
})
