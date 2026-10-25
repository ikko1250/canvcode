import { randomUUID } from 'node:crypto'
import { relative } from 'node:path'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { askTool, CANVCODE_MCP_PREFIX, CLAUDE_TOOLS, inside, preToolUseHook } from './permissions.ts'
import type { ClaudeStore, StoredJob, ThreadSummary } from './store.ts'

// 画面から頼んだ Claude Code の仕事（ジョブ）。
// - Claude Agent SDK の query() で、サーバーと同じマシンの Claude Code を動かす（認証は、そのマシンの claude のログインか API キー）
// - cwd はワークスペース。MCP は自分の /mcp（canvcode）だけをつなぐ。許し方は auto mode と claude/permissions.ts
// - ユーザーが選んだ場所は ref:XXXX としてプロンプトに添える（AI は resolve_reference で読む。手で貼り付けたときと同じ）
// - 届いたメッセージを、画面に見せる出来事（JobEvent）にして claude/store.ts（SQLite）に書き、購読者（/api/claude/events の SSE）に知らせる
// - 同じ会話（thread）の続きは、前のジョブの session_id を resume に渡して続ける（サーバーを再起動しても続けられる）
// - 動いているジョブはメモリにも持つ（止めるための AbortController）。起動したときに、途切れたジョブを止まったものにする

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled'

// 画面に見せる出来事
export type JobEvent =
  // Claude の文章（Markdown）
  | { kind: 'text'; text: string }
  // ツールを使った（detail は読んだファイル・コマンド・検索の語・Canvas の編集の label など）
  | { kind: 'tool'; name: string; detail?: string }
  // ツールを断った
  | { kind: 'denied'; name: string; reason: string }
  | { kind: 'error'; message: string }

export interface JobSummary {
  id: string
  // 会話の id（最初のジョブの id）
  threadId: string
  prompt: string
  refId?: string
  canvasId?: string
  status: JobStatus
  createdAt: number
  finishedAt?: number
  // Claude Code が見積もった費用（USD）と、かかった時間
  costUsd?: number
  durationMs?: number
  eventCount: number
}

export interface Job extends JobSummary {
  events: JobEvent[]
}

export interface StartRequest {
  prompt: string
  refId?: string
  canvasId?: string
  // 続ける会話（その会話の最後のジョブの session を使う）
  threadId?: string
}

// 変化。job は、ジョブが変わった（events はその変化で足した出来事。from 番目から）。thread-deleted は、会話を消した
export type JobChange =
  | { type: 'job'; job: JobSummary; events: JobEvent[]; from: number; thread: ThreadSummary }
  | { type: 'thread-deleted'; threadId: string }

export type JobListener = (change: JobChange) => void

export type RunQuery = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>

export class JobError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export const MAX_RUNNING = 2
export const MAX_PROMPT_LENGTH = 20_000
export const INTERRUPTED_MESSAGE = 'サーバーが止まったので途切れました'
// 1 回の依頼のターン数の上限（ツールを呼ぶたびに 1 ターン）。canvcode の MCP は 1 つの作業で何度も呼ぶので多めにする
export const DEFAULT_MAX_TURNS = 100

export interface ClaudeJobsDeps {
  workspace: string
  // canvcode の MCP の URL（http://127.0.0.1:8787/mcp）
  mcpUrl: string
  store: ClaudeStore
  // 既定は Agent SDK の query（使うときに読み込む）
  run?: RunQuery
  // 会話を消したときに、Claude Code の session（~/.claude/projects/ の transcript）も消す。既定は Agent SDK の deleteSession
  deleteSession?: (sessionId: string, dir: string) => Promise<void>
  model?: string
  // 既定は DEFAULT_MAX_TURNS
  maxTurns?: number
  // 1 回の依頼の費用の上限（ドル）。既定は付けない
  maxBudgetUsd?: number
}

// CANVCODE_CLAUDE_MAX_TURNS（正の整数）と CANVCODE_CLAUDE_MAX_BUDGET_USD（正の数）。使えない値なら既定のまま
export function claudeLimitsFromEnv(env: NodeJS.ProcessEnv): Pick<ClaudeJobsDeps, 'maxTurns' | 'maxBudgetUsd'> {
  const maxTurns = Number(env.CANVCODE_CLAUDE_MAX_TURNS)
  const maxBudgetUsd = Number(env.CANVCODE_CLAUDE_MAX_BUDGET_USD)
  return {
    ...(Number.isInteger(maxTurns) && maxTurns > 0 ? { maxTurns } : {}),
    ...(Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0 ? { maxBudgetUsd } : {}),
  }
}

