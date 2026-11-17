import type { AnswerItem, CanvasAnswer, PreviousTurn } from '@canvcode/canvas'
import type { ModelSetting } from './modelChoice.ts'

// キャンバスの AI：付箋で聞き、付箋で答える。
// サーバーの POST /api/claude/answer（apps/server/src/claude/answer.ts）が Claude に頼み、題・前提・段落・ヒントを返す。
// 置くのは packages/canvas/src/answers.ts（段落ごとの付箋とボタンをまとめたフレーム）。
// 答えは NDJSON で受ける（Claude の考えている中身（thinking）が流れてきて、最後に答え）。始まる前の誤りは、ふつうの JSON

export type AnswerRequest =
  // 新しく聞く。previous は、続きの質問なら前の答え（古い方から）。refs は、添えた選んだ所（サーバーが中身を読む）
  | { question: string; previous?: PreviousTurn[]; refs?: { label: string; refId: string }[] }
  // ボタンを押して書き直す。question は、わかれば（質問の付箋が残っていれば）。
  // current の前提・付箋には、人が書き換えた・書き足したものに edited の印。buttons はフレームに人が置いたボタン、history はこれまでに当てた指示
  | {
      question: string
      current: { title: string; assumptions: AnswerItem[]; notes: AnswerItem[]; buttons: string[]; history: string[] }
      instruction: string
      previous?: PreviousTurn[]
    }

export interface AnswerOptions {
  signal?: AbortSignal
  // Claude の考えている中身（少しずつ届く）
  onThinking?: (text: string) => void
}

export async function requestAnswer(request: AnswerRequest, setting: ModelSetting, options: AnswerOptions = {}): Promise<CanvasAnswer> {
  const response = await fetch('/api/claude/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify({ ...request, ...setting }),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (response.status === 404) throw new Error('このサーバーでは使えません（CANVCODE_CLAUDE=0 か、サーバーを再起動していない）')
  if (response.ok && response.body && (response.headers.get('content-type') ?? '').includes('ndjson')) return readStream(response.body, options)
  const body = (await response.json().catch(() => null)) as (Partial<CanvasAnswer> & { error?: string }) | null
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
  return answerOf(body)
}

// NDJSON の行：{type:'thinking', text} が続き、最後に {type:'answer', answer} か {type:'error', error}
async function readStream(body: ReadableStream<Uint8Array>, options: AnswerOptions): Promise<CanvasAnswer> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const handle = (line: string): CanvasAnswer | null => {
    if (!line.trim()) return null
    const message = JSON.parse(line) as { type?: string; text?: unknown; answer?: unknown; error?: unknown }
    if (message.type === 'thinking' && typeof message.text === 'string') options.onThinking?.(message.text)
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

function answerOf(value: unknown): CanvasAnswer {
  const body = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof CanvasAnswer, unknown>>
  if (!Array.isArray(body.paragraphs) || body.paragraphs.length === 0) throw new Error('答えが返ってきませんでした')
  return {
    title: typeof body.title === 'string' ? body.title : '',
    assumptions: Array.isArray(body.assumptions) ? body.assumptions.filter((item): item is string => typeof item === 'string') : [],
    paragraphs: body.paragraphs.filter((item): item is string => typeof item === 'string'),
    hints: Array.isArray(body.hints)
      ? body.hints.flatMap((hint: { label?: unknown; prompt?: unknown } | null) =>
          hint && typeof hint.label === 'string' ? [{ label: hint.label, prompt: typeof hint.prompt === 'string' ? hint.prompt : '' }] : [],
        )
      : [],
  }
}
