import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJson, sendError, sendJson } from './http.ts'
import { JobError } from './jobs.ts'

// 付箋で聞いている、動いている質問（docs/canvas-answer-panel-plan.md の 2.3）。
// - 付箋で聞く答え（claude/answer.ts）を NDJSON で頼むとき、どの付箋の質問か（source）を添えると、ここに載る。
//   サーバーのメモリにだけ持ち、Claude のパネルの SSE（GET /api/claude/events。claude/http.ts）で、すべてのタブ・端末に流す。
//   ほかのタブで頼んだものも、一覧に出し、付箋の三角を点滅させ、止められるように
// - 答えを付箋に書くのは、頼んだ画面（文字の編集の最中に書かないよう、終わるのを待ってから書くため）。答えを画面に渡したら placing にし、
//   画面が付箋に書いた（書けなかった）と知らせて（finish）終わる。知らせが来ないまま PLACING_TIMEOUT_MS たったら（頼んだ画面を閉じたなど）、
//   done として終わりにする（ほかのタブは読み直して、書けていれば出る）
// - 止める（cancel）：どのタブからでも。答えを作っている間なら Claude を止め、頼んだ画面の NDJSON は「やめました」で終わる。
//   placing なら、頼んだ画面に知らせるだけ（SSE の question-done。頼んだ画面は、付箋に書くのをやめる）
// - POST /api/claude/questions/<id>/cancel：止める。204（もうなければ 404）
// - POST /api/claude/questions/<id>/finish { status: 'done' | 'failed' | 'cancelled', error? }：頼んだ画面が、付箋に書いたかを知らせる。204（もうなければ 404）。
//   content-type は application/json だけ受ける（別のサイトのフォームから送らせないため。415）
// - SSE に流すもの：つないだときの snapshot の questions（動いているものすべて。考えている中身も）、
//   { type: 'question', question }（始まった・進み具合が変わった・placing になった。考えている中身は入れない）、
//   { type: 'question-thinking', id, text }（考えている中身の続き）、{ type: 'question-done', id, status, error? }（終わった）

// 答えを画面に渡してから、付箋に書いたと知らせが来るまで待つ時間（ミリ秒）
export const PLACING_TIMEOUT_MS = 10 * 60_000
// 1 つの質問の、覚えておく考えている中身の長さ（文字。超えた分は覚えないが、SSE には流す）
export const KEPT_QUESTION_THINKING = 20_000
// 質問の名前（質問の 1 行目）の長さ
const MAX_LABEL_LENGTH = 60

export type QuestionStep = 'read' | 'search' | 'write'
export type QuestionStatus = 'done' | 'failed' | 'cancelled'

// どの付箋の質問か（画面が送る）
export interface QuestionSource {
  noteId: string
  canvasId: string
  // 質問の 1 行目
  label: string
}

export interface RunningQuestion extends QuestionSource {
  id: string
  model?: string
  effort?: string
  // running：答えを作っている。placing：答えを画面に渡し、付箋に書くのを待っている
  status: 'running' | 'placing'
  step: QuestionStep
  thinking: string
  startedAt: number
}

export type QuestionChange =
  | { type: 'question'; question: Omit<RunningQuestion, 'thinking'> }
  | { type: 'question-thinking'; id: string; text: string }
  | { type: 'question-done'; id: string; status: QuestionStatus; error?: string }

export type QuestionListener = (change: QuestionChange) => void

interface Entry {
  question: RunningQuestion
  // 答えを作っている間に止める（placing になったら使わない）
  abort: () => void
  timer: ReturnType<typeof setTimeout> | null
}

export class RunningQuestions {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<QuestionListener>()
  private readonly placingTimeoutMs: number

  constructor(options: { placingTimeoutMs?: number } = {}) {
    this.placingTimeoutMs = options.placingTimeoutMs ?? PLACING_TIMEOUT_MS
  }

