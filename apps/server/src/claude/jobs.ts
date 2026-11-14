import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { relative } from 'node:path'
import type { CanUseTool, Options, PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  askedByRule,
  askTool,
  CANVCODE_MCP_PREFIX,
  CLAUDE_TOOLS,
  inside,
  preToolUseHook,
  skillRoots,
  type AskContext,
  type Guard,
  type GuardSettings,
} from './permissions.ts'
import { ClaudeSession, type BackgroundTask, type RunQuery } from './session.ts'
import type { ClaudeStore, StoredJob, ThreadSummary } from './store.ts'

export type { BackgroundTask, RunQuery } from './session.ts'

// 画面から頼んだ Claude Code の仕事（ジョブ）。
// - Claude Agent SDK の query() で、サーバーと同じマシンの Claude Code を動かす（認証は、そのマシンの claude のログインか API キー）
// - cwd はワークスペース。MCP は自分の /mcp（canvcode）だけをつなぐ。許し方は auto mode と claude/permissions.ts
// - ユーザーが選んだ場所は ref:XXXX としてプロンプトに添える（AI は resolve_reference で読む。手で貼り付けたときと同じ）
// - 届いたメッセージを、画面に見せる出来事（JobEvent）にして claude/store.ts（SQLite）に書き、購読者（/api/claude/events の SSE）に知らせる
// - 会話（thread）ごとに Claude Code のプロセスを 1 つ持ち続ける（claude/session.ts。ストリーミング入力）。続きのメッセージはそのプロセスに送る。
//   しばらく使わなければ閉じ、次のメッセージは前のジョブの session_id を resume に渡して続ける（サーバーを再起動しても続けられる）
// - ジョブ 1 つがターン 1 つ。送るメッセージにジョブの id を uuid として付け、ターンの assistant と result に返ってくる user_message_uuids で、
//   どのターンがどの依頼に答えているかを決める（resume した直後などに、CLI が自分で起こしたターンが先に走ることがあるので、順番では決めない）。
//   バックグラウンドの作業（サブエージェント・コマンド）が終わって Claude が自分で続けたターンは、origin: 'background' のジョブにする
//   （答えを書かなかったターンはジョブにしない）
// - 止めるのは 3 通り：ジョブ（今のターンだけ。interrupt）・作業 1 つ（stopTask）・会話（プロセスごと。バックグラウンドの作業も止まる）
// - 起動したときに、途切れたジョブを止まったものにする

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled'

// 'background' は、バックグラウンドの作業が終わって Claude が自分で続けたジョブ（prompt は終わった作業の名前）
export type JobOrigin = 'background'

// 画面に見せる出来事
export type JobEvent =
  // Claude の文章（Markdown）
  | { kind: 'text'; text: string }
  // ツールを使った（detail は読んだファイル・コマンド・検索の語・Canvas の編集の label など）
  | { kind: 'tool'; name: string; detail?: string }
  // ツールを断った
  | { kind: 'denied'; name: string; reason: string }
  | { kind: 'error'; message: string }
  // バックグラウンドの作業を始めた・終わった
  | { kind: 'task'; status: 'started' | 'completed' | 'failed' | 'stopped'; description: string }
  // 画面で許可を求めた（id は PendingPermission の id）と、その答え
  | { kind: 'ask'; id: string; name: string; detail: string; agent?: string }
  | { kind: 'answer'; id: string; result: PermissionAnswer }

// 許可の問い合わせの終わり方：許した・断った・時間切れ・取り消し（ジョブや会話を止めた、プロセスが終わった）
export type PermissionAnswer = 'allowed' | 'denied' | 'expired' | 'cancelled'

// 画面で答えを待っている問い合わせ（プロセスが持っているもの。保存しない）。会話（thread）に付く
export interface PendingPermission {
  id: string
  // 尋ねたときの今のジョブ（バックグラウンドのサブエージェントからなら、ない）
  jobId?: string
  // ツールの名前（Bash など）
  name: string
  // Bash ならコマンドの全文。ほかは toolDetail と同じもの
  detail: string
  // Claude が付けた説明（canUseTool の description）
  description?: string
  // サブエージェントの中なら、その作業の名前
  agent?: string
  // 尋ねるわけ（規則で尋ねた・ワークスペースの外を触る）
  reason?: string
  createdAt: number
  // これを過ぎたら断る
  expiresAt: number
}

export interface JobSummary {
  id: string
  // 会話の id（最初のジョブの id）
  threadId: string
  prompt: string
  origin?: JobOrigin
  refId?: string
  canvasId?: string
  status: JobStatus
  createdAt: number
  finishedAt?: number
  // Claude Code が見積もったそのターンの費用（USD）と、かかった時間
  costUsd?: number
  durationMs?: number
  eventCount: number
}

export interface Job extends JobSummary {
  events: JobEvent[]
}

// 画面に見せる会話。tasks は動いているバックグラウンドの作業、permissions は画面で答えを待っている問い合わせ
// （どちらもプロセスが持っているもの。保存しない）
export interface ThreadInfo extends ThreadSummary {
  tasks: BackgroundTask[]
  permissions: PendingPermission[]
}

export interface StartRequest {
  prompt: string
  refId?: string
  canvasId?: string
  // 続ける会話
  threadId?: string
}

// 変化。job は、ジョブが変わった（events はその変化で足した出来事。from 番目から）。thread は、会話の作業の一覧が変わった。thread-deleted は、会話を消した
export type JobChange =
  | { type: 'job'; job: JobSummary; events: JobEvent[]; from: number; thread: ThreadInfo }
  | { type: 'thread'; thread: ThreadInfo }
  | { type: 'thread-deleted'; threadId: string }

