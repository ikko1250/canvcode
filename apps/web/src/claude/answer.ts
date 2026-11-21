import type { PreviousTurn } from '@canvcode/canvas'
import type { ModelSetting } from './modelChoice.ts'

// キャンバスの AI：付箋で聞き、答えは付箋に持たせる（docs/canvas-answer-panel-plan.md）。
// サーバーの POST /api/claude/answer（apps/server/src/claude/answer.ts）が Claude に頼み、答えの本文（Markdown）と関連する付箋を返す。
// 付箋に書くのは packages/canvas/src/answers.ts（setAiAnswer）。
// 答えは NDJSON で受ける（進み具合と Claude の考えている中身（thinking）が流れてきて、最後に答え）。始まる前の誤りは、ふつうの JSON。
// どの付箋の質問か（source）を添えると、サーバーが動いている質問の一覧に載せ（すべてのタブに流す）、最初の行でその id を返す

export interface AnswerRequest {
  question: string
  // 続きの質問なら、前の質問と答え（古い方から）
  previous?: PreviousTurn[]
  // 添えた選んだ所（サーバーが中身を読む）
  refs?: { label: string; refId: string }[]
  // 関連する付箋の候補（質問の付箋の近くの付箋）
  candidates?: { id: string; text: string }[]
  // 質問した人が見ている Canvas（サーバーが id と題を Claude に知らせ、Claude はキャンバスを読むツールでそこを読む）
  canvasId?: string
  // どの付箋の質問か・どの会話の質問か（label は質問の 1 行目。会話の質問は、会話を選んでいなければ threadId がない）
  source?: { noteId: string; canvasId: string; label: string } | { kind: 'chat'; threadId?: string; label: string }
}

export interface AnswerResult {
  // 本文（Markdown）
  body: string
  // 関連する付箋の id（候補の中から）
  related: string[]
  // 答えたモデル
  model: string
}

// 進み具合：質問（とキャンバス・ファイル）を読んでいる・Web を調べている・答えを書いている
export type AnswerStep = 'read' | 'search' | 'write'

// 答えられなかった。status はサーバーの状態コード（499 は、やめた。ほかのタブで止めたときも）
export class AnswerError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export interface AnswerOptions {
  signal?: AbortSignal
  // 動いている質問の一覧に載った（source を添えたとき）
  // threadId は、会話の質問の会話（会話を選ばずに聞いたら、サーバーが作った新しい会話）
  onStart?: (id: string, threadId?: string) => void
  // Claude の考えている中身（少しずつ届く）
  onThinking?: (text: string) => void
  onStep?: (step: AnswerStep) => void
}

export async function requestAnswer(request: AnswerRequest, setting: ModelSetting, options: AnswerOptions = {}): Promise<AnswerResult> {
  const response = await fetch('/api/claude/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify({ ...request, ...setting }),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (response.status === 404) throw new AnswerError('このサーバーでは使えません（CANVCODE_CLAUDE=0 か、サーバーを再起動していない）', 404)
  if (response.ok && response.body && (response.headers.get('content-type') ?? '').includes('ndjson')) return readStream(response.body, options)
  const body = (await response.json().catch(() => null)) as (Partial<AnswerResult> & { error?: string }) | null
  if (!response.ok) throw new AnswerError(body?.error ?? `HTTP ${response.status}`, response.status)
  return answerOf(body)
}

// NDJSON の行：{type:'start', id}（source を添えたとき）、{type:'step', step} と {type:'thinking', text} が続き、
// 最後に {type:'answer', answer} か {type:'error', status, error}
async function readStream(body: ReadableStream<Uint8Array>, options: AnswerOptions): Promise<AnswerResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const handle = (line: string): AnswerResult | null => {
    if (!line.trim()) return null
    const message = JSON.parse(line) as { type?: string; id?: unknown; threadId?: unknown; text?: unknown; step?: unknown; answer?: unknown; status?: unknown; error?: unknown }
    if (message.type === 'thinking' && typeof message.text === 'string') options.onThinking?.(message.text)
    else if (message.type === 'step' && isStep(message.step)) options.onStep?.(message.step)
    else if (message.type === 'start' && typeof message.id === 'string') options.onStart?.(message.id, typeof message.threadId === 'string' ? message.threadId : undefined)
    else if (message.type === 'error') {
      throw new AnswerError(typeof message.error === 'string' ? message.error : '答えられませんでした', typeof message.status === 'number' ? message.status : 500)
    }
    else if (message.type === 'answer') return answerOf(message.answer)
    return null
  }
  for (;;) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split('\n')
    buffer = done ? '' : lines.pop()!
    for (const line of lines) {
      const answer = handle(line)
      if (answer) {
        await reader.cancel().catch(() => undefined)
        return answer
      }
    }
    if (done) throw new Error('答えが返ってきませんでした')
  }
}

function isStep(value: unknown): value is AnswerStep {
  return value === 'read' || value === 'search' || value === 'write'
}

function answerOf(value: unknown): AnswerResult {
  const body = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof AnswerResult, unknown>>
  if (typeof body.body !== 'string' || !body.body.trim()) throw new Error('答えが返ってきませんでした')
  return {
    body: body.body,
    related: Array.isArray(body.related) ? body.related.filter((id): id is string => typeof id === 'string') : [],
    model: typeof body.model === 'string' ? body.model : '',
  }
}