interface JobState extends StoredJob {
  abort: AbortController
}

export class ClaudeJobs {
  private readonly deps: ClaudeJobsDeps
  private readonly store: ClaudeStore
  private readonly running = new Map<string, JobState>()
  // 動いている query（止めたあと、終わるのを待つため）
  private readonly executions = new Set<Promise<void>>()
  private readonly listeners = new Set<JobListener>()

  constructor(deps: ClaudeJobsDeps) {
    this.deps = deps
    this.store = deps.store
    const interrupted = this.store.interruptRunning(INTERRUPTED_MESSAGE)
    if (interrupted > 0) console.log(`途切れた Claude のジョブを止まったものにしました：${interrupted} 個`)
  }

  threads(): ThreadSummary[] {
    return this.store.threads()
  }

  thread(threadId: string): { thread: ThreadSummary; jobs: Job[] } | undefined {
    const thread = this.store.thread(threadId)
    if (!thread) return undefined
    return { thread, jobs: this.store.threadJobs(threadId).map((job) => publicJob(this.running.get(job.id) ?? job)) }
  }

  // 動いているジョブ（出来事も含む）
  runningJobs(): Job[] {
    return [...this.running.values()].map(publicJob)
  }

  get(id: string): Job | undefined {
    const job = this.running.get(id) ?? this.store.job(id)
    return job && publicJob(job)
  }

  subscribe(listener: JobListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(request: StartRequest): Job {
    const prompt = request.prompt.trim()
    if (!prompt) throw new JobError(400, 'プロンプトが空です')
    if (prompt.length > MAX_PROMPT_LENGTH) throw new JobError(400, `プロンプトが長すぎます（${MAX_PROMPT_LENGTH} 文字まで）`)
    let resume: string | undefined
    if (request.threadId) {
      const last = this.store.lastOfThread(request.threadId)
      if (!last) throw new JobError(404, 'その会話はもうありません')
      if (last.status === 'running') throw new JobError(409, '前の依頼がまだ終わっていません')
      resume = last.sessionId
    }
    if (this.running.size >= MAX_RUNNING) throw new JobError(429, `同時に動かせるのは ${MAX_RUNNING} つまでです`)
    const id = randomUUID()
    const job: JobState = {
      id,
      threadId: request.threadId ?? id,
      prompt,
      ...(request.refId ? { refId: request.refId } : {}),
      ...(request.canvasId ? { canvasId: request.canvasId } : {}),
      status: 'running',
      createdAt: Date.now(),
      eventCount: 0,
      events: [],
      abort: new AbortController(),
    }
    this.store.insertJob(job)
    this.running.set(id, job)
    this.notify(job, 0)
    const execution = this.execute(job, resume).finally(() => this.executions.delete(execution))
    this.executions.add(execution)
    return publicJob(job)
  }

  cancel(id: string): Job {
    const job = this.running.get(id)
    if (job) {
      job.abort.abort()
      return publicJob(job)
    }
    const stored = this.store.job(id)
    if (!stored) throw new JobError(404, 'job not found')
    return publicJob(stored)
  }

  // 会話を消す（動いているジョブがあれば断る）。Claude Code の session も消す（消せなくても会話は消す）
  async deleteThread(threadId: string): Promise<void> {
    if (!this.store.thread(threadId)) throw new JobError(404, 'その会話はもうありません')
    if ([...this.running.values()].some((job) => job.threadId === threadId)) throw new JobError(409, '動いている依頼があります。止めてから消してください')
    const sessions = this.store.deleteThread(threadId)
    for (const listener of this.listeners) safely(() => listener({ type: 'thread-deleted', threadId }))
    const remove = this.deps.deleteSession ?? defaultDeleteSession
    for (const session of sessions) {
      try {
        await remove(session, this.deps.workspace)
      } catch (error) {
        console.warn(`Claude Code の session ${session} を消せませんでした`, error)
      }
    }
  }

  // 動いているものを止め、終わる（止めたことを書き終える）のを待つ（サーバーを止めるとき）
  async dispose(): Promise<void> {
    for (const job of this.running.values()) job.abort.abort()
    await Promise.all(this.executions)
  }

  private async execute(job: JobState, resume: string | undefined): Promise<void> {
    const { workspace } = this.deps
    const denied = (name: string, reason: string) => this.push(job, { kind: 'denied', name, reason })
    const options: Options = {
      cwd: workspace,
      abortController: job.abort,
      ...(resume ? { resume } : {}),
      tools: CLAUDE_TOOLS,
      // ワークスペースの .claude/skills/ のスキルをすべて使えるようにする（settingSources が project だけなので、~/.claude のスキルは読まない）
      skills: 'all',
      // 分類のモデルが許すか決める。決められなければ canUseTool に来る
      permissionMode: 'auto',
      canUseTool: async (name, input) => {
        const decision = askTool(name, input, workspace)
        if (decision.behavior === 'deny') denied(name, decision.message)
        return decision
      },
      hooks: { PreToolUse: [{ hooks: [preToolUseHook(workspace, denied)] }] },
      mcpServers: { canvcode: { type: 'http', url: this.deps.mcpUrl, alwaysLoad: true } },
      strictMcpConfig: true,
      // ワークスペースの CLAUDE.md と .claude/ の設定だけを読む（ユーザーの ~/.claude の MCP・許可の設定は使わない）
      settingSources: ['project'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPromptAppend(job.canvasId) },
      ...(this.deps.model ? { model: this.deps.model } : {}),
      maxTurns: this.maxTurns(),
      ...(this.deps.maxBudgetUsd !== undefined ? { maxBudgetUsd: this.deps.maxBudgetUsd } : {}),
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'canvcode' },
    }
    const prompt = job.refId ? `${job.prompt}\n\n（選んだ場所：${job.refId}）` : job.prompt
    try {
      const run = this.deps.run ?? (await defaultRun())
      for await (const message of run({ prompt, options })) this.receive(job, message)
      if (job.status === 'running') this.finish(job, job.abort.signal.aborted ? 'cancelled' : 'done')
    } catch (error) {
      if (job.status !== 'running') return
      if (job.abort.signal.aborted) {
        this.finish(job, 'cancelled')
        return
      }
      console.error('a Claude job failed', error)
      this.push(job, { kind: 'error', message: error instanceof Error ? error.message : String(error) })
      this.finish(job, 'failed')
    }
  }

