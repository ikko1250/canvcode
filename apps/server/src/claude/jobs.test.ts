import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HookCallback, ModelInfo, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ClaudeJobs,
  claudeLimitsFromEnv,
  DEFAULT_MAX_TURNS,
  INTERRUPTED_MESSAGE,
  MAX_PENDING_PERMISSIONS,
  MAX_RUNNING,
  MAX_SESSIONS,
  MODEL_PROBE_RETRY_MS,
  TOO_MANY_PERMISSIONS,
  type ClaudeJobsDeps,
  type Job,
  type JobChange,
  type RunQuery,
} from './jobs.ts'
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
// total_cost_usd は query の合計
const success = (session: string, total = 0.01) =>
  ({ type: 'result', subtype: 'success', is_error: false, session_id: session, total_cost_usd: total, duration_ms: 1200, result: 'ok' }) as unknown as SDKMessage
const interrupted = (session: string, total = 0.01) =>
  ({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: session, total_cost_usd: total, duration_ms: 5, errors: [] }) as unknown as SDKMessage
const taskStarted = (id: string, description: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'system', subtype: 'task_started', session_id: 's1', task_id: id, description, is_backgrounded: true, ...extra }) as unknown as SDKMessage
const taskDone = (id: string, status = 'completed') =>
  ({ type: 'system', subtype: 'task_notification', session_id: 's1', task_id: id, status, summary: '要約', output_file: '/tmp/x' }) as unknown as SDKMessage
const tasksChanged = (tasks: { id: string; description: string; ambient?: boolean }[]) =>
  ({
    type: 'system',
    subtype: 'background_tasks_changed',
    session_id: 's1',
    tasks: tasks.map((task) => ({ task_id: task.id, description: task.description, task_type: 'local_agent', ...(task.ambient ? { ambient: true } : {}) })),
  }) as unknown as SDKMessage

// Claude Code が返すモデルの一覧（MAI-106。'default' の行は Claude Code の組み込みの既定）
const MODEL_LIST = [
  { value: 'default', resolvedModel: 'claude-fable-5-2', displayName: 'Default (recommended)', description: 'Fable 5.2', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-haiku-4-5-20251001', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest' },
  { value: 'claude-opus-4-6', resolvedModel: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Older', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
] as ModelInfo[]

// 偽の query（ストリーミング入力）。送られた文を sent に記録し、テストから emit() で SDK のメッセージを流す。
// emit() は、最後に受け取ったメッセージの uuid を、そのターンの assistant（サブエージェントの中は除く）と result に user_message_uuids として付ける
// （CLI と同じ。result でターンが終わる）。emitMeta() は付けない（CLI が自分で起こしたターン）。
// reply があれば、送られた文ごとにそれを呼ぶ。入れ物が閉じたら（stdin の終わり）、linger でなければ終わる
interface FakeQuery {
  options: Options
  sent: string[]
  uuids: string[]
  // 答えているメッセージの uuid
  turn: string | undefined
  interrupts: { cancelQueued: boolean }[]
  stopped: string[]
  // setModel・applyFlagSettings で変えたモデルと effort と、送られた文を、呼ばれた順に（MAI-106）
  log: string[]
  aborted: boolean
  emit: (...messages: SDKMessage[]) => void
  emitMeta: (...messages: SDKMessage[]) => void
  end: () => void
  fail: (error: Error) => void
}

function fakeSdk(options: { reply?: (q: FakeQuery, text: string) => void; linger?: boolean; onInterrupt?: (q: FakeQuery) => void } = {}) {
  const queries: FakeQuery[] = []
  const run: RunQuery = (params) => {
    const out: SDKMessage[] = []
    let wake: (() => void) | undefined
    let done = false
    let error: Error | undefined
    const q: FakeQuery = {
      options: params.options,
      sent: [],
      uuids: [],
      turn: undefined,
      interrupts: [],
      stopped: [],
      log: [],
      aborted: false,
      emit: (...messages) => {
        for (const message of messages) {
          const turn = q.turn
          const top = message.type === 'result' || (message.type === 'assistant' && !message.parent_tool_use_id)
          out.push(top && turn && !('user_message_uuids' in message) ? ({ ...message, user_message_uuids: [turn] } as SDKMessage) : message)
          if (message.type === 'result') q.turn = undefined
        }
        wake?.()
      },
      emitMeta: (...messages) => {
        out.push(...messages)
        wake?.()
      },
      end: () => {
        done = true
        wake?.()
      },
      fail: (failure) => {
        error = failure
        wake?.()
      },
    }
    params.options.abortController!.signal.addEventListener('abort', () => {
      q.aborted = true
      q.fail(new Error('aborted'))
    })
    void (async () => {
      for await (const message of params.prompt) {
        const text = message.message.content as string
        q.sent.push(text)
        q.log.push(`send:${text.split('\n').at(-1)}`)
        q.uuids.push(message.uuid!)
        q.turn = message.uuid
        options.reply?.(q, text)
      }
      if (!options.linger) q.end()
    })()
    queries.push(q)
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = out.shift()
          if (next) {
            yield next
            continue
          }
          if (error) throw error
          if (done) return
          await new Promise<void>((resolve) => {
            wake = resolve
          })
          wake = undefined
        }
      },
      interrupt: async (interrupt?: { cancelQueued?: boolean }) => {
        q.interrupts.push({ cancelQueued: interrupt?.cancelQueued ?? false })
        options.onInterrupt?.(q)
      },
      stopTask: async (taskId: string) => {
        q.stopped.push(taskId)
      },
      // CLI が答えるまで少し待つ（送る文が変え終わるのを待つことを確かめる）
      setModel: async (model?: string) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        q.log.push(`model:${model ?? '-'}`)
      },
      applyFlagSettings: async (settings: { effortLevel?: string | null }) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        q.log.push(`effort:${settings.effortLevel ?? '-'}`)
      },
      supportedModels: async () => MODEL_LIST,
    }
  }
  return { run, queries }
}

