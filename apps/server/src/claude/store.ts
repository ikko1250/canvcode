import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk'
import type { ImportedQuestion, Job, JobEvent, JobStatus, JobSummary } from './jobs.ts'
import { isEffortLevel } from './models.ts'

// 画面から頼んだ Claude Code のジョブと会話（thread）を保存する（.canvcode/claude.db）。
// - ジョブ 1 つが 1 行。出来事（JobEvent）は 1 つずつ足す（届くたびに書く）
// - origin の列は後から足した（表の版は上げない。上げると、古いサーバーが claude.db を壊れたものとして脇に移してしまう。古いサーバーはこの列を読まないだけ）。
//   model・effort の列（MAI-106）、ref_label・imports の列（docs/claude-chat-tab-plan.md の 8）も同じように後から足した
// - 続きを頼むときは、その会話の最後のジョブの session_id を Claude Code の resume に渡す。
//   Claude Code の会話の中身（transcript）は Claude Code が ~/.claude/projects/ に持っているので、サーバーを再起動しても続けられる
// - 起動したときに動いていることになっているジョブは、止まったもの（failed）にする
// - 履歴なので、バックアップには入れない（backup.ts）。開けなければ、壊れたものを脇に置いて作り直す
// - 会話の質問（会話の入力欄の「質問」で、会話に入れずに聞いたもの。docs/claude-chat-tab-plan.md の 7）は、表 questions に置く。
//   付箋がないので、答えはここに書く。会話を消したら、その会話の質問も消す。起動したときに答えを作っていることになっているものは、失敗にする
// - 付箋の作業（AI 付箋から頼んだジョブ。docs/ai-note-tasks-plan.md）は、note_id・note_canvas_id の列に付箋を残す（後から足した列）。
//   付箋の作業しかない会話は、会話の一覧（threads）に出さない（会話から 1 つでも頼んだら出す）。thread は、どの会話も返す

export interface ThreadSummary {
  threadId: string
  // 最初の依頼の文
  title: string
  createdAt: number
  // 最後に動いた時刻（最後のジョブが終わった時刻か、頼んだ時刻）
  updatedAt: number
  jobCount: number
  running: boolean
  // 最後に頼んだ（バックグラウンドでない）依頼のモデルと effort（MAI-106。なければ既定）。前の会話を開いたとき、その値に戻す
  model?: string
  effort?: EffortLevel
  // 付箋の作業から始まった会話なら、その付箋。noteOnly は、付箋の作業しかない（会話の一覧に出さない）
  note?: NoteRef
  noteOnly?: true
}

// 付箋の作業を頼んだ付箋
export interface NoteRef {
  noteId: string
  canvasId: string
}

export interface StoredJob extends Job {
  sessionId?: string
}

export type ChatQuestionStatus = 'running' | 'done' | 'failed' | 'cancelled'

// 会話の質問（会話の入力欄の「質問」で、会話に入れずに聞いたもの）
export interface ChatQuestion {
  id: string
  // 聞いた会話（新しい会話から聞いたら、ない）
  threadId?: string
  // 質問（入力欄の文）
  question: string
  // 添えた前の答え（会話の最後の終わったジョブの、頼んだ文と答え）
  previous: { question: string; answer: string }[]
  // 答えの本文（Markdown。答えるまでない）
  body?: string
  model?: string
  effort?: string
  status: ChatQuestionStatus
  error?: string
  createdAt: number
  answeredAt?: number
}

const SCHEMA_VERSION = 1

interface JobRow {
  id: string
  thread_id: string
  prompt: string
  origin: string | null
  ref_id: string | null
  canvas_id: string | null
  status: string
  created_at: number
  finished_at: number | null
  cost_usd: number | null
  duration_ms: number | null
  session_id: string | null
  event_count: number
  model: string | null
  effort: string | null
  ref_label: string | null
  imports: string | null
  note_id: string | null
  note_canvas_id: string | null
}

interface QuestionRow {
  id: string
  thread_id: string | null
  question: string
  previous: string | null
  body: string | null
  model: string | null
  effort: string | null
  status: string
  error: string | null
  created_at: number
  answered_at: number | null
}

interface ThreadRow {
  thread_id: string
  title: string
  created_at: number
  updated_at: number
  job_count: number
  running: number
  model: string | null
  effort: string | null
  note_id: string | null
  note_canvas_id: string | null
  chat_jobs: number
}