  private maxTurns(): number {
    return this.deps.maxTurns ?? DEFAULT_MAX_TURNS
  }

  private receive(job: JobState, message: SDKMessage): void {
    if ('session_id' in message && typeof message.session_id === 'string' && message.session_id !== job.sessionId) {
      job.sessionId = message.session_id
      this.store.setSession(job.id, message.session_id)
    }
    if (message.type === 'system' && message.subtype === 'init') {
      const canvcode = message.mcp_servers.find((server) => server.name === 'canvcode')
      if (canvcode && canvcode.status !== 'connected') {
        this.push(job, { kind: 'error', message: `CanvCode の MCP につながりませんでした（${canvcode.status}）` })
      }
      if (message.permissionMode !== 'auto') {
        this.push(job, { kind: 'error', message: `auto mode が使えないので、Bash は使えません（${message.permissionMode} で動いています）` })
      }
      return
    }
    // auto mode の判定で断られた
    if (message.type === 'system' && message.subtype === 'permission_denied') {
      this.push(job, { kind: 'denied', name: message.tool_name, reason: message.decision_reason || message.message })
      return
    }
    if (message.type === 'assistant') {
      // サブエージェントの中は、使ったツールだけを出す（文章はサブエージェントの途中の考えで、まとめは親が書く）
      const sub = Boolean(message.parent_tool_use_id)
      if (message.error && !sub) this.push(job, { kind: 'error', message: assistantErrorText(message.error) })
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text.trim()) {
          if (!sub) this.push(job, { kind: 'text', text: block.text })
        }
        else if (block.type === 'tool_use' && block.name !== 'TodoWrite') {
          const detail = toolDetail(block.name, (block.input ?? {}) as Record<string, unknown>, this.deps.workspace)
          this.push(job, { kind: 'tool', name: block.name, ...(detail ? { detail } : {}) })
        }
      }
      return
    }
    if (message.type === 'result') {
      job.costUsd = message.total_cost_usd
      job.durationMs = message.duration_ms
      if (message.subtype === 'success' && !message.is_error) {
        this.finish(job, 'done')
        return
      }
      if (job.abort.signal.aborted) {
        this.finish(job, 'cancelled')
        return
      }
      const text = message.subtype === 'success' ? message.result : resultErrorText(message.subtype, message.errors, this.maxTurns(), this.deps.maxBudgetUsd)
      this.push(job, { kind: 'error', message: text })
      this.finish(job, 'failed')
    }
  }

  private push(job: JobState, event: JobEvent): void {
    if (job.status !== 'running') return
    const from = job.events.length
    job.events.push(event)
    job.eventCount = job.events.length
    this.store.appendEvent(job.id, from, event)
    this.notify(job, from)
  }

  private finish(job: JobState, status: JobStatus): void {
    if (job.status !== 'running') return
    job.status = status
    job.finishedAt = Date.now()
    this.store.finishJob(job)
    this.running.delete(job.id)
    this.notify(job, job.events.length)
  }

  private notify(job: JobState, from: number): void {
    const thread = this.store.thread(job.threadId)
    if (!thread) return
    const change: JobChange = { type: 'job', job: summaryOf(job), events: job.events.slice(from), from, thread }
    for (const listener of this.listeners) safely(() => listener(change))
  }
}