export type JobListener = (change: JobChange) => void

export class JobError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// 同時に動かせるユーザーの依頼（バックグラウンドから始まったターンは数えない。CLI が自分で始めるので断れない）
export const MAX_RUNNING = 2
// 同時に持っておく Claude Code のプロセス（会話）。超えるときは、何もしていないものから閉じる
export const MAX_SESSIONS = 4
export const MAX_PROMPT_LENGTH = 20_000
export const INTERRUPTED_MESSAGE = 'サーバーが止まったので途切れました'
// 1 回の依頼のターン数の上限（ツールを呼ぶたびに 1 ターン）。canvcode の MCP は 1 つの作業で何度も呼ぶので多めにする
export const DEFAULT_MAX_TURNS = 100
// 何もしていない（今のジョブもバックグラウンドの作業もない）プロセスを閉じるまでの時間（ミリ秒）
export const IDLE_CLOSE_MS = 10 * 60_000
// 閉じるとき、プロセスが自分で終わるのを待つ時間（ミリ秒）。過ぎたら止める
export const CLOSE_GRACE_MS = 5_000
// ジョブを止めて（interrupt）も、この時間のうちにターンが終わらなければ、プロセスごと止める（ミリ秒）
export const CANCEL_GRACE_MS = 10_000
// 画面で許可を求めて、この時間のうちに誰も答えなければ断る（ミリ秒。SDK の問い合わせには期限がない）
export const PERMISSION_TIMEOUT_MS = 10 * 60_000
// 1 つの会話で答えを待てる問い合わせの数。超えたものは尋ねずに断る（サブエージェントが並ぶと、一度にたくさん来うる）
export const MAX_PENDING_PERMISSIONS = 20
export const TOO_MANY_PERMISSIONS = `待っている許可が多すぎます（1 つの会話で ${MAX_PENDING_PERMISSIONS} まで）。前の許可の答えを待ってから、もう一度試してください`

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
  // 1 つのプロセスの費用の上限（ドル。プロセスの間の合計）。既定は付けない。超えたら、何もしていなくなったときにプロセスを閉じる（次の依頼は新しいプロセスで続ける）
  maxBudgetUsd?: number
  // 既定は IDLE_CLOSE_MS・CLOSE_GRACE_MS・CANCEL_GRACE_MS
  idleCloseMs?: number
  closeGraceMs?: number
  cancelGraceMs?: number
  // Claude Code に渡す CLAUDE_CODE_TMPDIR（バックグラウンドの作業の出力の置き場の根）。既定はサーバーの CLAUDE_CODE_TMPDIR か、OS の一時フォルダ
  tmpRoot?: string
  // 既定は PERMISSION_TIMEOUT_MS
  permissionTimeoutMs?: number
}

// CANVCODE_CLAUDE_MAX_TURNS（正の整数）・CANVCODE_CLAUDE_MAX_BUDGET_USD（正の数）・CANVCODE_CLAUDE_PERMISSION_TIMEOUT_MS（正の整数）。
// 使えない値なら既定のまま
export function claudeLimitsFromEnv(env: NodeJS.ProcessEnv): Pick<ClaudeJobsDeps, 'maxTurns' | 'maxBudgetUsd' | 'permissionTimeoutMs'> {
  const maxTurns = Number(env.CANVCODE_CLAUDE_MAX_TURNS)
  const maxBudgetUsd = Number(env.CANVCODE_CLAUDE_MAX_BUDGET_USD)
  const permissionTimeoutMs = Number(env.CANVCODE_CLAUDE_PERMISSION_TIMEOUT_MS)
  return {
    ...(Number.isInteger(maxTurns) && maxTurns > 0 ? { maxTurns } : {}),
    ...(Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0 ? { maxBudgetUsd } : {}),
    ...(Number.isInteger(permissionTimeoutMs) && permissionTimeoutMs > 0 ? { permissionTimeoutMs } : {}),
  }
}

// 待っている問い合わせ（LiveThread が持つ）。settle で終わらせる（2 回目からは何もしない）
interface PermissionEntry {
  info: PendingPermission
  // サブエージェントの中なら、その作業の id（作業 1 つを止めたら取り消す）
  agentId?: string
  settle: (answer: PermissionAnswer) => void
}

// 会話 1 つの、動いている Claude Code のプロセスとその様子
interface LiveThread {
  threadId: string
  session: ClaudeSession
  sessionId?: string
  // システムプロンプトに入れた、見ている Canvas
  canvasId?: string
  // 今のターンのジョブ
  current?: StoredJob
  // 送ったが、まだ答えるターンが来ていない依頼
  waiting?: StoredJob
  // 待っているあいだに止めた依頼の id（そのターンが来たら止めて、見せない）
  dropped: Set<string>
  skipTurn: boolean
  // 今のジョブがないときに届いた作業の出来事（次のジョブの初めに入れる）
  pending: JobEvent[]
  // 今のジョブがないときに終わった作業（次のバックグラウンドのジョブの prompt にする）
  finished: { description: string; status: 'completed' | 'failed' | 'stopped' }[]
  // 作業の名前（task_id → description）。バックグラウンドで動いたものだけを知らせる
  names: Map<string, string>
  background: Set<string>
  // バックグラウンドのサブエージェントを起こした tool_use の id（その中の動きは、今のジョブに出さない）
  backgroundToolUses: Set<string>
  // 最初の system/init を確かめた
  initialized: boolean
  // 前の result までの費用（total_cost_usd は query の合計なので、差がそのターンの費用）。resume したプロセスは前のプロセスの合計から数えるので、
  // それを知らなければ NaN（最初のターンの費用は出さない）
  costSoFar: number
  // 費用の上限に達した。何もしていなくなったら閉じる
  retire: boolean
  lastActive: number
  idleTimer?: NodeJS.Timeout
  cancelTimer?: NodeJS.Timeout
  // 最後に通ったフックが組み立てた、ファイルのツールの許す場所（canUseTool には session の場所がわかる引数がないので、これを使う）
  guard?: Guard
  // 画面で答えを待っている問い合わせ（id → 中身）。古いものから
  permissions: Map<string, PermissionEntry>
}