export class ClaudeStore {
  private readonly db: DatabaseSync

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    const path = join(dataDir, 'claude.db')
    try {
      this.db = open(path)
    } catch (error) {
      if (!existsSync(path)) throw error
      const aside = `${path}.broken-${Date.now()}`
      console.error(`claude.db を開けないので ${aside} に移して作り直します`, error)
      renameSync(path, aside)
      this.db = open(path)
    }
  }

  insertJob(job: StoredJob): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, thread_id, prompt, origin, ref_id, ref_label, canvas_id, status, created_at, finished_at, cost_usd, duration_ms, session_id, event_count, model, effort, imports, note_id, note_canvas_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.threadId,
        job.prompt,
        job.origin ?? null,
        job.refId ?? null,
        job.refLabel ?? null,
        job.canvasId ?? null,
        job.status,
        job.createdAt,
        job.finishedAt ?? null,
        job.costUsd ?? null,
        job.durationMs ?? null,
        job.sessionId ?? null,
        job.events.length,
        job.model ?? null,
        job.effort ?? null,
        job.imports && job.imports.length > 0 ? JSON.stringify(job.imports) : null,
        job.note?.noteId ?? null,
        job.note?.canvasId ?? null,
      )
    job.events.forEach((event, seq) => this.appendEvent(job.id, seq, event))
  }

  appendEvent(jobId: string, seq: number, event: JobEvent): void {
    this.db.prepare('INSERT INTO events (job_id, seq, event) VALUES (?, ?, ?)').run(jobId, seq, JSON.stringify(event))
    this.db.prepare('UPDATE jobs SET event_count = ? WHERE id = ?').run(seq + 1, jobId)
  }

  setSession(jobId: string, sessionId: string): void {
    this.db.prepare('UPDATE jobs SET session_id = ? WHERE id = ?').run(sessionId, jobId)
  }

  finishJob(job: Pick<JobSummary, 'id' | 'status' | 'finishedAt' | 'costUsd' | 'durationMs'>): void {
    this.db
      .prepare('UPDATE jobs SET status = ?, finished_at = ?, cost_usd = ?, duration_ms = ? WHERE id = ?')
      .run(job.status, job.finishedAt ?? null, job.costUsd ?? null, job.durationMs ?? null, job.id)
  }

  job(id: string): StoredJob | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined
    return row && this.withEvents(row)
  }

  // 会話のジョブ（古いものから）
  threadJobs(threadId: string): StoredJob[] {
    const rows = this.db.prepare('SELECT * FROM jobs WHERE thread_id = ? ORDER BY created_at, rowid').all(threadId) as unknown as JobRow[]
    return rows.map((row) => this.withEvents(row))
  }

  lastOfThread(threadId: string): StoredJob | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(threadId) as
      | JobRow
      | undefined
    return row && this.withEvents(row)
  }

  thread(threadId: string): ThreadSummary | undefined {
    const row = this.db.prepare(`${THREAD_SELECT} WHERE thread_id = ? GROUP BY thread_id`).get(threadId) as ThreadRow | undefined
    return row && threadOf(row)
  }

  // 会話の一覧（最後に動いたものから）。付箋の作業しかない会話は入れない
  threads(limit = 200): ThreadSummary[] {
    const rows = this.db
      .prepare(`${THREAD_SELECT} GROUP BY thread_id HAVING SUM(note_id IS NULL) > 0 ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as unknown as ThreadRow[]
    return rows.map(threadOf)
  }

  // 会話の質問を書く（答えを作り始めたとき）
  insertQuestion(question: ChatQuestion): void {
    this.db
      .prepare(
        `INSERT INTO questions (id, thread_id, question, previous, body, model, effort, status, error, created_at, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        question.id,
        question.threadId ?? null,
        question.question,
        JSON.stringify(question.previous),
        question.body ?? null,
        question.model ?? null,
        question.effort ?? null,
        question.status,
        question.error ?? null,
        question.createdAt,
        question.answeredAt ?? null,
      )
  }

  // 会話の質問を終える（答えた・答えられなかった・やめた）。答えたときは本文と、実際に答えたモデル
  finishQuestion(id: string, end: { status: Exclude<ChatQuestionStatus, 'running'>; body?: string; model?: string; error?: string; answeredAt: number }): void {
    this.db
      .prepare('UPDATE questions SET status = ?, body = COALESCE(?, body), model = COALESCE(?, model), error = ?, answered_at = ? WHERE id = ?')
      .run(end.status, end.body ?? null, end.model ?? null, end.error ?? null, end.answeredAt, id)
  }

  question(id: string): ChatQuestion | undefined {
    const row = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as QuestionRow | undefined
    return row && questionOf(row)
  }

  // 会話の質問（聞いた順）
  threadQuestions(threadId: string): ChatQuestion[] {
    return (this.db.prepare('SELECT * FROM questions WHERE thread_id = ? ORDER BY created_at, rowid').all(threadId) as unknown as QuestionRow[]).map(questionOf)
  }

  // 答えた会話の質問（答えた時刻の新しいものから limit 件）
  answeredQuestions(limit = 100): ChatQuestion[] {
    return (
      this.db.prepare("SELECT * FROM questions WHERE status = 'done' ORDER BY answered_at DESC, rowid DESC LIMIT ?").all(limit) as unknown as QuestionRow[]
    ).map(questionOf)
  }

  // 会話を消す（その会話の質問も消す）。消したジョブの Claude Code の session_id を返す
  deleteThread(threadId: string): string[] {
    const sessions = (this.db.prepare('SELECT DISTINCT session_id FROM jobs WHERE thread_id = ? AND session_id IS NOT NULL').all(threadId) as {
      session_id: string
    }[]).map((row) => row.session_id)
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM events WHERE job_id IN (SELECT id FROM jobs WHERE thread_id = ?)').run(threadId)
      this.db.prepare('DELETE FROM jobs WHERE thread_id = ?').run(threadId)
      this.db.prepare('DELETE FROM questions WHERE thread_id = ?').run(threadId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return sessions
  }

  // 動いていることになっているジョブ（サーバーが止まって途切れたもの）を、止まったものにする。直した数を返す。
  // 答えを作っていることになっている会話の質問も、答えられなかったものにする（数には入れない）
  interruptRunning(message: string, now = Date.now()): number {
    const rows = this.db.prepare("SELECT id, event_count FROM jobs WHERE status = 'running'").all() as { id: string; event_count: number }[]
    for (const row of rows) {
      this.appendEvent(row.id, row.event_count, { kind: 'error', message })
      this.finishJob({ id: row.id, status: 'failed', finishedAt: now })
    }
    this.db.prepare("UPDATE questions SET status = 'failed', error = ?, answered_at = ? WHERE status = 'running'").run(message, now)
    return rows.length
  }

  close(): void {
    if (this.db.isOpen) this.db.close()
  }

  private withEvents(row: JobRow): StoredJob {
    const events = (this.db.prepare('SELECT event FROM events WHERE job_id = ? ORDER BY seq').all(row.id) as { event: string }[]).map(
      (e) => JSON.parse(e.event) as JobEvent,
    )
    return {
      id: row.id,
      threadId: row.thread_id,
      prompt: row.prompt,
      ...(row.origin === 'background' ? { origin: 'background' as const } : {}),
      ...(row.ref_id ? { refId: row.ref_id } : {}),
      ...(row.ref_label ? { refLabel: row.ref_label } : {}),
      ...(importsOf(row.imports) ? { imports: importsOf(row.imports)! } : {}),
      ...(row.canvas_id ? { canvasId: row.canvas_id } : {}),
      status: row.status as JobStatus,
      createdAt: row.created_at,
      ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
      ...(row.cost_usd !== null ? { costUsd: row.cost_usd } : {}),
      ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.model ? { model: row.model } : {}),
      ...(isEffortLevel(row.effort) ? { effort: row.effort } : {}),
      ...(row.note_id && row.note_canvas_id ? { note: { noteId: row.note_id, canvasId: row.note_canvas_id } } : {}),
      eventCount: events.length,
      events,
    }
  }
}

