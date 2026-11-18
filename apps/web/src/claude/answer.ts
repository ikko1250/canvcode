import type { PreviousTurn } from '@canvcode/canvas'
import type { ModelSetting } from './modelChoice.ts'

// キャンバスの AI：付箋で聞き、答えは付箋に持たせる（docs/canvas-answer-panel-plan.md）。
// サーバーの POST /api/claude/answer（apps/server/src/claude/answer.ts）が Claude に頼み、答えの本文（Markdown）と関連する付箋を返す。
// 付箋に書くのは packages/canvas/src/answers.ts（setAiAnswer）。
// 答えは NDJSON で受ける（進み具合と Claude の考えている中身（thinking）が流れてきて、最後に答え）。始まる前の誤りは、ふつうの JSON

export interface AnswerRequest {
  question: string
  // 続きの質問なら、前の質問と答え（古い方から）
  previous?: PreviousTurn[]
  // 添えた選んだ所（サーバーが中身を読む）
  refs?: { label: string; refId: string }[]
  // 関連する付箋の候補（質問の付箋の近くの付箋）
  candidates?: { id: string; text: string }[]
}

export interface AnswerResult {
  // 本文（Markdown）
  body: string
  // 関連する付箋の id（候補の中から）
  related: string[]
  // 答えたモデル
  model: string
}

// 進み具合：質問を読んでいる・Web を調べている・答えを書いている
export type AnswerStep = 'read' | 'search' | 'write'

export interface AnswerOptions {
  signal?: AbortSignal
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
  if (response.status === 404) throw new Error('このサーバーでは使えません（CANVCODE_CLAUDE=0 か、サーバーを再起動していない）')
  if (response.ok && response.body && (response.headers.get('content-type') ?? '').includes('ndjson')) return readStream(response.body, options)
  const body = (await response.json().catch(() => null)) as (Partial<AnswerResult> & { error?: string }) | null
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
  return answerOf(body)
}

// NDJSON の行：{type:'step', step} と {type:'thinking', text} が続き、最後に {type:'answer', answer} か {type:'error', error}
async function readStream(body: ReadableStream<Uint8Array>, options: AnswerOptions): Promise<AnswerResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const handle = (line: string): AnswerResult | null => {
    if (!line.trim()) return null
    const message = JSON.parse(line) as { type?: string; text?: unknown; step?: unknown; answer?: unknown; error?: unknown }
    if (message.type === 'thinking' && typeof message.text === 'string') options.onThinking?.(message.text)
    else if (message.type === 'step' && isStep(message.step)) options.onStep?.(message.step)
    else if (message.type === 'error') throw new Error(typeof message.error === 'string' ? message.error : '答えられませんでした')
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