  // 動いているもの（古いものから。考えている中身も）
  list(): RunningQuestion[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.question }))
  }

  subscribe(listener: QuestionListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // 始まった。abort は、止めるときに呼ぶ（Claude を止める）。id を返す
  start(source: QuestionSource, setting: { model?: string; effort?: string }, abort: () => void): string {
    const id = randomUUID()
    const question: RunningQuestion = {
      id,
      ...source,
      ...(setting.model ? { model: setting.model } : {}),
      ...(setting.effort ? { effort: setting.effort } : {}),
      status: 'running',
      step: 'read',
      thinking: '',
      startedAt: Date.now(),
    }
    this.entries.set(id, { question, abort, timer: null })
    this.emitQuestion(question)
    return id
  }

  step(id: string, step: QuestionStep): void {
    const entry = this.entries.get(id)
    if (!entry || entry.question.step === step) return
    entry.question = { ...entry.question, step }
    this.emitQuestion(entry.question)
  }

  thinking(id: string, text: string): void {
    const entry = this.entries.get(id)
    if (!entry || !text) return
    const room = KEPT_QUESTION_THINKING - entry.question.thinking.length
    if (room > 0) entry.question = { ...entry.question, thinking: entry.question.thinking + text.slice(0, room) }
    this.emit({ type: 'question-thinking', id, text })
  }

  // 答えを画面に渡した。model は実際に答えたモデル。付箋に書いたと知らせが来るまで待つ（来なければ PLACING_TIMEOUT_MS で終わる）
  placing(id: string, model?: string): void {
    const entry = this.entries.get(id)
    if (!entry || entry.question.status === 'placing') return
    entry.question = { ...entry.question, status: 'placing', step: 'write', ...(model ? { model } : {}) }
    entry.timer = setTimeout(() => this.end(id, 'done'), this.placingTimeoutMs)
    entry.timer.unref?.()
    this.emitQuestion(entry.question)
  }

  // 終わった（答えられなかった・やめた。頼んだ画面が付箋に書いた）。もうなければ false
  end(id: string, status: QuestionStatus, error?: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    if (entry.timer) clearTimeout(entry.timer)
    this.entries.delete(id)
    this.emit({ type: 'question-done', id, status, ...(error ? { error } : {}) })
    return true
  }

  // 止める。答えを作っている間なら Claude を止め（答えを書く仕組みが cancelled で終える）、placing なら、ここで終える。もうなければ false
  cancel(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    if (entry.question.status === 'placing') return this.end(id, 'cancelled')
    entry.abort()
    return true
  }

  private emitQuestion(question: RunningQuestion): void {
    const { thinking: _thinking, ...rest } = question
    this.emit({ type: 'question', question: rest })
  }

  private emit(change: QuestionChange): void {
    for (const listener of this.listeners) listener(change)
  }
}

// 画面が送った source（どの付箋の質問か）。なければ undefined。形が合わなければ 400
export function parseQuestionSource(value: unknown): QuestionSource | undefined {
  if (value === undefined) return undefined
  const { noteId, canvasId, label } = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  if (typeof noteId !== 'string' || !/^node:[A-Za-z0-9_-]{1,64}$/.test(noteId)) throw new JobError(400, 'invalid source')
  if (typeof canvasId !== 'string' || !/^canvas:[A-Za-z0-9_-]{1,64}$/.test(canvasId)) throw new JobError(400, 'invalid source')
  const text = typeof label === 'string' ? Array.from(label.replace(/\s+/g, ' ').trim()).slice(0, MAX_LABEL_LENGTH).join('') : ''
  return { noteId, canvasId, label: text || '（質問）' }
}

const QUESTION_PATH = /^\/api\/claude\/questions\/([0-9a-f-]{36})\/(cancel|finish)$/

export function handleQuestions(req: IncomingMessage, res: ServerResponse, path: string, questions: RunningQuestions | null): boolean {
  const match = QUESTION_PATH.exec(path)
  if (!match || !questions) return false
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  const [, id, action] = match
  if (action === 'cancel') {
    if (questions.cancel(id!)) {
      res.writeHead(204)
      res.end()
    } else sendJson(res, 404, { error: 'question not found' })
    return true
  }
  void finish(req, res, questions, id!)
  return true
}

async function finish(req: IncomingMessage, res: ServerResponse, questions: RunningQuestions, id: string): Promise<void> {
  try {
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
    if (type !== 'application/json') throw new JobError(415, 'content-type must be application/json')
    const body = await readJson(req)
    const { status, error } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
    if (status !== 'done' && status !== 'failed' && status !== 'cancelled') throw new JobError(400, "status must be 'done', 'failed' or 'cancelled'")
    const message = typeof error === 'string' && error.trim() ? Array.from(error.trim()).slice(0, 500).join('') : undefined
    if (!questions.end(id, status, message)) throw new JobError(404, 'question not found')
    res.writeHead(204)
    res.end()
  } catch (error) {
    sendError(res, error)
  }
}