export class ClaudeJobs {
  private readonly deps: ClaudeJobsDeps
  private readonly store: ClaudeStore
  private readonly running = new Map<string, StoredJob>()
  private readonly live = new Map<string, LiveThread>()
  // 閉じている途中のプロセス（同じ会話の次のプロセスは、これを待ってから立てる）
  private readonly closing = new Map<string, Promise<void>>()
  // 止めると頼まれたジョブ
  private readonly cancelled = new WeakSet<StoredJob>()
  // Claude Code の session ごとの、最後の total_cost_usd（resume したプロセスの費用の数え始め）
  private readonly costTotals = new Map<string, number>()
  private readonly listeners = new Set<JobListener>()
  private readonly guardSettings: GuardSettings

  constructor(deps: ClaudeJobsDeps) {
    this.deps = deps
    this.store = deps.store
    // スキルのフォルダは、起動したときに 1 回だけ調べる（Claude Code も、プロセスを立てたときに読み込む）
    this.guardSettings = { workspace: deps.workspace, tmpRoot: deps.tmpRoot ?? process.env.CLAUDE_CODE_TMPDIR ?? tmpdir(), skillRoots: skillRoots(deps.workspace) }
    const interrupted = this.store.interruptRunning(INTERRUPTED_MESSAGE)
    if (interrupted > 0) console.log(`途切れた Claude のジョブを止まったものにしました：${interrupted} 個`)
  }

  threads(): ThreadInfo[] {
    return this.store.threads().map((thread) => this.info(thread))
  }

  thread(threadId: string): { thread: ThreadInfo; jobs: Job[] } | undefined {
    const thread = this.store.thread(threadId)
    if (!thread) return undefined
    return { thread: this.info(thread), jobs: this.store.threadJobs(threadId).map((job) => publicJob(this.running.get(job.id) ?? job)) }
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
    let live = request.threadId ? this.live.get(request.threadId) : undefined
    if (request.threadId) {
      const last = this.store.lastOfThread(request.threadId)
      if (!last) throw new JobError(404, 'その会話はもうありません')
      if (last.status === 'running' || live?.current || live?.waiting) throw new JobError(409, '前の依頼がまだ終わっていません')
      resume = live?.sessionId ?? last.sessionId
    }
    // 画面で許可を待っている依頼も数える（ターンの途中で、プロセスも動いている）
    if ([...this.running.values()].filter((job) => !job.origin).length >= MAX_RUNNING) {
      const asking = [...this.live.values()].some((thread) => thread.permissions.size > 0)
      throw new JobError(429, `同時に動かせるのは ${MAX_RUNNING} つまでです${asking ? '。許可を待っている依頼があれば、答えると進みます' : ''}`)
    }
    // 費用の上限に達したプロセスは、新しいものに替える
    if (live?.retire && live.session.tasks.length === 0) {
      void this.closeThread(live.threadId)
      live = undefined
    }
    if (!live) this.makeRoom()
    const id = randomUUID()
    const threadId = request.threadId ?? id
    const thread = live ?? this.open(threadId, resume, request.canvasId)
    const job: StoredJob = {
      id,
      threadId,
      prompt,
      ...(request.refId ? { refId: request.refId } : {}),
      ...(request.canvasId ? { canvasId: request.canvasId } : {}),
      status: 'running',
      createdAt: Date.now(),
      // 誰のターンでもないときに届いた作業の知らせは、この依頼の初めに出す
      events: thread.pending.splice(0),
      eventCount: 0,
      ...(thread.sessionId ? { sessionId: thread.sessionId } : {}),
    }
    job.eventCount = job.events.length
    thread.finished = []
    thread.waiting = job
    this.begin(thread, job)
    thread.session.send(messageText(job, thread.canvasId), job.id)
    return publicJob(job)
  }

  // ジョブを止める：今のターンだけを止め、バックグラウンドの作業とプロセスは残す
  cancel(id: string): Job {
    const job = this.running.get(id)
    if (!job) {
      const stored = this.store.job(id)
      if (!stored) throw new JobError(404, 'job not found')
      return publicJob(stored)
    }
    this.cancelled.add(job)
    const thread = this.live.get(job.threadId)
    // そのジョブが待っている許可は取り消す（interrupt でも SDK の signal から取り消しになるが、待たずに画面から消す）
    if (thread) this.cancelPermissions(thread, (entry) => entry.info.jobId === job.id)
    if (thread?.waiting === job && !thread.session.started) {
      // まだプロセスを立てていない（前のプロセスを待っている）
      void this.closeThread(thread.threadId, 0)
    } else if (thread?.waiting === job) {
      // 答えるターンがまだ来ていない。待っているメッセージを取り消す（取り消せずにターンが来たら、そこで止める）
      thread.waiting = undefined
      thread.dropped.add(job.id)
      this.finish(job, 'cancelled')
      thread.session.interrupt(true).catch((error: unknown) => console.warn('Claude の依頼を止められませんでした', error))
      this.scheduleIdle(thread)
    } else if (!thread || thread.current !== job) {
      this.finish(job, 'cancelled')
    } else {
      thread.session.interrupt().catch((error: unknown) => console.warn('Claude の依頼を止められませんでした', error))
      clearTimeout(thread.cancelTimer)
      thread.cancelTimer = setTimeout(() => {
        if (thread.current === job) void this.closeThread(thread.threadId, 0)
      }, this.deps.cancelGraceMs ?? CANCEL_GRACE_MS)
      thread.cancelTimer.unref?.()
    }
    return publicJob(job)
  }