const THREAD_SELECT = `
  SELECT thread_id,
    (SELECT prompt FROM jobs AS first WHERE first.thread_id = jobs.thread_id ORDER BY created_at, rowid LIMIT 1) AS title,
    MIN(created_at) AS created_at,
    MAX(COALESCE(finished_at, created_at)) AS updated_at,
    COUNT(*) AS job_count,
    SUM(status = 'running') AS running,
    (SELECT model FROM jobs AS last WHERE last.thread_id = jobs.thread_id AND last.origin IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1) AS model,
    (SELECT effort FROM jobs AS last WHERE last.thread_id = jobs.thread_id AND last.origin IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1) AS effort,
    (SELECT note_id FROM jobs AS first WHERE first.thread_id = jobs.thread_id ORDER BY created_at, rowid LIMIT 1) AS note_id,
    (SELECT note_canvas_id FROM jobs AS first WHERE first.thread_id = jobs.thread_id ORDER BY created_at, rowid LIMIT 1) AS note_canvas_id,
    SUM(note_id IS NULL) AS chat_jobs
  FROM jobs`

function threadOf(row: ThreadRow): ThreadSummary {
  return {
    threadId: row.thread_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    jobCount: row.job_count,
    running: row.running > 0,
    ...(row.model ? { model: row.model } : {}),
    ...(isEffortLevel(row.effort) ? { effort: row.effort } : {}),
    ...(row.note_id && row.note_canvas_id ? { note: { noteId: row.note_id, canvasId: row.note_canvas_id } } : {}),
    ...(Number(row.chat_jobs) === 0 ? { noteOnly: true as const } : {}),
  }
}