// 送られた文ごとに、1 ターン（init・messages・result）を返す偽の SDK。費用は 1 ターン 0.01 ずつ増える
function replying(messages: (text: string) => SDKMessage[] = () => [], session = 's1') {
  let total = 0
  return fakeSdk({
    reply: (q, text) => {
      total += 0.01
      q.emit(init(session), ...messages(text), success(session, total))
    },
  })
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
const queryAt = async (sdk: { queries: FakeQuery[] }, index: number) => {
  await vi.waitFor(() => expect(sdk.queries.length).toBeGreaterThan(index))
  return sdk.queries[index]
}

describe('ClaudeJobs', () => {
  it('runs a prompt with the selected place in auto mode, and turns messages into events', async () => {
    const sdk = replying(() => [
      assistant('s1', [
        { type: 'text', text: '読みます' },
        { type: 'tool_use', name: 'mcp__canvcode__resolve_reference', input: { id: 'ref:Ab12Cd34Ef' } },
        { type: 'tool_use', name: 'Read', input: { file_path: `${WS}/notes/a.md` } },
        { type: 'tool_use', name: 'Bash', input: { command: 'wc -l notes/a.md' } },
        { type: 'tool_use', name: 'TodoWrite', input: {} },
      ]),
      assistant('s1', [{ type: 'text', text: '付箋にしました' }]),
    ])
    const jobs = makeJobs({ run: sdk.run })
    const job = jobs.start({ prompt: '  要約して ', refId: 'ref:Ab12Cd34Ef', canvasId: 'canvas:x' })
    expect(job.status).toBe('running')
    const done = await finished(jobs, job.id)

    expect(done.status).toBe('done')
    expect(done.origin).toBeUndefined()
    expect(done.costUsd).toBe(0.01)
    expect(done.durationMs).toBe(1200)
    expect(done.events).toEqual([
      { kind: 'text', text: '読みます' },
      { kind: 'tool', name: 'mcp__canvcode__resolve_reference', detail: 'ref:Ab12Cd34Ef' },
      { kind: 'tool', name: 'Read', detail: 'notes/a.md' },
      { kind: 'tool', name: 'Bash', detail: 'wc -l notes/a.md' },
      { kind: 'text', text: '付箋にしました' },
    ])
    const [q] = sdk.queries
    expect(q.sent).toEqual(['要約して\n\n（選んだ場所：ref:Ab12Cd34Ef）'])
    const { options } = q
    expect(options.cwd).toBe(WS)
    expect(options.permissionMode).toBe('auto')
    expect(options.tools).toContain('Bash')
    expect(options.tools).toContain('Agent')
    expect(options.tools).toContain('Skill')
    expect(options.skills).toBe('all')
    expect(options.mcpServers).toEqual({ canvcode: { type: 'http', url: 'http://127.0.0.1:1/mcp', alwaysLoad: true } })
    expect(options.strictMcpConfig).toBe(true)
    expect(options.hooks?.PreToolUse).toHaveLength(1)
    expect(options.resume).toBeUndefined()
    expect(options.maxTurns).toBe(100)
    expect(options.maxBudgetUsd).toBeUndefined()
    expect(options.perTaskStopAffordance).toBe(true)
    expect(options.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBeUndefined()
    // env は Claude Code の環境を丸ごと置き換えるので、process.env を広げたうえで足してある
    expect(options.env?.PATH).toBe(process.env.PATH)
    expect(options.env?.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('canvcode')
    expect(options.env?.CLAUDE_CODE_TMPDIR).toBe(process.env.CLAUDE_CODE_TMPDIR ?? tmpdir())
    expect((options.systemPrompt as { append: string }).append).toContain('canvas:x')
  })

  it("lets the hook allow reading the session's own tool results, and canUseTool use what the hook saw (it gets no session id)", async () => {
    const decisions: unknown[] = []
    const transcript = '/srv/config/projects/-srv-ws/s1.jsonl'
    const own = '/srv/config/projects/-srv-ws/s1/tool-results/b1.txt'
    const tasks = `/srv/tmp/claude-${process.getuid!()}/-srv-ws/s1/tasks/b2.output`
    const sdk = fakeSdk({
      reply: (q) =>
        void (async () => {
          q.emit(init('s1'))
          const hook = q.options.hooks!.PreToolUse![0].hooks[0] as HookCallback
          const signal = new AbortController().signal
          const pre = (file_path: string) =>
            hook({ hook_event_name: 'PreToolUse', session_id: 's1', transcript_path: transcript, cwd: WS, tool_name: 'Read', tool_input: { file_path }, tool_use_id: 't' } as never, 't', { signal })
          decisions.push(await pre(own))
          decisions.push(await pre(tasks))
          decisions.push(await pre('/srv/config/projects/-srv-ws/s2/tool-results/b1.txt'))
          decisions.push(await q.options.canUseTool!('Read', { file_path: own }, { signal, toolUseID: 't' } as never))
          q.emit(success('s1'))
        })(),
    })
    const jobs = makeJobs({ run: sdk.run, tmpRoot: '/srv/tmp' })
    await finished(jobs, jobs.start({ prompt: 'x' }).id)
    expect(decisions).toEqual([
      { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } },
      { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } },
      { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('外は読めません') } },
      { behavior: 'allow', updatedInput: { file_path: own } },
    ])
    expect(sdk.queries[0].options.env?.CLAUDE_CODE_TMPDIR).toBe('/srv/tmp')
  })

  it('sends the next message of a thread to the same process, with the cost of each turn', async () => {
    const sdk = replying((text) => [assistant('s1', [{ type: 'text', text: `${text.split('\n')[0]}です` }])])
    const jobs = makeJobs({ run: sdk.run })
    const a = await finished(jobs, jobs.start({ prompt: 'a', canvasId: 'canvas:x' }).id)
    const b = await finished(jobs, jobs.start({ prompt: 'b', threadId: a.threadId, canvasId: 'canvas:y' }).id)
    expect(sdk.queries).toHaveLength(1)
    // システムプロンプトと違う Canvas を見ていれば、それを添える
    expect(sdk.queries[0].sent).toEqual(['a', 'b\n\n（いま見ている Canvas：canvas:y）'])
    expect(a.costUsd).toBeCloseTo(0.01)
    expect(b.costUsd).toBeCloseTo(0.01)
    expect(b.events).toEqual([{ kind: 'text', text: 'bです' }])
  })

  it('runs a thread with the chosen model and effort, changes them before the next message, and keeps them per thread (MAI-106)', async () => {
    const sdk = replying()
    const jobs = makeJobs({ run: sdk.run })
    const a = await finished(jobs, jobs.start({ prompt: 'a', model: 'opus', effort: 'high' }).id)
    const [q] = sdk.queries
    expect(q.options.model).toBe('opus')
    expect(q.options.effort).toBe('high')
    expect(a).toMatchObject({ model: 'opus', effort: 'high' })
    expect(jobs.threads()[0]).toMatchObject({ threadId: a.threadId, model: 'opus', effort: 'high' })

    // 違うモデルにしたら、送る前に変える（effort を外したら、モデルの既定に戻す）。変え終わってから文を流す
    const b = await finished(jobs, jobs.start({ prompt: 'b', threadId: a.threadId, model: 'sonnet' }).id)
    expect(sdk.queries).toHaveLength(1)
    expect(q.log).toEqual(['send:a', 'model:sonnet', 'effort:-', 'send:b'])
    expect(b.model).toBe('sonnet')
    expect(b.effort).toBeUndefined()
    const thread = jobs.threads()[0]
    expect(thread.model).toBe('sonnet')
    expect(thread.effort).toBeUndefined()
    // 同じなら変えない
    await finished(jobs, jobs.start({ prompt: 'c', threadId: a.threadId, model: 'sonnet' }).id)
    expect(q.log.slice(4)).toEqual(['send:c'])
    // 既定に戻すと、モデルを渡さずに変える（既定のモデルを使う）
    await finished(jobs, jobs.start({ prompt: 'd', threadId: a.threadId }).id)
    expect(q.log.slice(5)).toEqual(['model:-', 'effort:-', 'send:d'])
    expect(jobs.get(jobs.thread(a.threadId)!.jobs.at(-1)!.id)?.model).toBeUndefined()

    // 何も選ばない会話は、Options に model も effort も渡さない
    const other = await finished(jobs, jobs.start({ prompt: 'e' }).id)
    expect(sdk.queries[1].options.model).toBeUndefined()
    expect(sdk.queries[1].options.effort).toBeUndefined()
    expect(jobs.threads().find((t) => t.threadId === other.threadId)?.model).toBeUndefined()
  })

  it("uses the server's model for the default, and resumes a closed thread with the chosen model (MAI-106)", async () => {
    const sdk = replying()
    const jobs = makeJobs({ run: sdk.run, model: 'claude-server', idleCloseMs: 0 })
    const a = await finished(jobs, jobs.start({ prompt: 'a' }).id)
    expect(sdk.queries[0].options.model).toBe('claude-server')
    await new Promise((resolve) => setTimeout(resolve, 10))
    // 閉じた会話を続けるときは、選んだモデルで立てる
    await finished(jobs, jobs.start({ prompt: 'b', threadId: a.threadId, model: 'haiku', effort: 'low' }).id)
    expect(sdk.queries).toHaveLength(2)
    expect(sdk.queries[1].options).toMatchObject({ resume: 's1', model: 'haiku', effort: 'low' })
    expect(sdk.queries[1].log).toEqual(['send:b'])
  })

  it('lists the models Claude Code offers, without its own default row, and names the model the default runs (MAI-106)', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'canvcode-claude-models-'))
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }))
    const sdk = fakeSdk({ linger: true })
    const jobs = makeJobs({ run: sdk.run, workspace })
    // 設定がなければ、Claude Code の組み込みの既定（'default' の行の説明）
    const catalog = await jobs.models()
    expect(catalog.fromClaude).toBe(true)
    expect(catalog.models).toEqual([
      { value: 'opus', label: 'Opus 5.5', description: 'For complex work', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: 'Fastest', efforts: [] },
      { value: 'claude-opus-4-6', label: 'Opus 4.6', description: 'Older', efforts: ['low', 'medium', 'high', 'max'] },
    ])
    expect(catalog.default).toEqual({ label: 'Fable 5.2' })
    // 一覧を聞くだけのプロセスは、ツールも MCP も使わず、すぐ閉じる。2 回目は覚えた一覧を使う
    expect(sdk.queries).toHaveLength(1)
    expect(sdk.queries[0].options).toMatchObject({ cwd: workspace, tools: [], mcpServers: {}, strictMcpConfig: true, settingSources: ['project'] })
    expect(sdk.queries[0].aborted).toBe(true)
    expect(sdk.queries[0].sent).toEqual([])
    // ワークスペースの .claude/settings.json の model が既定
    mkdirSync(join(workspace, '.claude'))
    writeFileSync(join(workspace, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }))
    expect((await jobs.models()).default).toEqual({ value: 'opus', label: 'Opus 5.5' })
    writeFileSync(join(workspace, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus-5-5' }))
    expect((await jobs.models()).default).toEqual({ value: 'claude-opus-5-5', label: 'Opus 5.5' })
    expect(sdk.queries).toHaveLength(1)
    // サーバーの CANVCODE_CLAUDE_MODEL があれば、それが既定
    const server = makeJobs({ run: fakeSdk({ linger: true }).run, workspace, model: 'claude-unknown' })
    expect((await server.models()).default).toEqual({ value: 'claude-unknown', label: 'claude-unknown' })
  })

  it('falls back to opus, sonnet and haiku when Claude Code cannot list the models, and asks again later (MAI-106)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      let calls = 0
      const failing: RunQuery = () => {
        calls++
        throw new Error('no claude')
      }
      const jobs = makeJobs({ run: failing })
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const catalog = await jobs.models()
      expect(catalog.fromClaude).toBe(false)
      expect(catalog.models.map((m) => m.value)).toEqual(['opus', 'sonnet', 'haiku'])
      await jobs.models()
      expect(calls).toBe(1)
      vi.advanceTimersByTime(MODEL_PROBE_RETRY_MS)
      await jobs.models()
      expect(calls).toBe(2)
      spy.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets Claude use subagents, showing their tool uses and denials but not their text', async () => {
    const sub = { parent_tool_use_id: 'a1' }
    const sdk = replying(() => [
      assistant('s1', [{ type: 'tool_use', name: 'Agent', input: { description: '論文を探す', prompt: '...' } }]),
      assistant('s1', [{ type: 'text', text: '途中の考え' }], sub),
      assistant('s1', [{ type: 'tool_use', name: 'WebSearch', input: { query: 'canvas' } }], sub),
      { type: 'system', subtype: 'permission_denied', session_id: 's1', tool_name: 'Bash', tool_use_id: 't1', agent_id: 'x', decision_reason: 'no', message: 'denied' } as unknown as SDKMessage,
      assistant('s1', [{ type: 'text', text: '見つけました' }]),
    ])
    const jobs = makeJobs({ run: sdk.run })
    const done = await finished(jobs, jobs.start({ prompt: '探して' }).id)
    expect(done.events).toEqual([
      { kind: 'tool', name: 'Agent', detail: '論文を探す' },
      { kind: 'tool', name: 'WebSearch', detail: 'canvas' },
      { kind: 'denied', name: 'Bash', reason: 'no' },
      { kind: 'text', text: '見つけました' },
    ])
  })

  it('shows background tasks, lets the user talk while they run, and continues on its own when they finish', async () => {
    const sdk = fakeSdk()
    const jobs = makeJobs({ run: sdk.run })
    const changes: JobChange[] = []
    jobs.subscribe((change) => changes.push(change))
    const a = jobs.start({ prompt: '調べて' })
    const q = await queryAt(sdk, 0)
    await vi.waitFor(() => expect(q.sent).toHaveLength(1))
    q.emit(
      init('s1'),
      assistant('s1', [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { description: '論文を探す' } }]),
      tasksChanged([{ id: 'ag1', description: '論文を探す' }, { id: 'w1', description: '見張り', ambient: true }]),
      taskStarted('ag1', '論文を探す', { tool_use_id: 'tu1' }),
      // 前景の作業は知らせない
      taskStarted('fg1', 'wc', { is_backgrounded: false }),
      success('s1', 0.01),
    )
    const first = await finished(jobs, a.id)
    expect(first.status).toBe('done')
    expect(first.events).toEqual([
      { kind: 'tool', name: 'Agent', detail: '論文を探す' },
      { kind: 'task', status: 'started', description: '論文を探す' },
    ])
    expect(jobs.thread(a.threadId)!.thread.tasks).toEqual([{ id: 'ag1', description: '論文を探す', type: 'local_agent' }])
    expect(changes).toContainEqual({ type: 'thread', thread: expect.objectContaining({ threadId: a.threadId, tasks: [expect.objectContaining({ id: 'ag1' })] }) })

    // 作業が動いているあいだも話しかけられる。バックグラウンドのサブエージェントの中の動きは出さない
    const b = jobs.start({ prompt: 'その間に一言', threadId: a.threadId })
    await vi.waitFor(() => expect(q.sent).toHaveLength(2))
    q.emit(
      init('s1'),
      assistant('s1', [{ type: 'tool_use', name: 'WebSearch', input: { query: 'x' } }], { parent_tool_use_id: 'tu1' }),
      assistant('s1', [{ type: 'text', text: 'はい' }]),
      success('s1', 0.02),
    )
    expect((await finished(jobs, b.id)).events).toEqual([{ kind: 'text', text: 'はい' }])

    // 作業が終わり、Claude が自分で続ける
    q.emit(taskDone('ag1'), tasksChanged([]), init('s1'), assistant('s1', [{ type: 'text', text: '見つかりました' }]), success('s1', 0.05))
    await vi.waitFor(() => expect(jobs.thread(a.threadId)!.jobs).toHaveLength(3))
    const background = jobs.thread(a.threadId)!.jobs[2]
    const done = await finished(jobs, background.id)
    expect(done).toMatchObject({ origin: 'background', prompt: 'バックグラウンドの作業「論文を探す」が終わりました', status: 'done' })
    expect(done.costUsd).toBeCloseTo(0.03)
    expect(done.events).toEqual([
      { kind: 'task', status: 'completed', description: '論文を探す' },
      { kind: 'text', text: '見つかりました' },
    ])
    expect(jobs.thread(a.threadId)!.thread.tasks).toEqual([])
    expect(sdk.queries).toHaveLength(1)
  })

  it('stops one background task, or the whole process', async () => {
    const sdk = fakeSdk()
    const jobs = makeJobs({ run: sdk.run })
    const a = jobs.start({ prompt: 'a' })
    const q = await queryAt(sdk, 0)
    await vi.waitFor(() => expect(q.sent).toHaveLength(1))
    q.emit(init('s1'), tasksChanged([{ id: 'ag1', description: '探す' }]), taskStarted('ag1', '探す'), success('s1'))
    await finished(jobs, a.id)
    await jobs.stopTask(a.threadId, 'ag1')
    expect(q.stopped).toEqual(['ag1'])
    await expect(jobs.stopTask(a.threadId, 'nope')).rejects.toThrow(/もう動いていません/)

    const b = jobs.start({ prompt: 'b', threadId: a.threadId })
    await vi.waitFor(() => expect(q.sent).toHaveLength(2))
    q.emit(init('s1'))
    await jobs.stopThread(a.threadId)
    expect(q.aborted).toBe(true)
    expect((await finished(jobs, b.id)).status).toBe('cancelled')
    expect(jobs.thread(a.threadId)!.thread.tasks).toEqual([])
    await expect(jobs.stopThread('00000000-0000-0000-0000-000000000000')).rejects.toThrow(/もうありません/)
  })

  it('closes an idle process, and resumes the thread in a new one', async () => {
    const sdk = replying()
    const jobs = makeJobs({ run: sdk.run, idleCloseMs: 0 })
    const a = await finished(jobs, jobs.start({ prompt: 'a' }).id)
    await new Promise((resolve) => setTimeout(resolve, 10))
    // 入れ物を閉じて終わらせた（止めてはいない）
    expect(sdk.queries[0].aborted).toBe(false)
    const b = await finished(jobs, jobs.start({ prompt: 'b', threadId: a.threadId }).id)
    expect(b.status).toBe('done')
    expect(sdk.queries).toHaveLength(2)
    expect(sdk.queries[1].options.resume).toBe('s1')
  })

  it('does not close an idle process while it has background tasks', async () => {
    const sdk = fakeSdk({ linger: true })
    const jobs = makeJobs({ run: sdk.run, idleCloseMs: 0 })
    const a = jobs.start({ prompt: 'a' })
    const q = await queryAt(sdk, 0)
    await vi.waitFor(() => expect(q.sent).toHaveLength(1))
    q.emit(init('s1'), tasksChanged([{ id: 'ag1', description: '探す' }]), success('s1'))
    await finished(jobs, a.id)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(q.aborted).toBe(false)
    jobs.start({ prompt: 'b', threadId: a.threadId })
    await vi.waitFor(() => expect(q.sent).toHaveLength(2))
    expect(sdk.queries).toHaveLength(1)
  })

  it(`keeps at most ${MAX_SESSIONS} processes, closing idle ones first`, async () => {
    const sdk = fakeSdk({ linger: true })
    const jobs = makeJobs({ run: sdk.run, closeGraceMs: 0 })
    for (let i = 0; i < MAX_SESSIONS; i++) {
      const job = jobs.start({ prompt: `t${i}` })
      const q = await queryAt(sdk, i)
      await vi.waitFor(() => expect(q.sent).toHaveLength(1))
      // 最初の会話だけ何もしていない。ほかはバックグラウンドの作業がある
      q.emit(init(`s${i}`), ...(i === 0 ? [] : [tasksChanged([{ id: `ag${i}`, description: 'x' }])]), success(`s${i}`))
      await finished(jobs, job.id)
    }
    const extra = jobs.start({ prompt: 'new' })
    await vi.waitFor(() => expect(sdk.queries[0].aborted).toBe(true))
    expect(sdk.queries.slice(1, MAX_SESSIONS).every((q) => !q.aborted)).toBe(true)
    const q = await queryAt(sdk, MAX_SESSIONS)
    q.emit(init('s9'), tasksChanged([{ id: 'ag9', description: 'x' }]), success('s9'))
    await finished(jobs, extra.id)
    expect(() => jobs.start({ prompt: 'one more' })).toThrow(/開いておける会話/)
  })

  it('keeps jobs in SQLite, and continues a thread with its last session after a restart', async () => {
    const dir = dataDir()
    const store = openStore(dir)
    const first = makeJobs({ store, run: replying(() => [assistant('s1', [{ type: 'text', text: 'はい' }])]).run })
    const a = first.start({ prompt: 'a' })
    await finished(first, a.id)
    await first.dispose()
    store.close()

    // 再起動：同じ claude.db を開き直す
    const reopened = openStore(dir)
    const sdk = replying(() => [], 's2')
    const jobs = makeJobs({ store: reopened, run: sdk.run })
    expect(jobs.threads()).toMatchObject([{ threadId: a.id, title: 'a', jobCount: 1, running: false, tasks: [] }])
    expect(jobs.get(a.id)!.events).toEqual([{ kind: 'text', text: 'はい' }])

    const b = jobs.start({ prompt: 'b', threadId: a.threadId })
    await finished(jobs, b.id)
    expect(sdk.queries[0].options.resume).toBe('s1')
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
    makeJobs({ store, run: fakeSdk().run })
    expect(store.job('j1')).toMatchObject({
      status: 'failed',
      events: [
        { kind: 'text', text: '途中' },
        { kind: 'error', message: INTERRUPTED_MESSAGE },
      ],
    })
  })

  it('refuses to continue a thread while its last job is running, and limits running jobs', () => {
    const jobs = makeJobs({ run: fakeSdk().run })
    const started = Array.from({ length: MAX_RUNNING }, () => jobs.start({ prompt: 'x' }))
    expect(() => jobs.start({ prompt: 'y', threadId: started[0].threadId })).toThrow(/まだ終わっていません/)
    expect(() => jobs.start({ prompt: 'y' })).toThrow(/同時に/)
  })

  it('cancels only the current turn, keeping the process and its background tasks', async () => {
    const sdk = fakeSdk({ onInterrupt: (q) => q.emit(interrupted('s1')) })
    const jobs = makeJobs({ run: sdk.run })
    const job = jobs.start({ prompt: 'x' })
    const q = await queryAt(sdk, 0)
    await vi.waitFor(() => expect(q.sent).toHaveLength(1))
    q.emit(init('s1'), tasksChanged([{ id: 'ag1', description: '探す' }]), assistant('s1', [{ type: 'text', text: '途中' }]))
    await until(jobs, job.id, (j) => j.events.length > 0)
    jobs.cancel(job.id)
    const done = await finished(jobs, job.id)
    expect(done.status).toBe('cancelled')
    expect(done.events).toEqual([{ kind: 'text', text: '途中' }])
    expect(q.interrupts).toEqual([{ cancelQueued: false }])
    expect(q.aborted).toBe(false)
    expect(jobs.thread(job.threadId)!.thread.tasks).toHaveLength(1)
  })

  it('stops the process when a cancelled turn does not end', async () => {
    const sdk = fakeSdk()
    const jobs = makeJobs({ run: sdk.run, cancelGraceMs: 0 })
    const job = jobs.start({ prompt: 'x' })
    const q = await queryAt(sdk, 0)
    await vi.waitFor(() => expect(q.sent).toHaveLength(1))
    q.emit(init('s1'), assistant('s1', [{ type: 'text', text: '途中' }]))
    await until(jobs, job.id, (j) => j.events.length > 0)
    jobs.cancel(job.id)
    expect((await finished(jobs, job.id)).status).toBe('cancelled')
    expect(q.aborted).toBe(true)
  })

  it('answers a request with the turn stamped with it, even after a turn Claude Code started by itself (as after a resume)', async () => {
    const sdk = fakeSdk()
    const jobs = makeJobs({ run: sdk.run })
    const a = jobs.start({ prompt: 'a' })
    const q = await queryAt(sdk, 0)
    await vi.waitFor(() => expect(q.sent).toHaveLength(1))
    // 前のプロセスで途切れた作業の知らせから、CLI が先にターンを起こす。答えを書かなければジョブにしない
    q.emitMeta(init('s1'), success('s1', 0.01))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(jobs.get(a.id)!.status).toBe('running')
    // 書いたら、バックグラウンドのジョブにする。その途中に依頼が混ぜられたら、そこからは依頼のジョブ
    q.emitMeta(init('s1'), assistant('s1', [{ type: 'text', text: '途切れた作業がありました' }]))
    q.emit(assistant('s1', [{ type: 'text', text: 'aです' }]), success('s1', 0.03))
    const done = await finished(jobs, a.id)
    expect(done.events).toEqual([{ kind: 'text', text: 'aです' }])
    const all = jobs.thread(a.threadId)!.jobs
    expect(all.map((job) => [job.origin ?? 'user', job.status, job.events.length])).toEqual([
      ['user', 'done', 1],
      ['background', 'done', 1],
    ])
  })

  it('cancels a request that is still waiting for its turn, and hides that turn if it comes anyway', async () => {
    const sdk = fakeSdk()
    const jobs = makeJobs({ run: sdk.run })
    const a = jobs.start({ prompt: 'a' })
    const q = await queryAt(sdk, 0)
    await vi.waitFor(() => expect(q.sent).toHaveLength(1))
    q.emitMeta(init('s1'))
    jobs.cancel(a.id)
    expect((await finished(jobs, a.id)).status).toBe('cancelled')
    expect(q.interrupts).toEqual([{ cancelQueued: true }])
    // 取り消しが間に合わずにターンが来たら、止めて見せない
    q.emit(assistant('s1', [{ type: 'text', text: 'aです' }]), success('s1'))
    await vi.waitFor(() => expect(q.interrupts).toHaveLength(2))
    expect(jobs.thread(a.threadId)!.jobs).toHaveLength(1)
    expect(jobs.get(a.id)!.events).toEqual([])
    // 次の依頼は送れる
    const b = jobs.start({ prompt: 'b', threadId: a.threadId })
    await vi.waitFor(() => expect(q.sent).toHaveLength(2))
    q.emit(init('s1'), assistant('s1', [{ type: 'text', text: 'bです' }]), success('s1'))
    expect((await finished(jobs, b.id)).events).toEqual([{ kind: 'text', text: 'bです' }])
  })

  it('counts the cost of a resumed process from where the previous one ended', async () => {
    const store = openStore()
    const sdk = replying()
    const jobs = makeJobs({ run: sdk.run, store, idleCloseMs: 0 })
    const a = await finished(jobs, jobs.start({ prompt: 'a' }).id)
    expect(a.costUsd).toBeCloseTo(0.01)
    await new Promise((resolve) => setTimeout(resolve, 10))
    // resume したプロセスの total_cost_usd は、前のプロセスの合計（0.01）から続く。同じサーバーなら、そこから数える
    const b = await finished(jobs, jobs.start({ prompt: 'b', threadId: a.threadId }).id)
    expect(sdk.queries).toHaveLength(2)
    expect(sdk.queries[1].options.resume).toBe('s1')
    expect(b.costUsd).toBeCloseTo(0.01)
    await jobs.dispose()
    // 前の合計を知らない（サーバーを再起動した）なら、最初のターンの費用は出さない
    const restarted = makeJobs({ run: fakeSdk({ reply: (q) => q.emit(init('s1'), success('s1', 0.05)) }).run, store })
    const c = await finished(restarted, restarted.start({ prompt: 'c', threadId: a.threadId }).id)
    expect(c.status).toBe('done')
    expect(c.costUsd).toBeUndefined()
  })

  it('waits for the previous process of a thread to end, and cancels a job without starting it', async () => {
    const sdk = fakeSdk({ linger: true, reply: (q) => q.emit(init('s1'), success('s1')) })
    const jobs = makeJobs({ run: sdk.run, idleCloseMs: 0, closeGraceMs: 60_000 })
    const a = await finished(jobs, jobs.start({ prompt: 'a' }).id)
    // 閉じようとしているが、まだ終わらない（linger）
    await new Promise((resolve) => setTimeout(resolve, 10))
    const b = jobs.start({ prompt: 'b', threadId: a.threadId })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sdk.queries).toHaveLength(1)
    jobs.cancel(b.id)
    sdk.queries[0].end()
    expect((await finished(jobs, b.id)).status).toBe('cancelled')
    expect(sdk.queries).toHaveLength(1)
  })

  it('reports a process that ended by itself, and the background tasks it took with it', async () => {
    const sdk = fakeSdk()
    const jobs = makeJobs({ run: sdk.run })
    const a = jobs.start({ prompt: 'a' })
    const q = await queryAt(sdk, 0)
    await vi.waitFor(() => expect(q.sent).toHaveLength(1))
    q.emit(init('s1'), tasksChanged([{ id: 'ag1', description: '探す' }]), success('s1'))
    await finished(jobs, a.id)
    const b = jobs.start({ prompt: 'b', threadId: a.threadId })
    await vi.waitFor(() => expect(q.sent).toHaveLength(2))
    q.fail(new Error('claude crashed'))
    const failed = await finished(jobs, b.id)
    expect(failed.status).toBe('failed')
    await vi.waitFor(() =>
      expect(jobs.get(b.id)!.events).toEqual([
        { kind: 'error', message: 'claude crashed' },
        { kind: 'error', message: 'Claude Code のプロセスが終わったので、バックグラウンドの作業 1 個が途切れました' },
      ]),
    )
    expect(jobs.thread(a.threadId)!.thread.tasks).toEqual([])
  })

  it('deletes a thread and its Claude Code sessions, but not while it runs or has background tasks', async () => {
    const deleted: string[] = []
    const store = openStore()
    let jobs = makeJobs({ store, run: replying().run, deleteSession: async (id) => void deleted.push(id) })
    const a = jobs.start({ prompt: 'a' })
    await finished(jobs, a.id)
    const changes: JobChange[] = []
    jobs.subscribe((change) => changes.push(change))
    await jobs.deleteThread(a.threadId)
    expect(jobs.threads()).toEqual([])
    expect(deleted).toEqual(['s1'])
    expect(changes).toContainEqual({ type: 'thread-deleted', threadId: a.threadId })
    await expect(jobs.deleteThread(a.threadId)).rejects.toThrow(/もうありません/)

    const sdk = fakeSdk()
    jobs = makeJobs({ store, run: sdk.run })
    const b = jobs.start({ prompt: 'b' })
    await expect(jobs.deleteThread(b.threadId)).rejects.toThrow(/動いている/)
    const q = await queryAt(sdk, 0)
    q.emit(init('s2'), tasksChanged([{ id: 'ag1', description: '探す' }]), success('s2'))
    await finished(jobs, b.id)
    await expect(jobs.deleteThread(b.threadId)).rejects.toThrow(/バックグラウンドの作業/)
  })

  it('stops every process when disposed', async () => {
    const sdk = fakeSdk({ linger: true })
    const jobs = new ClaudeJobs({ workspace: WS, mcpUrl: 'http://127.0.0.1:1/mcp', store: openStore(), run: sdk.run })
    const job = jobs.start({ prompt: 'a' })
    const q = await queryAt(sdk, 0)
    q.emit(init('s1'))
    await jobs.dispose()
    expect(q.aborted).toBe(true)
    expect(jobs.get(job.id)!.status).toBe('cancelled')
  })

  it('reports errors: a failed run, an error result, a missing login, an MCP that did not connect, no auto mode', async () => {
    const failing = fakeSdk({ reply: (q) => (q.emit(init('s1')), q.fail(new Error('spawn claude ENOENT'))) })
    let jobs = makeJobs({ run: failing.run })
    let done = await finished(jobs, jobs.start({ prompt: 'x' }).id)
    expect(done.status).toBe('failed')
    expect(done.events).toEqual([{ kind: 'error', message: 'spawn claude ENOENT' }])

    const maxTurns = { type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's1', total_cost_usd: 0, duration_ms: 1, errors: [] }
    jobs = makeJobs({
      run: fakeSdk({
        reply: (q) => q.emit(init('s1', { mcp: 'failed', mode: 'default' }), assistant('s1', [], { error: 'authentication_failed' }), maxTurns as unknown as SDKMessage),
      }).run,
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
    const sdk = fakeSdk({ reply: (q) => q.emit(init('s1'), overBudget as unknown as SDKMessage) })
    const jobs = makeJobs({ run: sdk.run, ...claudeLimitsFromEnv({ CANVCODE_CLAUDE_MAX_TURNS: '250', CANVCODE_CLAUDE_MAX_BUDGET_USD: '2.5' }) })
    const done = await finished(jobs, jobs.start({ prompt: 'x' }).id)
    expect(sdk.queries[0].options.maxTurns).toBe(250)
    expect(sdk.queries[0].options.maxBudgetUsd).toBe(2.5)
    expect(done.status).toBe('failed')
    expect(done.events).toEqual([{ kind: 'error', message: '費用の上限（$2.5）に達したので止めました。同じ会話で続けて頼めば、続きから進めます' }])
    // 上限に達したプロセスは閉じ、次の依頼は新しいプロセスで続ける
    jobs.start({ prompt: 'y', threadId: done.threadId })
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(2))
    expect(sdk.queries[1].options.resume).toBe('s1')

    const maxTurns = { type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's2', total_cost_usd: 0, duration_ms: 1, errors: [] }
    const turns = makeJobs({ run: fakeSdk({ reply: (q) => q.emit(init('s2'), maxTurns as unknown as SDKMessage) }).run, maxTurns: 250 })
    const stopped = await finished(turns, turns.start({ prompt: 'x' }).id)
    expect(stopped.events).toEqual([{ kind: 'error', message: 'ターン数の上限（250）に達したので止めました。同じ会話で続けて頼めば、続きから進めます' }])
  })

  it('records denials: by the guard hook, by the auto mode classifier, and of a tool the panel does not offer', async () => {
    const decisions: unknown[] = []
    const sdk = fakeSdk({
      reply: (q) =>
        void (async () => {
          q.emit(init('s1'))
          const hook = q.options.hooks!.PreToolUse![0].hooks[0] as HookCallback
          const signal = new AbortController().signal
          decisions.push(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/etc/passwd' } } as never, 't1', { signal }))
          decisions.push(await hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__canvcode__edit_canvas', tool_input: {} } as never, 't2', { signal }))
          decisions.push(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } } as never, 't3', { signal }))
          q.emit({ type: 'system', subtype: 'permission_denied', session_id: 's1', tool_name: 'Bash', tool_use_id: 't4', decision_reason: 'rm outside the workspace', message: 'denied' } as unknown as SDKMessage)
          await vi.waitFor(() => expect(jobs.runningJobs()[0]?.events).toHaveLength(2))
          decisions.push(await q.options.canUseTool!('NotebookEdit', {}, { signal, toolUseID: 't5' } as never))
          q.emit(success('s1'))
        })(),
    })
    const jobs = makeJobs({ run: sdk.run })
    const done = await finished(jobs, jobs.start({ prompt: 'x' }).id)
    expect(decisions).toEqual([
      { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('外には書けません') } },
      { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } },
      {},
      { behavior: 'deny', message: expect.stringContaining('使えません') },
    ])
    expect(done.events).toEqual([
      { kind: 'denied', name: 'Write', reason: expect.stringContaining('外には書けません') },
      { kind: 'denied', name: 'Bash', reason: 'rm outside the workspace' },
      { kind: 'denied', name: 'NotebookEdit', reason: expect.stringContaining('使えません') },
    ])
  })

  describe('asking the user in the panel (docs/claude-permissions-plan.md の段階 2)', () => {
    // 1 つの依頼を始め、ターンの初め（init と、ツールを呼ぶ前の文章）まで流した偽の SDK と、canUseTool を呼ぶ関数。
    // 本物でも、canUseTool はターンの assistant のあとに来る（そこで今のジョブが決まる）
    async function asking(deps: Partial<ClaudeJobsDeps> = {}) {
      const sdk = fakeSdk({ linger: true })
      const jobs = makeJobs({ run: sdk.run, ...deps })
      const job = jobs.start({ prompt: 'ビルドを消して' })
      const q = await queryAt(sdk, 0)
      // 送った依頼を偽の SDK が受け取ってから流す（受け取ったメッセージの uuid がターンに付く）
      await vi.waitFor(() => expect(q.sent).toHaveLength(1))
      q.emit(init('s1'), assistant('s1', [{ type: 'text', text: '消します' }]))
      await vi.waitFor(() => expect(jobs.get(job.id)!.events).toHaveLength(1))
      const controller = new AbortController()
      const canUseTool = (name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}, signal = controller.signal) =>
        q.options.canUseTool!(name, input, { signal, toolUseID: 't', requestId: 'r', ...extra } as never) as Promise<{ behavior: string; message?: string; updatedInput?: unknown }>
      const pending = () => jobs.threads()[0]!.permissions
      const waitPending = (n: number) => vi.waitFor(() => expect(pending()).toHaveLength(n))
      return { sdk, jobs, job, q, controller, canUseTool, pending, waitPending }
    }

    it('shows the question on the thread, and allows the call with its input when the user approves', async () => {
      const { jobs, job, q, canUseTool, pending, waitPending } = await asking()
      const threads: number[] = []
      jobs.subscribe((change) => {
        if (change.type === 'thread') threads.push(change.thread.permissions.length)
      })
      const answer = canUseTool('Bash', { command: 'rm -rf build && echo done' }, { description: 'ビルドを消す' })
      await waitPending(1)
      const [p] = pending()
      expect(p).toMatchObject({ jobId: job.id, name: 'Bash', detail: 'rm -rf build && echo done', description: 'ビルドを消す' })
      expect(p!.expiresAt - p!.createdAt).toBe(10 * 60_000)
      expect(jobs.thread(job.threadId)!.thread.permissions).toHaveLength(1)
      jobs.answerPermission(job.threadId, p!.id, 'allow')
      expect(await answer).toEqual({ behavior: 'allow', updatedInput: { command: 'rm -rf build && echo done' } })
      expect(pending()).toEqual([])
      expect(threads).toEqual([1, 0])
      // 2 回目の答え・知らない id・違う会話は 404
      expect(() => jobs.answerPermission(job.threadId, p!.id, 'deny')).toThrow(/もうありません/)
      expect(() => jobs.answerPermission(job.threadId, '00000000-0000-0000-0000-000000000000', 'allow')).toThrow(/もうありません/)
      q.emit(success('s1'))
      const done = await finished(jobs, job.id)
      expect(done.events).toEqual([
        { kind: 'text', text: '消します' },
        { kind: 'ask', id: p!.id, name: 'Bash', detail: 'rm -rf build && echo done' },
        { kind: 'answer', id: p!.id, result: 'allowed' },
      ])
    })

    it('denies with words for Claude when the user declines, and when nobody answers in time', async () => {
      const { jobs, job, canUseTool, pending, waitPending } = await asking({ permissionTimeoutMs: 30 })
      const declined = canUseTool('Bash', { command: 'git push' })
      await waitPending(1)
      jobs.answerPermission(job.threadId, pending()[0]!.id, 'deny')
      expect(await declined).toEqual({ behavior: 'deny', message: expect.stringContaining('ユーザーが画面で断りました') })
      const expired = await canUseTool('Bash', { command: 'git push --force' })
      expect(expired).toEqual({ behavior: 'deny', message: expect.stringContaining('誰も許可しなかった') })
      expect(pending()).toEqual([])
      expect(jobs.get(job.id)!.events.filter((event) => event.kind === 'answer').map((event) => (event as { result: string }).result)).toEqual(['denied', 'expired'])
    })

    it('cancels the question when the SDK aborts it, when the job or the thread is stopped, and when a subagent is stopped', async () => {
      const { sdk, jobs, job, q, canUseTool, pending, waitPending } = await asking()
      // SDK の signal（interrupt など）
      const aborted = new AbortController()
      const bySignal = canUseTool('Bash', { command: 'a' }, {}, aborted.signal)
      await waitPending(1)
      aborted.abort()
      expect(await bySignal).toMatchObject({ behavior: 'deny' })
      // サブエージェントの作業を止める
      q.emit(taskStarted('a1', '調べる'), tasksChanged([{ id: 'a1', description: '調べる' }]))
      await vi.waitFor(() => expect(jobs.threads()[0]!.tasks).toHaveLength(1))
      const bySubagent = canUseTool('Bash', { command: 'b' }, { agentID: 'a1' })
      await waitPending(1)
      expect(pending()[0]!.agent).toBe('調べる')
      await jobs.stopTask(job.threadId, 'a1')
      expect(await bySubagent).toMatchObject({ behavior: 'deny' })
      expect(q.stopped).toEqual(['a1'])
      // ジョブの「止める」
      const byCancel = canUseTool('Bash', { command: 'c' })
      await waitPending(1)
      jobs.cancel(job.id)
      expect(await byCancel).toMatchObject({ behavior: 'deny' })
      expect(pending()).toEqual([])
      expect(jobs.get(job.id)!.events.filter((event) => event.kind === 'answer').map((event) => (event as { result: string }).result)).toEqual([
        'cancelled',
        'cancelled',
        'cancelled',
      ])
      // 会話の「全部止める」（次の依頼で、新しいプロセスに尋ねさせる）
      q.emit(interrupted('s1'))
      await finished(jobs, job.id)
      const next = jobs.start({ prompt: 'もう一度', threadId: job.threadId })
      const q2 = await queryAt(sdk, 0)
      expect(q2).toBe(q)
      const byStop = q.options.canUseTool!('Bash', { command: 'd' }, { signal: new AbortController().signal, toolUseID: 't', requestId: 'r' } as never)
      await waitPending(1)
      await jobs.stopThread(job.threadId)
      expect(await byStop).toMatchObject({ behavior: 'deny' })
      expect(jobs.threads()[0]!.permissions).toEqual([])
      expect((await finished(jobs, next.id)).status).toBe('cancelled')
    })

    it('asks about a listed tool that an ask rule forced, by matchedAskRule or by decisionReasonType', async () => {
      const { jobs, job, canUseTool, pending, waitPending } = await asking()
      const write = { file_path: `${WS}/notes/a.md`, content: 'x' }
      const byType = canUseTool('Write', write, { matchedAskRule: { source: 'projectSettings', toolName: 'Write' } })
      await waitPending(1)
      expect(pending()[0]!.reason).toContain('permissions.ask')
      jobs.answerPermission(job.threadId, pending()[0]!.id, 'allow')
      expect(await byType).toMatchObject({ behavior: 'allow' })
      const byUntyped = canUseTool('Write', write, { decisionReasonType: 'rule' })
      await waitPending(1)
      jobs.answerPermission(job.threadId, pending()[0]!.id, 'deny')
      expect(await byUntyped).toMatchObject({ behavior: 'deny' })
      // 規則でなければ、今どおり許す
      expect(await canUseTool('Write', write, { decisionReasonType: 'workingDir' })).toMatchObject({ behavior: 'allow' })
    })

    it('puts a question from a background subagent on the last job of the thread, and keeps the process open while it waits', async () => {
      const { jobs, job, q, canUseTool, pending, waitPending } = await asking({ idleCloseMs: 10 })
      q.emit(taskStarted('a1', '裏で調べる'), tasksChanged([{ id: 'a1', description: '裏で調べる' }]))
      q.emit(success('s1'))
      await finished(jobs, job.id)
      await vi.waitFor(() => expect(jobs.threads()[0]!.tasks).toHaveLength(1))
      const answer = canUseTool('Bash', { command: 'ls /srv' }, { agentID: 'a1' })
      await waitPending(1)
      expect(pending()[0]!.jobId).toBeUndefined()
      // 作業の一覧が空になっても（作業が残っていると、どのみち閉じない）、問い合わせを待っているあいだは閉じない
      q.emitMeta(tasksChanged([]))
      await vi.waitFor(() => expect(jobs.threads()[0]!.tasks).toEqual([]))
      await new Promise((resolve) => setTimeout(resolve, 40))
      // 待っているあいだは閉じない（閉じていれば、取り消しになって一覧から消える）
      expect(pending()).toHaveLength(1)
      jobs.answerPermission(job.threadId, pending()[0]!.id, 'allow')
      expect(await answer).toMatchObject({ behavior: 'allow' })
      const last = jobs.get(job.id)!
      expect(last.events.slice(-2)).toEqual([
        { kind: 'ask', id: expect.any(String), name: 'Bash', detail: 'ls /srv', agent: '裏で調べる' },
        { kind: 'answer', id: expect.any(String), result: 'allowed' },
      ])
    })

    it('denies at once beyond the limit of waiting questions in a thread', async () => {
      const { jobs, job, canUseTool, waitPending } = await asking()
      const waiting = Array.from({ length: MAX_PENDING_PERMISSIONS }, (_, i) => canUseTool('Bash', { command: `echo ${i}` }))
      await waitPending(MAX_PENDING_PERMISSIONS)
      expect(await canUseTool('Bash', { command: 'echo one more' })).toEqual({ behavior: 'deny', message: TOO_MANY_PERMISSIONS })
      expect(jobs.get(job.id)!.events.at(-1)).toEqual({ kind: 'denied', name: 'Bash', reason: TOO_MANY_PERMISSIONS })
      expect(TOO_MANY_PERMISSIONS).toContain('待っている許可が多すぎます')
      // サーバーを止めると、待っていたものは取り消しになる
      await jobs.dispose()
      for (const answer of await Promise.all(waiting)) expect(answer).toMatchObject({ behavior: 'deny' })
    })

    it('counts a job waiting for an answer as running', async () => {
      const { jobs, canUseTool, waitPending } = await asking()
      void canUseTool('Bash', { command: 'make' })
      await waitPending(1)
      const sdk2 = jobs.start({ prompt: '2 つめ' })
      expect(sdk2.status).toBe('running')
      expect(() => jobs.start({ prompt: '3 つめ' })).toThrow(/許可を待っている依頼があれば、答えると進みます/)
    })

    it('says Bash will ask every time when auto mode is not available', async () => {
      const sdk = fakeSdk({ reply: (q) => q.emit(init('s1', { mode: 'default' }), success('s1')) })
      const jobs = makeJobs({ run: sdk.run })
      const done = await finished(jobs, jobs.start({ prompt: 'x' }).id)
      expect(done.events).toEqual([{ kind: 'error', message: 'auto mode が使えないので、Bash は毎回画面で許可を求めます（default で動いています）' }])
    })

    it('reads the timeout from CANVCODE_CLAUDE_PERMISSION_TIMEOUT_MS', () => {
      expect(claudeLimitsFromEnv({ CANVCODE_CLAUDE_PERMISSION_TIMEOUT_MS: '15000' }).permissionTimeoutMs).toBe(15000)
      expect(claudeLimitsFromEnv({ CANVCODE_CLAUDE_PERMISSION_TIMEOUT_MS: '-1' }).permissionTimeoutMs).toBeUndefined()
      expect(claudeLimitsFromEnv({}).permissionTimeoutMs).toBeUndefined()
    })
  })

  it('notifies listeners with the new events and the thread', async () => {
    const jobs = makeJobs({ run: replying(() => [assistant('s1', [{ type: 'text', text: 'a' }])]).run })
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
    const jobs = makeJobs({ run: fakeSdk().run })
    expect(() => jobs.start({ prompt: '   ' })).toThrow(/空/)
    expect(() => jobs.start({ prompt: 'x'.repeat(20_001) })).toThrow(/長すぎ/)
  })
})