  // 会話のプロセスごと止める（今のターンもバックグラウンドの作業も止まる）
  async stopThread(threadId: string): Promise<void> {
    if (!this.store.thread(threadId)) throw new JobError(404, 'その会話はもうありません')
    const thread = this.live.get(threadId)
    if (thread?.current) this.cancelled.add(thread.current)
    if (thread?.waiting) this.cancelled.add(thread.waiting)
    await this.closeThread(threadId, 0)
  }

  // バックグラウンドの作業を 1 つ止める
  async stopTask(threadId: string, taskId: string): Promise<void> {
    if (!this.store.thread(threadId)) throw new JobError(404, 'その会話はもうありません')
    const thread = this.live.get(threadId)
    if (!thread?.session.tasks.some((task) => task.id === taskId)) throw new JobError(404, 'その作業はもう動いていません')
    // その作業（サブエージェント）が待っている許可は取り消す
    this.cancelPermissions(thread, (entry) => entry.agentId === taskId)
    await thread.session.stopTask(taskId)
  }

  // 画面で待っている問い合わせに答える。もう待っていない（答えた・時間切れ・取り消した）か、その会話のものでなければ 404
  answerPermission(threadId: string, id: string, decision: 'allow' | 'deny'): void {
    const entry = this.live.get(threadId)?.permissions.get(id)
    if (!entry) throw new JobError(404, 'その問い合わせはもうありません')
    entry.settle(decision === 'allow' ? 'allowed' : 'denied')
  }

  // 会話を消す（動いている依頼か作業があれば断る）。Claude Code の session も消す（消せなくても会話は消す）
  async deleteThread(threadId: string): Promise<void> {
    if (!this.store.thread(threadId)) throw new JobError(404, 'その会話はもうありません')
    if ([...this.running.values()].some((job) => job.threadId === threadId)) throw new JobError(409, '動いている依頼があります。止めてから消してください')
    if ((this.live.get(threadId)?.session.tasks.length ?? 0) > 0) {
      throw new JobError(409, 'バックグラウンドの作業が動いています。止めてから消してください')
    }
    const sessions = this.store.deleteThread(threadId)
    for (const listener of this.listeners) safely(() => listener({ type: 'thread-deleted', threadId }))
    // 書いている途中の transcript を消さないように、プロセスが終わってから消す
    await this.closeThread(threadId)
    const remove = this.deps.deleteSession ?? defaultDeleteSession
    for (const session of sessions) {
      try {
        await remove(session, this.deps.workspace)
      } catch (error) {
        console.warn(`Claude Code の session ${session} を消せませんでした`, error)
      }
    }
  }

  // すべてのプロセスを止め、終わる（止めたことを書き終える）のを待つ（サーバーを止めるとき）
  async dispose(): Promise<void> {
    for (const thread of this.live.values()) {
      if (thread.current) this.cancelled.add(thread.current)
      if (thread.waiting) this.cancelled.add(thread.waiting)
    }
    await Promise.all([...[...this.live.keys()].map((threadId) => this.closeThread(threadId, 0)), ...this.closing.values()])
  }

  // 新しいプロセスを立てる場所を空ける。上限なら、何もしていないものを古い順に 1 つ閉じる
  private makeRoom(): void {
    if (this.live.size < MAX_SESSIONS) return
    const idle = [...this.live.values()]
      .filter((thread) => !thread.current && !thread.waiting && thread.session.tasks.length === 0 && thread.permissions.size === 0)
      .sort((a, b) => a.lastActive - b.lastActive)[0]
    if (!idle) throw new JobError(429, `同時に開いておける会話は ${MAX_SESSIONS} つまでです。ほかの会話の作業が終わるのを待つか、止めてください`)
    void this.closeThread(idle.threadId)
  }

  private open(threadId: string, resume: string | undefined, canvasId: string | undefined): LiveThread {
    const thread = {
      threadId,
      ...(resume ? { sessionId: resume } : {}),
      ...(canvasId ? { canvasId } : {}),
      pending: [],
      finished: [],
      names: new Map(),
      background: new Set(),
      backgroundToolUses: new Set(),
      dropped: new Set(),
      skipTurn: false,
      initialized: false,
      costSoFar: resume ? (this.costTotals.get(resume) ?? Number.NaN) : 0,
      retire: false,
      lastActive: Date.now(),
      permissions: new Map(),
    } as unknown as LiveThread
    thread.session = new ClaudeSession(
      this.deps.run ?? defaultRun,
      this.options(thread, resume),
      {
        onMessage: (message) => this.receive(thread, message),
        onTasks: () => this.tasksChanged(thread),
        onExit: (error) => this.exited(thread, error),
      },
      this.closing.get(threadId),
    )
    this.live.set(threadId, thread)
    return thread
  }