// 取り込んだ質問と答え（JSON）。読めなければ、ないものにする
function importsOf(text: string | null): ImportedQuestion[] | undefined {
  if (!text) return undefined
  try {
    const value = JSON.parse(text) as unknown
    if (!Array.isArray(value)) return undefined
    const items = value.filter(
      (item): item is ImportedQuestion =>
        typeof item === 'object' && item !== null && typeof item.label === 'string' && typeof item.question === 'string' && typeof item.answer === 'string',
    )
    return items.length > 0 ? items : undefined
  } catch {
    return undefined
  }
}

function questionOf(row: QuestionRow): ChatQuestion {
  let previous: ChatQuestion['previous'] = []
  try {
    const value = JSON.parse(row.previous ?? '[]') as unknown
    if (Array.isArray(value)) {
      previous = value.filter((turn): turn is { question: string; answer: string } => typeof turn?.question === 'string' && typeof turn?.answer === 'string')
    }
  } catch {
    previous = []
  }
  return {
    id: row.id,
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    question: row.question,
    previous,
    ...(row.body !== null ? { body: row.body } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.effort ? { effort: row.effort } : {}),
    status: row.status as ChatQuestionStatus,
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    ...(row.answered_at !== null ? { answeredAt: row.answered_at } : {}),
  }
}

function open(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version > SCHEMA_VERSION) throw new Error(`claude.db is newer (version ${version}) than this server (${SCHEMA_VERSION})`)
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        origin TEXT,
        ref_id TEXT,
        canvas_id TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        cost_usd REAL,
        duration_ms INTEGER,
        session_id TEXT,
        event_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS jobs_thread ON jobs (thread_id, created_at);
      CREATE TABLE IF NOT EXISTS events (
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event TEXT NOT NULL,
        PRIMARY KEY (job_id, seq)
      );
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        thread_id TEXT,
        question TEXT NOT NULL,
        previous TEXT,
        body TEXT,
        model TEXT,
        effort TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        answered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS questions_thread ON questions (thread_id, created_at);
    `)
    // origin のない claude.db（前のサーバーが作ったもの）に足す
    const columns = db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]
    if (!columns.some((column) => column.name === 'origin')) db.exec('ALTER TABLE jobs ADD COLUMN origin TEXT')
    // model・effort のない claude.db に足す（MAI-106）
    if (!columns.some((column) => column.name === 'model')) db.exec('ALTER TABLE jobs ADD COLUMN model TEXT')
    if (!columns.some((column) => column.name === 'effort')) db.exec('ALTER TABLE jobs ADD COLUMN effort TEXT')
    // 添えた所の名前（ref_label）のない claude.db に足す（docs/claude-chat-tab-plan.md の 8）
    if (!columns.some((column) => column.name === 'ref_label')) db.exec('ALTER TABLE jobs ADD COLUMN ref_label TEXT')
    // 取り込んだ質問と答え（imports）のない claude.db に足す
    if (!columns.some((column) => column.name === 'imports')) db.exec('ALTER TABLE jobs ADD COLUMN imports TEXT')
    // 付箋の作業の付箋（note_id・note_canvas_id）のない claude.db に足す（docs/ai-note-tasks-plan.md）
    if (!columns.some((column) => column.name === 'note_id')) db.exec('ALTER TABLE jobs ADD COLUMN note_id TEXT')
    if (!columns.some((column) => column.name === 'note_canvas_id')) db.exec('ALTER TABLE jobs ADD COLUMN note_canvas_id TEXT')
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
