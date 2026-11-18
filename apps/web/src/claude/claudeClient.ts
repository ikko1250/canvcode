import { useSyncExternalStore } from 'react'

// 画面から Claude Code に頼む（サーバーの /api/claude。apps/server/src/claude/）。
// - 使えるか（サーバーが CANVCODE_CLAUDE=0 でないか）は、最初に GET /api/claude/threads で確かめる（会話の一覧も受け取る）
// - 会話（thread）はサーバーの SQLite にある。一覧だけを持ち、中身（ジョブと出来事）は開いたときに読む（loadThread）
// - 変化は /api/claude/events（SSE）で受け取る。つなぎ直すと、サーバーが一覧と動いているジョブ（snapshot）を送り直すので、
//   読んであった会話は読み直す（抜けた出来事があるかもしれないため）
// - 会話には、動いているバックグラウンドの作業（tasks）と、画面で答えを待っている問い合わせ（permissions）が付く。
//   作業が終わって Claude が自分で続けたジョブは origin: 'background'
// - SSE は、使えるとわかったときにつなぐ（パネルを開く前でも、問い合わせを Claude のボタンの印で知らせるため）
// - 型はサーバーの claude/jobs.ts・claude/store.ts・claude/models.ts と同じ形
// - 選べるモデルと effort（MAI-106）は、パネルを開いたときに GET /api/claude/models で 1 回だけ読む（読めなければ、次に開いたときに読み直す）
// - 付箋で聞いている、動いている質問（サーバーの claude/questions.ts）も、同じ SSE で受ける（ほかのタブ・端末で頼んだものも）。
//   終わった質問は、終わり方を少しだけ覚える（finishedQuestions。頼んだ画面が、ほかのタブで止められたと知るため）
// - 会話の質問（会話の入力欄の「質問」で、会話に入れずに聞いたもの。docs/claude-chat-tab-plan.md の 7）は、会話を読むときに一緒に読む（chatQuestions）。
//   動いているものは付箋の質問と同じく SSE で受け（kind: 'chat'）、終わったら、その会話の質問を読み直す

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled'

// 推論の強さ（MAI-106）
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// 選べるモデル。value を model に渡す。efforts は選べる effort（effort のないモデルなら空）
export interface ModelChoice {
  value: string
  label: string
  description?: string
  efforts: Effort[]
}

// default は、モデルを渡さないとき（「既定」）に動くモデル。fromClaude は Claude Code に聞けたか（false なら固定の 3 つ）
export interface ModelCatalog {
  models: ModelChoice[]
  default: { value?: string; label?: string }
  fromClaude: boolean
}

export type JobEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail?: string }
  | { kind: 'denied'; name: string; reason: string }
  | { kind: 'error'; message: string }
  | { kind: 'task'; status: 'started' | 'completed' | 'failed' | 'stopped'; description: string }
  // 画面で許可を求めた（id は PendingPermission の id）と、その答え
  | { kind: 'ask'; id: string; name: string; detail: string; agent?: string }
  | { kind: 'answer'; id: string; result: PermissionAnswer }

// 許可の問い合わせの終わり方：許した・断った・時間切れ・取り消し
export type PermissionAnswer = 'allowed' | 'denied' | 'expired' | 'cancelled'

// 画面で答えを待っている問い合わせ（会話に付く）
export interface PendingPermission {
  id: string
  // 尋ねたときのジョブ（バックグラウンドのサブエージェントからなら、ない）
  jobId?: string
  name: string
  // Bash ならコマンドの全文
  detail: string
  description?: string
  // サブエージェントの中なら、その作業の名前
  agent?: string
  reason?: string
  createdAt: number
  expiresAt: number
}

// 会話に取り込んだ、付箋で聞いた質問と答え（サーバーの claude/jobs.ts の ImportedQuestion と同じ形）。会話の質問のときは questionId
export interface ImportedQuestion {
  // 質問の 1 行目
  label: string
  question: string
  // 答えの本文（Markdown）
  answer: string
  noteId?: string
  canvasId?: string
  questionId?: string
}

// 会話の質問（サーバーの claude/store.ts の ChatQuestion と同じ形）
export interface ChatQuestion {
  id: string
  threadId?: string
  question: string
  // 添えた前の答え
  previous: { question: string; answer: string }[]
  body?: string
  model?: string
  effort?: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  error?: string
  createdAt: number
  answeredAt?: number
}

