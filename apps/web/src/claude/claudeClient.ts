import { useSyncExternalStore } from 'react'

// 画面から Claude Code に頼む（サーバーの /api/claude。apps/server/src/claude/）。
// - 使えるか（サーバーが CANVCODE_CLAUDE=0 でないか）は、最初に GET /api/claude/jobs で確かめる
// - ジョブの様子は /api/claude/events（SSE）で受け取り、メモリに持つ。つなぎ直すと、サーバーが全体（snapshot）を送り直す
// - 型はサーバーの claude/jobs.ts と同じ形

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

export type StreamMessage =
  | { type: 'snapshot'; jobs: ClaudeJob[] }
  | { type: 'job'; job: Omit<ClaudeJob, 'events'>; events: JobEvent[]; from: number }

export interface StartRequest {
  prompt: string
  refId?: string
  canvasId?: string
  threadId?: string
}

export function useClaudeState(client: ClaudeClient): ClaudeState {
  return useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.state,
  )
}

// 'checking'：確かめている。'off'：サーバーで切ってある。'on'：使える
export type Availability = 'checking' | 'off' | 'on'

const BASE = '/api/claude'

// SSE のメッセージを、ジョブの表に当てる。足りない出来事があれば（つなぎ直しの間に抜けた）、そのジョブの id を missing に返す
export function applyStreamMessage(
  jobs: ReadonlyMap<string, ClaudeJob>,
  message: StreamMessage,
): { jobs: Map<string, ClaudeJob>; missing?: string } {
  if (message.type === 'snapshot') return { jobs: new Map(message.jobs.map((job) => [job.id, job])) }
  const next = new Map(jobs)
  const current = jobs.get(message.job.id)
  const have = current?.events ?? []
  if (message.from > have.length) {
    next.set(message.job.id, { ...message.job, events: have })
    return { jobs: next, missing: message.job.id }
  }
  next.set(message.job.id, { ...message.job, events: [...have.slice(0, message.from), ...message.events] })
  return { jobs: next }
}

// 会話（thread）ごとのジョブ（古いものから）。会話は、最後に動いたものから
export function threadsOf(jobs: Iterable<ClaudeJob>): { threadId: string; jobs: ClaudeJob[] }[] {
  const threads = new Map<string, ClaudeJob[]>()
  for (const job of [...jobs].sort((a, b) => a.createdAt - b.createdAt)) {
    const list = threads.get(job.threadId)
    if (list) list.push(job)
    else threads.set(job.threadId, [job])
  }
  return [...threads.entries()]
    .map(([threadId, list]) => ({ threadId, jobs: list }))
    .sort((a, b) => b.jobs[b.jobs.length - 1].createdAt - a.jobs[a.jobs.length - 1].createdAt)
}

export interface ClaudeState {
  availability: Availability
  jobs: ReadonlyMap<string, ClaudeJob>
}

// サーバーにつながらなかったときに、使えるか確かめ直すまでの時間
const RECHECK_MS = 10_000

export class ClaudeClient {
  private jobs = new Map<string, ClaudeJob>()
  private availability: Availability = 'checking'
  // useSyncExternalStore に渡すので、変わったときだけ作り直す
  private snapshot: ClaudeState = { availability: 'checking', jobs: this.jobs }
  private source: EventSource | null = null
  private recheck: number | null = null
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
    if (this.source || this.availability !== 'on') return
    const source = new EventSource(`${BASE}/events`)
    source.onmessage = (event) => {
      let message: StreamMessage
      try {
        message = JSON.parse(String(event.data)) as StreamMessage
      } catch {
        return
      }
      const { jobs, missing } = applyStreamMessage(this.jobs, message)
      this.jobs = jobs
      this.emit()
      if (missing) void this.refetch(missing)
    }
    this.source = source
  }

  async start(request: StartRequest): Promise<ClaudeJob> {
    const res = await fetch(`${BASE}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    const body = (await res.json().catch(() => ({}))) as { job?: ClaudeJob; error?: string }
    if (!res.ok || !body.job) throw new Error(body.error ?? `HTTP ${res.status}`)
    // SSE より先に応答が届くことがあるので、ここでも入れておく（SSE の出来事は from で重ねずに当たる）
    if (!this.jobs.has(body.job.id)) {
      this.jobs = new Map(this.jobs).set(body.job.id, body.job)
      this.emit()
    }
    return body.job
  }

  async cancel(id: string): Promise<void> {
    const res = await fetch(`${BASE}/jobs/${id}/cancel`, { method: 'POST' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
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
      const res = await fetch(`${BASE}/jobs`)
      if (res.ok) {
        this.jobs = new Map(((await res.json()) as { jobs: ClaudeJob[] }).jobs.map((job) => [job.id, job]))
        this.availability = 'on'
      } else if (res.status === 404) {
        this.availability = 'off'
      } else {
        throw new Error(`HTTP ${res.status}`)
      }
    } catch {
      this.recheck = window.setTimeout(() => void this.check(), RECHECK_MS)
      return
    }
    this.emit()
  }

  private async refetch(id: string): Promise<void> {
    try {
      const res = await fetch(`${BASE}/jobs/${id}`)
      if (!res.ok) return
      const { job } = (await res.json()) as { job: ClaudeJob }
      this.jobs = new Map(this.jobs).set(job.id, job)
      this.emit()
    } catch (error) {
      console.warn('Failed to fetch a Claude job', error)
    }
  }

  private emit(): void {
    this.snapshot = { availability: this.availability, jobs: this.jobs }
    for (const listener of this.listeners) listener()
  }
}