function safely(fn: () => void): void {
  try {
    fn()
  } catch (error) {
    console.error('a Claude job listener failed', error)
  }
}

async function defaultRun(): Promise<RunQuery> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  return query
}

async function defaultDeleteSession(sessionId: string, dir: string): Promise<void> {
  const { deleteSession } = await import('@anthropic-ai/claude-agent-sdk')
  await deleteSession(sessionId, { dir })
}

function summaryOf(job: StoredJob & { abort?: AbortController }): JobSummary {
  const { events: _events, sessionId: _sessionId, abort: _abort, ...summary } = job
  return summary
}

function publicJob(job: StoredJob): Job {
  return { ...summaryOf(job), events: [...job.events] }
}

export function systemPromptAppend(canvasId: string | undefined): string {
  return [
    'You were asked from the chat panel of CanvCode (an infinite canvas app). Your replies are shown in that panel as Markdown; keep them short.',
    'Reply in the language the user writes in.',
    canvasId
      ? `The user is viewing canvas ${canvasId}. Pass canvas_id: "${canvasId}" to canvas tools unless the user names another canvas.`
      : '',
    'To change a canvas, use edit_canvas and give it a short label of what you did (the user can undo it from the screen).',
    'The current directory is the CanvCode workspace; Markdown, Python and CSV files there are CanvCode documents.',
    'Skills in the workspace .claude/skills/ are available through the Skill tool.',
    'File tools (Read, Write, Edit, Glob, Grep) work only inside the workspace. Bash commands are approved or denied automatically; nobody is watching to approve the ones that are not.',
  ]
    .filter(Boolean)
    .join('\n')
}

// 画面に出すツールの詳しさ（パスはワークスペースからの相対）
export function toolDetail(name: string, input: Record<string, unknown>, workspace: string): string | undefined {
  const str = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined)
  const path = (value: unknown) => {
    const p = str(value)
    return p && inside(workspace, p) ? relative(workspace, p) || '.' : p
  }
  if (name === 'Read' || name === 'Write' || name === 'Edit') return path(input.file_path)
  if (name === 'Glob' || name === 'Grep') return str(input.pattern)
  if (name === 'Bash') return str(input.command)
  if (name === 'WebSearch') return str(input.query)
  if (name === 'WebFetch') return str(input.url)
  if (name === 'Agent') return str(input.description)
  if (name === 'Skill') return str(input.skill)
  if (name.startsWith(CANVCODE_MCP_PREFIX)) return str(input.label) ?? str(input.ref) ?? str(input.id) ?? str(input.query)
  return undefined
}

function assistantErrorText(error: string): string {
  if (error === 'authentication_failed') return 'Claude Code にログインしていません（サーバーのマシンで claude を起動してログインしてください）'
  if (error === 'rate_limit') return '使用量の上限に達しました'
  if (error === 'billing_error') return '支払いの設定に問題があります'
  return `Claude の応答でエラーが起きました（${error}）`
}

// 上限で止めたときは、同じ会話で頼めば resume して続きから進められる
const CONTINUE_HINT = '同じ会話で続けて頼めば、続きから進めます'

function resultErrorText(subtype: string, errors: readonly string[] | undefined, maxTurns: number, maxBudgetUsd: number | undefined): string {
  const base =
    subtype === 'error_max_turns'
      ? `ターン数の上限（${maxTurns}）に達したので止めました。${CONTINUE_HINT}`
      : subtype === 'error_max_budget_usd'
        ? `費用の上限${maxBudgetUsd !== undefined ? `（$${maxBudgetUsd}）` : ''}に達したので止めました。${CONTINUE_HINT}`
        : '途中でエラーが起きました'
  return errors && errors.length > 0 ? `${base}：${errors.join(' / ')}` : base
}