// 会話の質問 1 つ（GET /api/claude/questions/chat/<id>）
export interface ChatQuestionDetail extends ChatQuestion {
  kind: 'chat'
  threadTitle?: string
}

export interface ClaudeJob {
  id: string
  threadId: string
  prompt: string
  origin?: 'background'
  refId?: string
  // 添えた所の名前（送ったときに画面が付けたもの。前のジョブにはない）
  refLabel?: string
  canvasId?: string
  status: JobStatus
  createdAt: number
  finishedAt?: number
  costUsd?: number
  durationMs?: number
  // 頼んだモデルと effort（なければ既定。MAI-106）
  model?: string
  effort?: Effort
  // 取り込んだ付箋の質問と答え
  imports?: ImportedQuestion[]
  eventCount: number
  events: JobEvent[]
}

export interface BackgroundTask {
  id: string
  description: string
  // local_agent（サブエージェント）・local_bash（コマンド）など
  type: string
}

// 付箋で聞いている、動いている質問（サーバーの claude/questions.ts の RunningQuestion と同じ形）。
// running：答えを作っている。placing：答えを頼んだ画面に渡し、付箋に書くのを待っている。
// kind が 'chat' なら会話の質問（noteId・canvasId はなく、会話から聞いたなら threadId）。kind のないものは付箋の質問（前のサーバー）
export interface RunningQuestion {
  id: string
  kind?: 'note' | 'chat'
  noteId?: string
  canvasId?: string
  threadId?: string
  // 質問の 1 行目
  label: string
  model?: string
  effort?: string
  status: 'running' | 'placing'
  step: 'read' | 'search' | 'write'
  // Web を調べたか
  searched: boolean
  thinking: string
  startedAt: number
}

export type QuestionStatus = 'done' | 'failed' | 'cancelled'

// 答えを持つ付箋（質問のタブの「過去の回答」。サーバーの claude/questions.ts の AnsweredNote と同じ形）
export interface AnsweredNote {
  kind?: 'note'
  noteId: string
  canvasId: string
  canvasTitle: string
  // 質問の 1 行目
  question: string
  model: string
  effort?: string
  answeredAt: number
}

// 答えた会話の質問（質問のタブの「過去の回答」。サーバーの claude/questions.ts の AnsweredChatQuestion と同じ形）
export interface AnsweredChatQuestion {
  kind: 'chat'
  id: string
  threadId?: string
  threadTitle?: string
  question: string
  model: string
  effort?: string
  answeredAt: number
}

export type AnsweredItem = AnsweredNote | AnsweredChatQuestion

// 1 つの付箋の答え（ai は付箋の meta.ai。related は、まだある関連する付箋と、その 1 行目）
export interface AnsweredNoteDetail extends AnsweredNote {
  ai: Record<string, unknown>
  related: { id: string; label: string }[]
}

export interface ThreadSummary {
  threadId: string
  title: string
  createdAt: number
  updatedAt: number
  jobCount: number
  running: boolean
  tasks?: BackgroundTask[]
  permissions?: PendingPermission[]
  // 最後に頼んだモデルと effort（なければ既定。MAI-106）
  model?: string
  effort?: Effort
}

export type StreamMessage =
  | { type: 'snapshot'; threads: ThreadSummary[]; running: ClaudeJob[]; questions?: RunningQuestion[] }
  | { type: 'question'; question: Omit<RunningQuestion, 'thinking'> }
  | { type: 'question-thinking'; id: string; text: string }
  | { type: 'question-done'; id: string; status: QuestionStatus; error?: string }
  | { type: 'job'; job: Omit<ClaudeJob, 'events'>; events: JobEvent[]; from: number; thread: ThreadSummary }
  | { type: 'thread'; thread: ThreadSummary }
  | { type: 'thread-deleted'; threadId: string }

export interface StartRequest {
  prompt: string
  refId?: string
  // 添えた所の名前（画面に出すだけ）
  refLabel?: string
  canvasId?: string
  threadId?: string
  model?: string
  effort?: Effort
  // 取り込む付箋の質問と答え（1 つまで）
  imports?: ImportedQuestion[]
}

// 'checking'：確かめている。'off'：サーバーで切ってある。'on'：使える
export type Availability = 'checking' | 'off' | 'on'

