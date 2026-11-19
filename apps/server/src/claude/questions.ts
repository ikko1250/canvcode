import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { plainTextOf, richTextFromMarkdown, type TextParagraph } from '@canvcode/nodes'
import type { RecordStore, StoredRecord } from '../records.ts'
import { readJson, sendError, sendJson } from './http.ts'
import { JobError } from './jobs.ts'
import type { ClaudeStore } from './store.ts'

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
// - 答えを持つ付箋の一覧（質問のタブの「過去の回答」。2.2）：画面は開いた Canvas の分だけレコードを読むので、ほかの Canvas の答えはここから読む。
//   GET /api/claude/questions?canvasId=…：答えを持つ付箋（答えた時刻の新しいものから ANSWERED_LIMIT 件。ゴミ箱の中の Canvas のものは除く）。
//   { questions: AnsweredNote[] }。canvasId を省けば、すべての Canvas
//   GET /api/claude/questions/<付箋の id>：その付箋の meta.ai（答えと添えたもの）と、関連する付箋の名前。なければ 404
// - 会話の質問（会話の入力欄の「質問」で、会話に入れずに聞いたもの。docs/claude-chat-tab-plan.md の 7）：source が { kind: 'chat', threadId?, label }。
//   付箋がないので、サーバーが答えを claude.db（表 questions）に書いてから done で終える（placing はない）。
//   一覧（GET /api/claude/questions）には混ぜない（会話の質問は会話の欄に出す。docs/ai-note-tasks-plan.md の E）。
//   GET /api/claude/questions/chat/<id>：会話の質問 1 つ（{ kind: 'chat', ...ChatQuestion, threadTitle? }）。なければ 404

// 答えを画面に渡してから、付箋に書いたと知らせが来るまで待つ時間（ミリ秒）
export const PLACING_TIMEOUT_MS = 10 * 60_000
// 1 つの質問の、覚えておく考えている中身の長さ（文字。超えた分は覚えないが、SSE には流す）
export const KEPT_QUESTION_THINKING = 20_000
// 質問の名前（質問の 1 行目）の長さ
const MAX_LABEL_LENGTH = 60

export type QuestionStep = 'read' | 'search' | 'write'
export type QuestionStatus = 'done' | 'failed' | 'cancelled'

// どの付箋の質問か・どの会話の質問か（画面が送る。label は質問の 1 行目）。kind のないものは付箋の質問（前の画面が送るもの）
export type QuestionSource =
  | { kind: 'note'; noteId: string; canvasId: string; label: string }
  // 会話の質問（新しい会話から聞いたら threadId はない）
  | { kind: 'chat'; threadId?: string; label: string }

export type RunningQuestion = QuestionSource & {
  id: string
  model?: string
  effort?: string
  // running：答えを作っている。placing：答えを画面に渡し、付箋に書くのを待っている
  status: 'running' | 'placing'
  step: QuestionStep
  // Web を調べたか（一度でも search になったか）
  searched: boolean
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
  // id は、呼ぶ側が決めたいとき（質問だけの会話にするとき、会話の id にも使う）
  start(source: QuestionSource, setting: { model?: string; effort?: string }, abort: () => void, id: string = randomUUID()): string {
    const question = {
      id,
      ...source,
      ...(setting.model ? { model: setting.model } : {}),
      ...(setting.effort ? { effort: setting.effort } : {}),
      status: 'running',
      step: 'read',
      searched: false,
      thinking: '',
      startedAt: Date.now(),
    } as RunningQuestion
    this.entries.set(id, { question, abort, timer: null })
    this.emitQuestion(question)
    return id
  }

  step(id: string, step: QuestionStep): void {
    const entry = this.entries.get(id)
    if (!entry || entry.question.step === step) return
    entry.question = { ...entry.question, step, ...(step === 'search' ? { searched: true } : {}) }
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

  // その会話から聞いている会話の質問を、みな止める（会話を消したとき）
  cancelThread(threadId: string): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.question.kind === 'chat' && entry.question.threadId === threadId) this.cancel(entry.question.id)
    }
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

// 画面が送った source（どの付箋の質問か・どの会話の質問か）。なければ undefined。形が合わなければ 400
export function parseQuestionSource(value: unknown): QuestionSource | undefined {
  if (value === undefined) return undefined
  const { kind, noteId, canvasId, threadId, label } = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const text = (typeof label === 'string' ? Array.from(label.replace(/\s+/g, ' ').trim()).slice(0, MAX_LABEL_LENGTH).join('') : '') || '（質問）'
  if (kind === 'chat') {
    if (threadId !== undefined && (typeof threadId !== 'string' || !/^[0-9a-f-]{36}$/.test(threadId))) throw new JobError(400, 'invalid source')
    return { kind: 'chat', ...(threadId !== undefined ? { threadId } : {}), label: text }
  }
  if (kind !== undefined && kind !== 'note') throw new JobError(400, 'invalid source')
  if (typeof noteId !== 'string' || !/^node:[A-Za-z0-9_-]{1,64}$/.test(noteId)) throw new JobError(400, 'invalid source')
  if (typeof canvasId !== 'string' || !/^canvas:[A-Za-z0-9_-]{1,64}$/.test(canvasId)) throw new JobError(400, 'invalid source')
  return { kind: 'note', noteId, canvasId, label: text }
}

// 答えを持つ付箋の一覧で返す数と、名前（質問・関連する付箋の 1 行目）の長さ
export const ANSWERED_LIMIT = 100
const RELATED_LABEL_LENGTH = 30

// 答えを持つ付箋（一覧の 1 行）
export interface AnsweredNote {
  kind: 'note'
  noteId: string
  canvasId: string
  canvasTitle: string
  // 質問の 1 行目
  question: string
  model: string
  effort?: string
  answeredAt: number
}