  // 閉じて、終わるのを待つ。graceMs が 0 なら、すぐ止める
  private closeThread(threadId: string, graceMs = this.deps.closeGraceMs ?? CLOSE_GRACE_MS): Promise<void> {
    const thread = this.live.get(threadId)
    if (!thread) return this.closing.get(threadId) ?? Promise.resolve()
    this.live.delete(threadId)
    clearTimeout(thread.idleTimer)
    clearTimeout(thread.cancelTimer)
    // 待っている許可は取り消す（プロセスを閉じるので、もう答えられない）
    this.cancelPermissions(thread)
    const done: Promise<void> = thread.session.close(graceMs).finally(() => {
      if (this.closing.get(threadId) === done) this.closing.delete(threadId)
    })
    this.closing.set(threadId, done)
    return done
  }

  private options(thread: LiveThread, resume: string | undefined): Options {
    const { workspace } = this.deps
    const denied = (name: string, reason: string) => {
      const job = thread.current ?? thread.waiting
      if (job) this.push(job, { kind: 'denied', name, reason })
    }
    return {
      cwd: workspace,
      ...(resume ? { resume } : {}),
      tools: CLAUDE_TOOLS,
      // ワークスペースの .claude/skills/ のスキルをすべて使えるようにする（settingSources が project だけなので、~/.claude のスキルは読まない）
      skills: 'all',
      // 分類のモデルが許すか決める。決められなければ canUseTool に来る。Bash と、規則で尋ねると決めたものは、画面で尋ねる
      permissionMode: 'auto',
      canUseTool: async (name, input, options) => {
        const decision = askTool(name, input, thread.guard ?? workspace, options as AskContext)
        if (decision.behavior === 'ask') return this.ask(thread, name, input, options, denied)
        if (decision.behavior === 'deny') denied(name, decision.message)
        return decision
      },
      hooks: { PreToolUse: [{ hooks: [preToolUseHook(this.guardSettings, denied, (guard) => (thread.guard = guard))] }] },
      mcpServers: { canvcode: { type: 'http', url: this.deps.mcpUrl, alwaysLoad: true } },
      strictMcpConfig: true,
      // ワークスペースの CLAUDE.md と .claude/ の設定だけを読む（ユーザーの ~/.claude の MCP・許可の設定は使わない）
      settingSources: ['project'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPromptAppend(thread.canvasId) },
      // 画面に作業ごとの止めるボタンがある。interrupt はターンだけを止め、バックグラウンドの作業は残す
      perTaskStopAffordance: true,
      ...(this.deps.model ? { model: this.deps.model } : {}),
      maxTurns: this.maxTurns(),
      ...(this.deps.maxBudgetUsd !== undefined ? { maxBudgetUsd: this.deps.maxBudgetUsd } : {}),
      // env は Claude Code の環境を丸ごと置き換えるので、process.env を広げたうえで足す。
      // CLAUDE_CODE_TMPDIR は、バックグラウンドの作業の出力の置き場をサーバーが知るため（permissions.ts の sessionReadRoots）
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'canvcode', CLAUDE_CODE_TMPDIR: this.guardSettings.tmpRoot },
    }
  }

  private maxTurns(): number {
    return this.deps.maxTurns ?? DEFAULT_MAX_TURNS
  }

  // 画面でユーザーに尋ね、答え（許す・断る）か、時間切れか、取り消しを待つ（docs/claude-permissions-plan.md の段階 2）。
  // 問い合わせは会話に付け（ThreadInfo.permissions）、尋ねたことと答えはジョブの出来事（ask・answer）として残す
  private ask(
    thread: LiveThread,
    name: string,
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
    denied: (name: string, reason: string) => void,
  ): Promise<PermissionResult> {
    if (thread.permissions.size >= MAX_PENDING_PERMISSIONS) {
      denied(name, TOO_MANY_PERMISSIONS)
      return Promise.resolve({ behavior: 'deny', message: TOO_MANY_PERMISSIONS })
    }
    // 止めたあと・閉じた会話（もう答えられない）は、尋ねずに断る
    if (options.signal.aborted || this.live.get(thread.threadId) !== thread) return Promise.resolve({ behavior: 'deny', message: PERMISSION_TEXT.cancelled })
    const id = randomUUID()
    const now = Date.now()
    const timeoutMs = this.deps.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS
    const agent = options.agentID ? (thread.names.get(options.agentID) ?? 'サブエージェント') : undefined
    const reason = askedByRule(options as AskContext)
      ? 'ワークスペースの設定（permissions.ask）で、尋ねると決めてあります'
      : options.blockedPath
        ? `${options.blockedPath} を触ります`
        : undefined
    const detail = permissionDetail(name, input, this.deps.workspace)
    const info: PendingPermission = {
      id,
      ...(thread.current ? { jobId: thread.current.id } : {}),
      name,
      detail,
      ...(options.description ? { description: options.description } : {}),
      ...(agent ? { agent } : {}),
      ...(reason ? { reason } : {}),
      createdAt: now,
      expiresAt: now + timeoutMs,
    }
    this.permissionEvent(thread, info.jobId, { kind: 'ask', id, name, detail, ...(agent ? { agent } : {}) })
    return new Promise<PermissionResult>((resolve) => {
      // SDK の signal の abort（ジョブを止めた interrupt など）と時間切れ。entry は下で作る（呼ばれるのはそのあと）
      const onAbort = () => entry.settle('cancelled')
      const timer = setTimeout(() => entry.settle('expired'), timeoutMs)
      timer.unref?.()
      const entry: PermissionEntry = {
        info,
        ...(options.agentID ? { agentId: options.agentID } : {}),
        settle: (answer) => {
          if (thread.permissions.get(id) !== entry) return
          thread.permissions.delete(id)
          clearTimeout(timer)
          options.signal.removeEventListener('abort', onAbort)
          this.permissionEvent(thread, info.jobId, { kind: 'answer', id, result: answer })
          this.notifyThread(thread.threadId)
          this.scheduleIdle(thread)
          resolve(answer === 'allowed' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: permissionText(answer, timeoutMs) })
        },
      }
      thread.permissions.set(id, entry)
      options.signal.addEventListener('abort', onAbort, { once: true })
      this.notifyThread(thread.threadId)
    })
  }

  // 待っている許可を取り消す（which で絞る。省けば全部）
  private cancelPermissions(thread: LiveThread, which: (entry: PermissionEntry) => boolean = () => true): void {
    for (const entry of [...thread.permissions.values()]) if (which(entry)) entry.settle('cancelled')
  }

  // 許可の出来事を、尋ねたときのジョブ（まだ動いていれば）か今のジョブに足す。どちらもなければ（バックグラウンドのサブエージェント）、会話の最後のジョブに足す。
  // 最後のジョブが動いていれば（送ったが、まだターンが来ていない依頼）、保存した写しではなく動いているものに足す（出来事の番号がずれないように）
  private permissionEvent(thread: LiveThread, jobId: string | undefined, event: JobEvent): void {
    const last = this.store.lastOfThread(thread.threadId)
    const job = (jobId ? this.running.get(jobId) : undefined) ?? thread.current ?? (last ? this.running.get(last.id) : undefined)
    if (job) this.push(job, event)
    else this.appendToLast(thread.threadId, event)
  }

  // ジョブを保存し、知らせる
  private begin(thread: LiveThread, job: StoredJob): void {
    thread.lastActive = Date.now()
    clearTimeout(thread.idleTimer)
    this.store.insertJob(job)
    this.running.set(job.id, job)
    this.notify(job, 0)
  }

  // バックグラウンドの作業が終わって、Claude が自分で始めたターン
  private beginBackground(thread: LiveThread): StoredJob {
    const finished = thread.finished.splice(0)
    const job: StoredJob = {
      id: randomUUID(),
      threadId: thread.threadId,
      prompt:
        finished.length > 0
          ? `バックグラウンドの作業${finished.map((task) => `「${task.description}」${FINISHED_TEXT[task.status]}`).join('、')}`
          : 'バックグラウンドの作業から続けました',
      origin: 'background',
      status: 'running',
      createdAt: Date.now(),
      events: thread.pending.splice(0),
      eventCount: 0,
      ...(thread.sessionId ? { sessionId: thread.sessionId } : {}),
    }
    job.eventCount = job.events.length
    thread.current = job
    this.begin(thread, job)
    return job
  }

  // ターンが答えている依頼（user_message_uuids）が、待っている依頼なら、今のジョブにする。
  // CLI が自分で起こしたターンの途中に依頼が混ぜられたら、そこまでをバックグラウンドのジョブとして終える。止めた依頼なら、そのターンを止めて見せない
  private bind(thread: LiveThread, uuids: readonly string[] | undefined): void {
    if (!uuids || uuids.length === 0) return
    const waiting = thread.waiting
    if (waiting && uuids.includes(waiting.id)) {
      thread.waiting = undefined
      if (thread.current && thread.current !== waiting) this.finish(thread.current, 'done')
      thread.current = waiting
      for (const event of thread.pending.splice(0)) this.push(waiting, event)
      return
    }
    if (!thread.skipTurn && uuids.some((id) => thread.dropped.has(id))) {
      thread.skipTurn = true
      thread.session.interrupt().catch((error: unknown) => console.warn('Claude の依頼を止められませんでした', error))
    }
  }

  private receive(thread: LiveThread, message: SDKMessage): void {
    thread.lastActive = Date.now()
    if ('session_id' in message && typeof message.session_id === 'string' && message.session_id !== thread.sessionId) {
      thread.sessionId = message.session_id
    }
    const sessionId = thread.sessionId
    for (const job of [thread.current, thread.waiting]) {
      if (sessionId && job && job.sessionId !== sessionId) {
        job.sessionId = sessionId
        this.store.setSession(job.id, sessionId)
      }
    }
    // ターンの初め（ターンごとに届く）。どの依頼に答えるターンかは、最初の assistant でわかる
    if (message.type === 'system' && message.subtype === 'init') {
      if (thread.initialized) return
      thread.initialized = true
      const job = thread.current ?? thread.waiting
      if (!job) return
      const canvcode = message.mcp_servers.find((server) => server.name === 'canvcode')
      if (canvcode && canvcode.status !== 'connected') {
        this.push(job, { kind: 'error', message: `CanvCode の MCP につながりませんでした（${canvcode.status}）` })
      }
      // auto mode が使えないと、Bash の呼び出しがみな canUseTool に来る（画面で毎回尋ねる）
      if (message.permissionMode !== 'auto') {
        this.push(job, { kind: 'error', message: `auto mode が使えないので、Bash は毎回画面で許可を求めます（${message.permissionMode} で動いています）` })
      }
      return
    }
    // auto mode の判定で断られた
    if (message.type === 'system' && message.subtype === 'permission_denied') {
      const job = thread.current ?? thread.waiting
      if (job) this.push(job, { kind: 'denied', name: message.tool_name, reason: message.decision_reason || message.message })
      return
    }
    if (message.type === 'system' && message.subtype === 'task_started') {
      thread.names.set(message.task_id, message.description)
      // 前景の作業（ツールの呼び出しとして出している）は知らせない。サブエージェントが起こした作業と、起こし直し（resume）も知らせない
      if (message.is_backgrounded && !message.parent_task_id && !thread.background.has(message.task_id)) {
        thread.background.add(message.task_id)
        if (message.tool_use_id) thread.backgroundToolUses.add(message.tool_use_id)
        this.taskEvent(thread, { kind: 'task', status: 'started', description: message.description })
      }
      return
    }
    // Bash の時間切れなどで、前景からバックグラウンドに回った
    if (message.type === 'system' && message.subtype === 'task_updated') {
      if (message.patch.is_backgrounded && !thread.background.has(message.task_id) && thread.names.has(message.task_id)) {
        thread.background.add(message.task_id)
        this.taskEvent(thread, { kind: 'task', status: 'started', description: thread.names.get(message.task_id)! })
      }
      return
    }
    if (message.type === 'system' && message.subtype === 'task_notification') {
      if (message.skip_transcript || message.ambient || !thread.background.has(message.task_id)) return
      const description = thread.names.get(message.task_id) ?? message.summary
      this.taskEvent(thread, { kind: 'task', status: message.status, description })
      if (!thread.current) thread.finished.push({ description, status: message.status })
      return
    }
    if (message.type === 'assistant') {
      const parent = message.parent_tool_use_id
      // バックグラウンドのサブエージェントの中は出さない（どのターンのものでもない）
      if (parent && thread.backgroundToolUses.has(parent)) return
      // サブエージェントの中は、使ったツールだけを出す（文章はサブエージェントの途中の考えで、まとめは親が書く）
      const sub = Boolean(parent)
      if (!sub) this.bind(thread, message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : undefined))
      if (thread.skipTurn) return
      const job = thread.current ?? (sub ? undefined : this.beginBackground(thread))
      if (!job) return
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
      const stamps = message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : undefined)
      // 答えを書く前にエラーで終わったのに、どの依頼のものか書いていない（古い CLI）。待っている依頼のエラーとみなす（いつまでも待たせない）
      const unstampedError = !stamps && message.is_error && !thread.current && thread.waiting
      this.bind(thread, unstampedError ? [thread.waiting!.id] : stamps)
      const cost = message.total_cost_usd - thread.costSoFar
      thread.costSoFar = message.total_cost_usd
      if (thread.sessionId) this.costTotals.set(thread.sessionId, message.total_cost_usd)
      if (message.subtype === 'error_max_budget_usd') thread.retire = true
      if (thread.skipTurn) {
        thread.skipTurn = false
        this.scheduleIdle(thread)
        return
      }
      const job = thread.current
      // 答えを書かなかったターン（作業の知らせを受けただけ）は、ジョブにしない
      if (!job) {
        this.scheduleIdle(thread)
        return
      }
      thread.current = undefined
      clearTimeout(thread.cancelTimer)
      if (Number.isFinite(cost)) job.costUsd = cost
      job.durationMs = message.duration_ms
      if (message.subtype === 'success' && !message.is_error) this.finish(job, 'done')
      else if (this.cancelled.has(job)) this.finish(job, 'cancelled')
      else {
        const text = message.subtype === 'success' ? message.result : resultErrorText(message.subtype, message.errors, this.maxTurns(), this.deps.maxBudgetUsd)
        this.push(job, { kind: 'error', message: text })
        this.finish(job, 'failed')
      }
      this.scheduleIdle(thread)
    }
  }

  // 作業の出来事を、今のジョブか、次のジョブの初めに入れる
  private taskEvent(thread: LiveThread, event: JobEvent): void {
    if (thread.current) this.push(thread.current, event)
    else thread.pending.push(event)
  }

  private tasksChanged(thread: LiveThread): void {
    thread.lastActive = Date.now()
    this.scheduleIdle(thread)
    this.notifyThread(thread.threadId)
  }

  // 何もしていなければ、しばらくして閉じる（費用の上限に達していれば、すぐ閉じる）
  private scheduleIdle(thread: LiveThread): void {
    clearTimeout(thread.idleTimer)
    if (thread.current || thread.waiting || thread.session.tasks.length > 0 || thread.permissions.size > 0 || this.live.get(thread.threadId) !== thread) return
    if (thread.retire) {
      void this.closeThread(thread.threadId)
      return
    }
    thread.idleTimer = setTimeout(() => void this.closeThread(thread.threadId), this.deps.idleCloseMs ?? IDLE_CLOSE_MS)
    thread.idleTimer.unref?.()
  }

  // プロセスが終わった
  private exited(thread: LiveThread, error: unknown): void {
    clearTimeout(thread.idleTimer)
    clearTimeout(thread.cancelTimer)
    if (this.live.get(thread.threadId) === thread) this.live.delete(thread.threadId)
    if (error) console.error('a Claude session failed', error)
    // 待っていた許可は取り消す（ジョブを終える前に。取り消しをそのジョブに残すため）
    this.cancelPermissions(thread)
    for (const job of [thread.current, thread.waiting]) {
      if (!job) continue
      if (this.cancelled.has(job) || thread.session.closing) this.finish(job, 'cancelled')
      else {
        this.push(job, { kind: 'error', message: error instanceof Error ? error.message : error ? String(error) : 'Claude Code のプロセスが途中で終わりました' })
        this.finish(job, 'failed')
      }
    }
    thread.current = undefined
    thread.waiting = undefined
    const lost = thread.session.tasks.length
    if (lost > 0 && !thread.session.closing) {
      this.appendToLast(thread.threadId, { kind: 'error', message: `Claude Code のプロセスが終わったので、バックグラウンドの作業 ${lost} 個が途切れました` })
    }
    this.notifyThread(thread.threadId)
  }

  // 会話の最後のジョブに出来事を足す（終わったジョブにも）
  private appendToLast(threadId: string, event: JobEvent): void {
    const last = this.store.lastOfThread(threadId)
    if (!last) return
    const from = last.events.length
    last.events.push(event)
    last.eventCount = last.events.length
    this.store.appendEvent(last.id, from, event)
    this.notify(last, from)
  }

  private push(job: StoredJob, event: JobEvent): void {
    if (job.status !== 'running') return
    const from = job.events.length
    job.events.push(event)
    job.eventCount = job.events.length
    this.store.appendEvent(job.id, from, event)
    this.notify(job, from)
  }

  private finish(job: StoredJob, status: JobStatus): void {
    if (job.status !== 'running') return
    job.status = status
    job.finishedAt = Date.now()
    this.store.finishJob(job)
    this.running.delete(job.id)
    this.notify(job, job.events.length)
  }

  private info(thread: ThreadSummary): ThreadInfo {
    const live = this.live.get(thread.threadId)
    return { ...thread, tasks: [...(live?.session.tasks ?? [])], permissions: [...(live?.permissions.values() ?? [])].map((entry) => entry.info) }
  }

  private notify(job: StoredJob, from: number): void {
    const thread = this.store.thread(job.threadId)
    if (!thread) return
    const change: JobChange = { type: 'job', job: summaryOf(job), events: job.events.slice(from), from, thread: this.info(thread) }
    for (const listener of this.listeners) safely(() => listener(change))
  }

  private notifyThread(threadId: string): void {
    const thread = this.store.thread(threadId)
    if (!thread) return
    const change: JobChange = { type: 'thread', thread: this.info(thread) }
    for (const listener of this.listeners) safely(() => listener(change))
  }
}