export interface ClaudeState {
  availability: Availability
  // 最後に動いたものから
  threads: readonly ThreadSummary[]
  // 読んだ会話のジョブと、届いたジョブ
  jobs: ReadonlyMap<string, ClaudeJob>
  // 中身を読んだ会話
  loaded: ReadonlySet<string>
  // 選べるモデルと effort（読むまでない。MAI-106）
  models?: ModelCatalog
  // 付箋で聞いている、動いている質問（古いものから）
  questions: readonly RunningQuestion[]
  // 終わった質問の終わり方（新しいものから KEPT_FINISHED_QUESTIONS 個）
  finishedQuestions: ReadonlyMap<string, QuestionStatus>
  // 読んだ会話の、会話の質問（id → 中身）
  chatQuestions: ReadonlyMap<string, ChatQuestion>
}

// 覚えておく、終わった質問の数と、動いている質問の考えている中身の長さ（サーバーと同じ）
export const KEPT_FINISHED_QUESTIONS = 50
const KEPT_QUESTION_THINKING = 20_000

export function useClaudeState(client: ClaudeClient): ClaudeState {
  return useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.state,
  )
}

const BASE = '/api/claude'

// SSE のメッセージを状態に当てる。足りない出来事があれば（つなぎ直しの間に抜けた）、そのジョブの id を missing に返す
export function applyStreamMessage(state: ClaudeState, message: StreamMessage): { state: ClaudeState; missing?: string } {
  if (message.type === 'snapshot') {
    return {
      state: { ...state, threads: message.threads, jobs: new Map(message.running.map((job) => [job.id, job])), loaded: new Set(), questions: message.questions ?? [] },
    }
  }
  if (message.type === 'question') {
    const known = state.questions.find((question) => question.id === message.question.id)
    const next = { ...message.question, thinking: known?.thinking ?? '' }
    return { state: { ...state, questions: known ? state.questions.map((question) => (question === known ? next : question)) : [...state.questions, next] } }
  }
  if (message.type === 'question-thinking') {
    const questions = state.questions.map((question) =>
      question.id === message.id ? { ...question, thinking: (question.thinking + message.text).slice(0, KEPT_QUESTION_THINKING) } : question,
    )
    return { state: { ...state, questions } }
  }
  if (message.type === 'question-done') {
    const earlier = [...state.finishedQuestions].filter(([id]) => id !== message.id)
    const finished = new Map<string, QuestionStatus>([[message.id, message.status] as const, ...earlier].slice(0, KEPT_FINISHED_QUESTIONS))
    // 会話の質問は、読み直すまで、終わり方の仮の行を置く（会話の欄のカードが、読み直すまで消えないように）
    const ended = state.questions.find((question) => question.id === message.id)
    const chatQuestions =
      ended?.kind === 'chat' && ended.threadId && !state.chatQuestions.has(ended.id)
        ? new Map(state.chatQuestions).set(ended.id, {
            id: ended.id,
            threadId: ended.threadId,
            question: ended.label,
            previous: [],
            status: message.status,
            ...(message.error ? { error: message.error } : {}),
            createdAt: ended.startedAt,
            answeredAt: Date.now(),
          })
        : state.chatQuestions
    return { state: { ...state, questions: state.questions.filter((question) => question.id !== message.id), finishedQuestions: finished, chatQuestions } }
  }
  if (message.type === 'thread-deleted') {
    const loaded = new Set(state.loaded)
    loaded.delete(message.threadId)
    return {
      state: {
        ...state,
        threads: state.threads.filter((t) => t.threadId !== message.threadId),
        jobs: new Map([...state.jobs].filter(([, job]) => job.threadId !== message.threadId)),
        loaded,
        chatQuestions: new Map([...state.chatQuestions].filter(([, question]) => question.threadId !== message.threadId)),
      },
    }
  }
  const threads = sortThreads([message.thread, ...state.threads.filter((t) => t.threadId !== message.thread.threadId)])
  if (message.type === 'thread') return { state: { ...state, threads } }
  const jobs = new Map(state.jobs)
  const known = state.jobs.get(message.job.id)
  const have = known?.events ?? []
  // 取り込んだ質問と答え（大きい）は、サーバーがジョブの初めにだけ送るので、前に受けたものを残す
  const job = known?.imports && !message.job.imports ? { ...message.job, imports: known.imports } : message.job
  if (message.from > have.length) {
    jobs.set(message.job.id, { ...job, events: have })
    return { state: { ...state, threads, jobs }, missing: message.job.id }
  }
  jobs.set(message.job.id, { ...job, events: [...have.slice(0, message.from), ...message.events] })
  return { state: { ...state, threads, jobs } }
}