export interface AnsweredNoteDetail extends AnsweredNote {
  // 付箋の meta.ai（答えと添えたもの）
  ai: Record<string, unknown>
  // 関連する付箋のうち、まだあるもの（名前は 1 行目）
  related: { id: string; label: string }[]
}

export interface AnsweredNotes {
  list(canvasId?: string): AnsweredNote[]
  detail(noteId: string): AnsweredNoteDetail | null
}

// 会話の質問の置き場所（claude/store.ts）
export type ChatQuestionStore = Pick<ClaudeStore, 'insertQuestion' | 'finishQuestion' | 'question' | 'thread'>

// ワークスペースのレコードから読む
export function answeredNotesOf(records: Pick<RecordStore, 'answeredNotes' | 'get' | 'canvasOf'>): AnsweredNotes {
  const row = (record: StoredRecord, canvasId: string, canvasTitle: string): AnsweredNote | null => {
    const answer = aiOf(record)?.answer as Record<string, unknown> | undefined
    if (!answer || typeof answer.question !== 'string') return null
    return {
      kind: 'note',
      noteId: record.id,
      canvasId,
      canvasTitle,
      question: firstLine(answer.question, MAX_LABEL_LENGTH),
      model: typeof answer.model === 'string' ? answer.model : '',
      ...(typeof answer.effort === 'string' ? { effort: answer.effort } : {}),
      answeredAt: typeof answer.answeredAt === 'number' ? answer.answeredAt : 0,
    }
  }
  return {
    list: (canvasId) => records.answeredNotes(ANSWERED_LIMIT, canvasId).flatMap((item) => row(item.record, item.canvasId, item.canvasTitle) ?? []),
    detail: (noteId) => {
      const record = records.get(noteId)
      const canvasId = record ? records.canvasOf(noteId) : null
      const canvas = canvasId ? (records.get(canvasId) as (StoredRecord & { title?: unknown; deletedAt?: unknown }) | undefined) : undefined
      if (!record || !canvasId || !canvas || canvas.deletedAt) return null
      const found = row(record, canvasId, typeof canvas.title === 'string' ? canvas.title : '')
      const ai = aiOf(record)
      if (!found || !ai) return null
      const related = (Array.isArray((ai.answer as { related?: unknown }).related) ? ((ai.answer as { related: unknown[] }).related as unknown[]) : []).flatMap((id) => {
        const note = typeof id === 'string' ? records.get(id) : undefined
        const text = note && (note as { type?: unknown }).type === 'note' ? paragraphsText(note) : ''
        return note && text ? [{ id: id as string, label: firstLine(text, RELATED_LABEL_LENGTH, true) }] : []
      })
      return { ...found, ai, related }
    },
  }
}

function aiOf(record: StoredRecord): Record<string, unknown> | null {
  if ((record as { type?: unknown }).type !== 'note') return null
  const ai = (record as { meta?: { ai?: unknown } }).meta?.ai
  return typeof ai === 'object' && ai !== null ? (ai as Record<string, unknown>) : null
}

function paragraphsText(record: StoredRecord): string {
  const paragraphs = (record as { props?: { paragraphs?: unknown } }).props?.paragraphs
  return Array.isArray(paragraphs) ? plainTextOf(paragraphs as TextParagraph[]) : ''
}

// 最初の空でない行（plain でなければ、付箋の Markdown の書式の記号を外す）。長ければ切る
function firstLine(text: string, length: number, plain = false): string {
  const line = (plain ? text : plainTextOf(richTextFromMarkdown(text))).split('\n').find((part) => part.trim() !== '')?.trim() ?? ''
  const chars = Array.from(line)
  return (chars.length > length ? `${chars.slice(0, length - 1).join('')}…` : line) || '（質問）'
}

const QUESTION_PATH = /^\/api\/claude\/questions\/([0-9a-f-]{36})\/(cancel|finish)$/
const ANSWERED_PATH = /^\/api\/claude\/questions\/((?:node(?::|%3A))[A-Za-z0-9_-]{1,64})$/i
const CHAT_PATH = /^\/api\/claude\/questions\/chat\/([0-9a-f-]{36})$/

// chat は会話の質問の置き場所（渡さなければ、会話の質問は一覧に出さない）
export function handleQuestions(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  questions: RunningQuestions | null,
  answered: AnsweredNotes | null = null,
  chat: ChatQuestionStore | null = null,
): boolean {
  if (!questions) return false
  const chatMatch = CHAT_PATH.exec(path)
  if (chatMatch) {
    if (!chat) return false
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    const found = chat.question(chatMatch[1]!)
    const title = found?.threadId ? chat.thread(found.threadId)?.title : undefined
    if (found) sendJson(res, 200, { kind: 'chat', ...found, ...(title ? { threadTitle: title } : {}) })
    else sendJson(res, 404, { error: 'question not found' })
    return true
  }
  if (path === '/api/claude/questions' || ANSWERED_PATH.test(path)) {
    if (!answered) return false
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    if (path === '/api/claude/questions') {
      const canvasId = new URL(req.url ?? '/', 'http://x').searchParams.get('canvasId') || undefined
      // 付箋の答え（作業の報告）だけ。会話の質問は会話の欄に出すので混ぜない（混ぜると、作業のタブの 100 件を会話の質問が埋める）
      sendJson(res, 200, { questions: answered.list(canvasId).slice(0, ANSWERED_LIMIT) })
      return true
    }
    const detail = answered.detail(decodeURIComponent(ANSWERED_PATH.exec(path)![1]!))
    if (detail) sendJson(res, 200, detail)
    else sendJson(res, 404, { error: 'question not found' })
    return true
  }
  const match = QUESTION_PATH.exec(path)
  if (!match) return false
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