const FINISHED_TEXT = { completed: 'が終わりました', failed: 'が失敗しました', stopped: 'を止めました' }

function safely(fn: () => void): void {
  try {
    fn()
  } catch (error) {
    console.error('a Claude job listener failed', error)
  }
}

// プロセスに送る文。選んだ場所と、システムプロンプトと違う Canvas を見ていればそれを添える
function messageText(job: StoredJob, sessionCanvasId: string | undefined): string {
  return [
    job.prompt,
    job.refId ? `（選んだ場所：${job.refId}）` : '',
    job.canvasId && job.canvasId !== sessionCanvasId ? `（いま見ている Canvas：${job.canvasId}）` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

const defaultRun: RunQuery = async (params) => {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  return query(params)
}

async function defaultDeleteSession(sessionId: string, dir: string): Promise<void> {
  const { deleteSession } = await import('@anthropic-ai/claude-agent-sdk')
  await deleteSession(sessionId, { dir })
}

function summaryOf(job: StoredJob): JobSummary {
  const { events: _events, sessionId: _sessionId, ...summary } = job
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
    'After making or rearranging slides or a diagram, look at it with render_canvas and fix what looks wrong (not after every small edit).',
    'To place many nodes, follow "Placing many nodes" in get_canvas_format: read bounds once, place nodes relative to each other, continue from the boxes in the edit_canvas result, and pass ops a script generated as ops_file.',
    'The current directory is the CanvCode workspace; Markdown, Python and CSV files there are CanvCode documents.',
    'Skills in the workspace .claude/skills/ are available through the Skill tool.',
    'Subagents and long commands can run in the background. When one finishes you are woken and continue on your own; that reply is shown in the panel too.',
    'File tools (Read, Write, Edit, Glob, Grep) work only inside the workspace. Bash commands are approved or denied automatically; the ones that are not are shown to the user in the panel to approve or decline (unanswered ones are declined after a while).',
  ]
    .filter(Boolean)
    .join('\n')
}

// 許可の問い合わせの終わり方ごとの、Claude に返す言葉（今の askTool の言葉と同じく日本語）
const PERMISSION_TEXT = {
  denied: 'ユーザーが画面で断りました。同じことをもう一度試さず、何をしたかったかを書いて、どうするかをユーザーに尋ねてください',
  cancelled: 'ユーザーが依頼を止めたので、取り消しました',
}

function permissionText(answer: Exclude<PermissionAnswer, 'allowed'>, timeoutMs: number): string {
  if (answer === 'expired') {
    const span = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} 分` : `${Math.round(timeoutMs / 1000)} 秒`
    return `画面で ${span}のうちに誰も許可しなかったので断りました。ユーザーに、手で実行するか、もう一度頼むよう伝えてください`
  }
  return PERMISSION_TEXT[answer]
}

// 許可の問い合わせで見せる中身。Bash はコマンドの全文（断る判断の材料なので切らない）
function permissionDetail(name: string, input: Record<string, unknown>, workspace: string): string {
  if (name === 'Bash' && typeof input.command === 'string') return input.command
  return toolDetail(name, input, workspace) ?? JSON.stringify(input).slice(0, 2000)
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