// 会話に、答えを書いているジョブか、バックグラウンドの作業か、答えを待っている問い合わせがあるか
export function threadBusy(thread: ThreadSummary): boolean {
  return thread.running || (thread.tasks?.length ?? 0) > 0 || (thread.permissions?.length ?? 0) > 0
}

// 会話に、答えを待っている問い合わせがあるか（Claude のボタンの印）
export function threadAsking(thread: ThreadSummary): boolean {
  return (thread.permissions?.length ?? 0) > 0
}

// 会話のジョブ（古いものから）
export function jobsOfThread(state: ClaudeState, threadId: string): ClaudeJob[] {
  return [...state.jobs.values()].filter((job) => job.threadId === threadId).sort((a, b) => a.createdAt - b.createdAt)
}

// 会話の質問（聞いた順）。答えを作っているもの（SSE で届いた、まだ読み直していないもの）も、答えを作っている質問として入れる
export function questionsOfThread(state: ClaudeState, threadId: string): ChatQuestion[] {
  const stored = [...state.chatQuestions.values()].filter((question) => question.threadId === threadId)
  const known = new Set(stored.map((question) => question.id))
  const running = state.questions.flatMap((question): ChatQuestion[] =>
    question.kind === 'chat' && question.threadId === threadId && !known.has(question.id)
      ? [{ id: question.id, threadId, question: question.label, previous: [], status: 'running', createdAt: question.startedAt }]
      : [],
  )
  // 読み直す前に終わったと届いたもの（question-done）は、答えを作っている印を外す
  const live = new Set(state.questions.map((question) => question.id))
  return [...stored.map((question) => (question.status === 'running' && !live.has(question.id) && state.finishedQuestions.has(question.id) ? { ...question, status: state.finishedQuestions.get(question.id)! } : question)), ...running].sort(
    (a, b) => a.createdAt - b.createdAt,
  )
}

// 会話の質問を、読んだもので置き換える（その会話のものだけ）
function withQuestions(current: ReadonlyMap<string, ChatQuestion>, threadId: string, questions: readonly ChatQuestion[]): Map<string, ChatQuestion> {
  const next = new Map([...current].filter(([, question]) => question.threadId !== threadId))
  for (const question of questions) next.set(question.id, question)
  return next
}

function sortThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return threads.sort((a, b) => b.updatedAt - a.updatedAt)
}

// 本文のない POST。失敗したら、サーバーの error の文で投げる
async function post(url: string): Promise<void> {
  const res = await fetch(url, { method: 'POST' })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
}

// サーバーにつながらなかったときに、使えるか確かめ直すまでの時間
const RECHECK_MS = 10_000
// モデルの一覧を Claude Code に聞けなかった（固定の一覧だった）とき、読み直すまでの時間（サーバーが聞き直すのと同じ）
const MODELS_RETRY_MS = 60_000

export class ClaudeClient {
  // useSyncExternalStore に渡すので、変わったときだけ作り直す
  private snapshot: ClaudeState = {
    availability: 'checking',
    threads: [],
    jobs: new Map(),
    loaded: new Set(),
    questions: [],
    finishedQuestions: new Map(),
    chatQuestions: new Map(),
  }
  private source: EventSource | null = null
  private recheck: number | null = null
  private readonly loading = new Set<string>()
  private loadingModels = false
  // 最後にモデルの一覧を読んだ時刻（Claude Code に聞けなかった固定の一覧なら、MODELS_RETRY_MS たってから読み直す）
  private modelsAt = 0
  private readonly listeners = new Set<() => void>()

  constructor() {
    void this.check()
  }

