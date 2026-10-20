import { useSyncExternalStore } from 'react'

// 画面から Claude Code に頼む（サーバーの /api/claude。apps/server/src/claude/）。
// - 使えるか（サーバーが CANVCODE_CLAUDE=0 でないか）は、最初に GET /api/claude/threads で確かめる（会話の一覧も受け取る）
// - 会話（thread）はサーバーの SQLite にある。一覧だけを持ち、中身（ジョブと出来事）は開いたときに読む（loadThread）
// - 変化は /api/claude/events（SSE）で受け取る。つなぎ直すと、サーバーが一覧と動いているジョブ（snapshot）を送り直すので、
//   読んであった会話は読み直す（抜けた出来事があるかもしれないため）
// - 型はサーバーの claude/jobs.ts・claude/store.ts と同じ形

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled'

export type JobEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail?: string }
  | { kind: 'denied'; name: string; reason: string }
  | { kind: 'error'; message: string }

export interface ClaudeJob {
  id: string
  threadId: string
  prompt: string
  refId?: string
  canvasId?: string
  status: JobStatus
  createdAt: number
  finishedAt?: number
  costUsd?: number
  durationMs?: number
  eventCount: number
  events: JobEvent[]
}

export interface ThreadSummary {
  threadId: string
  title: string
  createdAt: number
  updatedAt: number
  jobCount: number
  running: boolean
}

export type StreamMessage =
  | { type: 'snapshot'; threads: ThreadSummary[]; running: ClaudeJob[] }
  | { type: 'job'; job: Omit<ClaudeJob, 'events'>; events: JobEvent[]; from: number; thread: ThreadSummary }
  | { type: 'thread-deleted'; threadId: string }

export interface StartRequest {
  prompt: string
  refId?: string
  canvasId?: string
  threadId?: string
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
}

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
    return { state: { ...state, threads: message.threads, jobs: new Map(message.running.map((job) => [job.id, job])), loaded: new Set() } }
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
      },
    }
  }
  const threads = sortThreads([message.thread, ...state.threads.filter((t) => t.threadId !== message.thread.threadId)])
  const jobs = new Map(state.jobs)
  const have = state.jobs.get(message.job.id)?.events ?? []
  if (message.from > have.length) {
    jobs.set(message.job.id, { ...message.job, events: have })
    return { state: { ...state, threads, jobs }, missing: message.job.id }
  }
  jobs.set(message.job.id, { ...message.job, events: [...have.slice(0, message.from), ...message.events] })
  return { state: { ...state, threads, jobs } }
}

// 会話のジョブ（古いものから）
export function jobsOfThread(state: ClaudeState, threadId: string): ClaudeJob[] {
  return [...state.jobs.values()].filter((job) => job.threadId === threadId).sort((a, b) => a.createdAt - b.createdAt)
}

function sortThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return threads.sort((a, b) => b.updatedAt - a.updatedAt)
}

// サーバーにつながらなかったときに、使えるか確かめ直すまでの時間
const RECHECK_MS = 10_000

export class ClaudeClient {
  // useSyncExternalStore に渡すので、変わったときだけ作り直す
  private snapshot: ClaudeState = { availability: 'checking', threads: [], jobs: new Map(), loaded: new Set() }
  private source: EventSource | null = null
  private recheck: number | null = null
  private readonly loading = new Set<string>()
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
      const { state, missing } = applyStreamMessage(this.snapshot, message)
      this.set(state)
      if (missing) void this.refetch(missing)
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
      const { jobs } = (await res.json()) as { jobs: ClaudeJob[] }
      const next = new Map(this.snapshot.jobs)
      for (const job of jobs) {
        // SSE で先に届いた分（読んでいる間に足された出来事）があれば、そちらを残す
        const current = next.get(job.id)
        if (!current || current.events.length <= job.events.length) next.set(job.id, job)
      }
      this.set({ ...this.snapshot, jobs: next, loaded: new Set(this.snapshot.loaded).add(threadId) })
    } catch (error) {
      console.warn('Failed to load a Claude thread', error)
    } finally {
      this.loading.delete(threadId)
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
      const thread: ThreadSummary = { threadId: job.threadId, title: job.prompt, createdAt: job.createdAt, updatedAt: job.createdAt, jobCount: 1, running: true }
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