  get state(): ClaudeState {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // SSE をつなぐ（パネルを初めて開いたとき）。つないだままにする
  connect(): void {
    if (this.source || this.snapshot.availability !== 'on') return
    const source = new EventSource(`${BASE}/events`)
    source.onmessage = (event) => {
      let message: StreamMessage
      try {
        message = JSON.parse(String(event.data)) as StreamMessage
      } catch {
        return
      }
      // 会話の質問が終わったら、その会話の質問を読み直す（答えはサーバーの claude.db にある）
      const ended = message.type === 'question-done' ? this.snapshot.questions.find((question) => question.id === message.id) : undefined
      const { state, missing } = applyStreamMessage(this.snapshot, message)
      this.set(state)
      if (missing) void this.refetch(missing)
      if (ended?.kind === 'chat' && ended.threadId && this.snapshot.loaded.has(ended.threadId)) void this.reloadQuestions(ended.threadId)
    }
    this.source = source
  }

  // 会話の中身を読む（読んでいれば何もしない）
  async loadThread(threadId: string): Promise<void> {
    if (this.snapshot.loaded.has(threadId) || this.loading.has(threadId)) return
    this.loading.add(threadId)
    try {
      const res = await fetch(`${BASE}/threads/${threadId}`)
      if (!res.ok) return
      const { jobs, questions = [] } = (await res.json()) as { jobs: ClaudeJob[]; questions?: ChatQuestion[] }
      const next = new Map(this.snapshot.jobs)
      for (const job of jobs) {
        // SSE で先に届いた分（読んでいる間に足された出来事）があれば、そちらを残す
        const current = next.get(job.id)
        if (!current || current.events.length <= job.events.length) next.set(job.id, job)
      }
      this.set({ ...this.snapshot, jobs: next, loaded: new Set(this.snapshot.loaded).add(threadId), chatQuestions: withQuestions(this.snapshot.chatQuestions, threadId, questions) })
    } catch (error) {
      console.warn('Failed to load a Claude thread', error)
    } finally {
      this.loading.delete(threadId)
    }
  }

  // 会話の質問を読み直す（会話の質問が終わったとき）
  async reloadQuestions(threadId: string): Promise<void> {
    try {
      const res = await fetch(`${BASE}/threads/${threadId}`)
      if (!res.ok) return
      const { questions = [] } = (await res.json()) as { questions?: ChatQuestion[] }
      this.set({ ...this.snapshot, chatQuestions: withQuestions(this.snapshot.chatQuestions, threadId, questions) })
    } catch (error) {
      console.warn('Failed to load the questions of a Claude thread', error)
    }
  }

  // 会話の質問 1 つ。なければ null
  async chatQuestion(id: string): Promise<ChatQuestionDetail | null> {
    const res = await fetch(`${BASE}/questions/chat/${encodeURIComponent(id)}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as ChatQuestionDetail
  }

  // 選べるモデルと effort を読む（読んであれば何もしない。MAI-106）
  async loadModels(): Promise<void> {
    const models = this.snapshot.models
    if (this.loadingModels || this.snapshot.availability !== 'on') return
    if (models && (models.fromClaude || Date.now() - this.modelsAt < MODELS_RETRY_MS)) return
    this.loadingModels = true
    try {
      const res = await fetch(`${BASE}/models`)
      if (!res.ok) return
      const loaded = (await res.json()) as ModelCatalog
      this.modelsAt = Date.now()
      this.set({ ...this.snapshot, models: loaded })
    } catch (error) {
      console.warn('Failed to load the Claude models', error)
    } finally {
      this.loadingModels = false
    }
  }

  async start(request: StartRequest): Promise<ClaudeJob> {
    const res = await fetch(`${BASE}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    const body = (await res.json().catch(() => ({}))) as { job?: ClaudeJob; error?: string }
    if (!res.ok || !body.job) throw new Error(body.error ?? `HTTP ${res.status}`)
    const job = body.job
    // SSE より先に応答が届くことがあるので、ここでも入れておく（SSE の出来事は from で重ねずに当たる）
    // 新しい会話なら、一覧にも入れておく（SSE の変化が届けば、それで置き換わる）
    if (!this.snapshot.jobs.has(job.id)) {
      const known = this.snapshot.threads.some((t) => t.threadId === job.threadId)
      const thread: ThreadSummary = {
        threadId: job.threadId,
        title: job.prompt,
        createdAt: job.createdAt,
        updatedAt: job.createdAt,
        jobCount: 1,
        running: true,
        ...(job.model ? { model: job.model } : {}),
        ...(job.effort ? { effort: job.effort } : {}),
      }
      this.set({
        ...this.snapshot,
        threads: known ? this.snapshot.threads : [thread, ...this.snapshot.threads],
        jobs: new Map(this.snapshot.jobs).set(job.id, job),
        loaded: known ? this.snapshot.loaded : new Set(this.snapshot.loaded).add(job.threadId),
      })
    }
    return job
  }

  async cancel(id: string): Promise<void> {
    const res = await fetch(`${BASE}/jobs/${id}/cancel`, { method: 'POST' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  }

  // 会話のプロセスごと止める（答えもバックグラウンドの作業も）
  async stopThread(threadId: string): Promise<void> {
    await post(`${BASE}/threads/${threadId}/stop`)
  }

  // バックグラウンドの作業を 1 つ止める
  async stopTask(threadId: string, taskId: string): Promise<void> {
    await post(`${BASE}/threads/${threadId}/tasks/${encodeURIComponent(taskId)}/stop`)
  }

  // 画面で待っている問い合わせに答える。サーバーは JSON だけを受ける（別のサイトのフォームから送らせないため）。
  // 一覧から消すのは、SSE で会話の変化が届いたとき
  async answerPermission(threadId: string, permissionId: string, decision: 'allow' | 'deny'): Promise<void> {
    const res = await fetch(`${BASE}/threads/${threadId}/permissions/${permissionId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error ?? `HTTP ${res.status}`)
    }
  }

  // 答えを持つ付箋と、答えた会話の質問の一覧（新しいものから）。canvasId を渡せば、その Canvas の付箋のものだけ
  async answeredNotes(canvasId?: string): Promise<AnsweredItem[]> {
    const res = await fetch(`${BASE}/questions${canvasId ? `?canvasId=${encodeURIComponent(canvasId)}` : ''}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return ((await res.json()) as { questions: AnsweredItem[] }).questions
  }

  // 1 つの付箋の答え。なければ null
  async answeredNote(noteId: string): Promise<AnsweredNoteDetail | null> {
    const res = await fetch(`${BASE}/questions/${encodeURIComponent(noteId)}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as AnsweredNoteDetail
  }

  // 付箋で聞いている質問を止める（ほかのタブで頼んだものも）。もう終わっていれば何もしない
  async cancelQuestion(id: string): Promise<void> {
    const res = await fetch(`${BASE}/questions/${id}/cancel`, { method: 'POST' })
    if (!res.ok && res.status !== 404) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error ?? `HTTP ${res.status}`)
    }
  }

  // 頼んだ画面が、答えを付箋に書いた（書けなかった・やめた）と知らせる。届かなくても、サーバーがしばらくして終える
  async finishQuestion(id: string, status: QuestionStatus, error?: string): Promise<void> {
    try {
      await fetch(`${BASE}/questions/${id}/finish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status, ...(error ? { error } : {}) }),
      })
    } catch (failure) {
      console.warn('Failed to tell the server that a question ended', failure)
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    const res = await fetch(`${BASE}/threads/${threadId}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 404) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error ?? `HTTP ${res.status}`)
    }
    this.set(applyStreamMessage(this.snapshot, { type: 'thread-deleted', threadId }).state)
  }

  dispose(): void {
    if (this.recheck !== null) window.clearTimeout(this.recheck)
    this.source?.close()
    this.source = null
    this.listeners.clear()
  }

  // 使えるか確かめる。404 なら切ってある。サーバーにつながらなければ、しばらくして確かめ直す
  private async check(): Promise<void> {
    this.recheck = null
    try {
      const res = await fetch(`${BASE}/threads`)
      if (res.ok) {
        const { threads } = (await res.json()) as { threads: ThreadSummary[] }
        this.set({ ...this.snapshot, availability: 'on', threads })
        // パネルを開く前から SSE をつなぐ（許可を待っている問い合わせを、閉じたパネルの Claude のボタンに印で出すため）
        this.connect()
      } else if (res.status === 404) {
        this.set({ ...this.snapshot, availability: 'off' })
      } else {
        throw new Error(`HTTP ${res.status}`)
      }
    } catch {
      this.recheck = window.setTimeout(() => void this.check(), RECHECK_MS)
    }
  }

  private async refetch(id: string): Promise<void> {
    try {
      const res = await fetch(`${BASE}/jobs/${id}`)
      if (!res.ok) return
      const { job } = (await res.json()) as { job: ClaudeJob }
      this.set({ ...this.snapshot, jobs: new Map(this.snapshot.jobs).set(job.id, job) })
    } catch (error) {
      console.warn('Failed to fetch a Claude job', error)
    }
  }

  private set(state: ClaudeState): void {
    this.snapshot = state
    for (const listener of this.listeners) listener()
  }
}
