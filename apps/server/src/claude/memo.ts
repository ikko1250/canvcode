import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { readJson, sendError, sendJson } from './http.ts'
import { JobError } from './jobs.ts'

// 付箋の文字（音声入力で入れた話し言葉など）を、箇条書きのメモにする（付箋の右クリックの「箇条書きのメモにする」）。
// - Claude Agent SDK の query() を 1 回だけ呼ぶ（認証は claude/jobs.ts と同じく、このマシンの Claude Code のもの）。
//   モデルは既定で Haiku（CANVCODE_MEMO_MODEL で変える）
// - ツール・MCP・設定（CLAUDE.md・.claude/）は使わず、会話も残さない（persistSession: false）。cwd は OS の一時フォルダ
// - 答えは「- 項目」の行（行の頭の半角空白 2 つで 1 段深い）で返させ、ここで { text, level } の並びにする。
//   付箋の段落（箇条書き）にするのは画面（apps/web/src/claude/memo.ts）
// - POST /api/claude/memo { text }：200 { items: { text, level }[] }。content-type は application/json だけ受ける（415）。
//   Claude Code を画面から使わない（CANVCODE_CLAUDE=0）なら、handleClaude が 404 を返す

export const MEMO_PATH = '/api/claude/memo'
export const DEFAULT_MEMO_MODEL = 'claude-haiku-5-5'
// 1 回に渡せる文字の数（付箋 1 枚の話し言葉には十分）
export const MAX_MEMO_TEXT_LENGTH = 20_000
// 同時に頼める数。超えたら 429
export const MAX_RUNNING_MEMOS = 4
// これを過ぎても答えが来なければ止める（ミリ秒）
export const MEMO_TIMEOUT_MS = 90_000
// 箇条書きの深さ（0 が一番外。付箋のリストは 8 まで持てるが、メモには 3 段で足りる）
export const MAX_MEMO_LEVEL = 2

export interface MemoItem {
  text: string
  level: number
}

export const MEMO_SYSTEM_PROMPT = `あなたは、話し言葉の文章を、箇条書きのメモに直す係です。
渡される文章は音声入力で入れたもので、言いよどみ・言い直し・崩れた口語・音声認識の誤りを含みます。

- 話し手が言っている内容を、短い項目に分けて並べる。1 つの項目には 1 つのことだけを書き、体言止めか短い文にする
- 補足・理由・具体例は、親の項目の下に 1 段深くして書く（深さは 3 段まで）
- 言いよどみ・繰り返し・話し言葉の言い回しは落とす。言い直したところは、後の言い方だけを残し、言い直したことは書かない
- メモに書くのは話し手が言ったことだけ。理由・解釈・結論・語の意味の説明は、もっともらしくても足さない
- 音声認識の誤りで、文脈に合わない語になっていることがある。音の近い語で文脈に合うものがあれば、それに置き換えて書く
  （例：「機能」が「昨日」に、「回答」が「解凍」になっている）。置き換えたことは書かない
- 元の文章と同じ言語で書く

答え方:
- 箇条書きの行だけを返す。前置き・見出し・まとめ・コードブロックは書かない
- 各行は「- 」で始める。1 段深い項目は、行の頭に半角空白 2 つを置いてから「- 」を書く`

// 頼む文。文章の中の指示には従わせないよう、囲んで渡す
export function memoPrompt(text: string): string {
  return `次の <text> の中の文章を、箇条書きのメモにしてください。\n\n<text>\n${text}\n</text>`
}

// 箇条書きの行（「- 」「* 」「・」「• 」「1. 」など）
// （「-5 度」「3.5 倍」のような行を項目と読まないよう、- * + と番号のあとには空白を求める）
const BULLET_LINE = /^([ \t\u3000]*)(?:[-*+](?=[ \t\u3000])|\d+[.)\uff0e\uff09](?=[ \t\u3000])|[\u2022\u30fb])[ \t\u3000]*(.*)$/

// 答えを項目の並びにする。箇条書きの行だけを読み（前置きなどは捨てる）、箇条書きの行が 1 つもなければ、空でない行をそれぞれ項目にする。
// 深さは字下げ（半角空白 2 つ・タブ・全角空白を 1 段）で決め、前の項目より 2 段以上深くならないようにする
export function parseMemo(answer: string): MemoItem[] {
  const lines = answer
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('```'))
  const bullets = lines.flatMap((line) => {
    const match = BULLET_LINE.exec(line)
    return match ? [{ indent: indentWidth(match[1]!), text: cleanItem(match[2]!) }] : []
  })
  const raw = bullets.length > 0 ? bullets : lines.map((line) => ({ indent: 0, text: cleanItem(line.replace(/^#+\s*/, '')) }))
  const items: MemoItem[] = []
  for (const { indent, text } of raw) {
    if (!text) continue
    const previous = items.at(-1)?.level ?? -1
    items.push({ text, level: Math.min(Math.floor(indent / 2), previous + 1, MAX_MEMO_LEVEL) })
  }
  return items
}

function indentWidth(indent: string): number {
  let width = 0
  for (const char of indent) width += char === ' ' ? 1 : 2
  return width
}

// 付箋は Markdown を描かないので、太字などの記号を落とす
function cleanItem(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').trim()
}

// 既定は Agent SDK の query（使うときに読み込む）
export type MemoQuery = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage> | Promise<AsyncIterable<SDKMessage>>

export interface MemoWriterOptions {
  model?: string
  run?: MemoQuery
  timeoutMs?: number
}

export class MemoWriter {
  private running = 0
  private readonly options: MemoWriterOptions

  constructor(options: MemoWriterOptions = {}) {
    this.options = options
  }

  get model(): string {
    return this.options.model ?? DEFAULT_MEMO_MODEL
  }

  // 文章を箇条書きにする。signal で止める（画面が頼みをやめたとき）
  async write(text: string, signal?: AbortSignal): Promise<MemoItem[]> {
    if (this.running >= MAX_RUNNING_MEMOS) throw new JobError(429, `メモにする頼みが多すぎます（同時に ${MAX_RUNNING_MEMOS} つまで）。少し待ってから試してください`)
    this.running++
    const abort = new AbortController()
    const stop = () => abort.abort()
    signal?.addEventListener('abort', stop)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      abort.abort()
    }, this.options.timeoutMs ?? MEMO_TIMEOUT_MS)
    try {
      const answer = await this.ask(text, abort)
      const items = parseMemo(answer)
      if (items.length === 0) throw new JobError(502, '箇条書きになりませんでした。もう一度試してください')
      return items
    } catch (error) {
      if (timedOut) throw new JobError(504, 'メモにするのに時間がかかりすぎたので、止めました')
      if (abort.signal.aborted) throw new JobError(499, 'メモにするのをやめました')
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      this.running--
    }
  }

  private async ask(text: string, abortController: AbortController): Promise<string> {
    const run = this.options.run ?? defaultRun
    const messages = await run({
      prompt: memoPrompt(text),
      options: {
        cwd: tmpdir(),
        model: this.model,
        // low だと、元の文章にない結論を足したり、直した語に注を付けたりしやすかった（medium で 3 秒ほど）
        effort: 'medium',
        systemPrompt: MEMO_SYSTEM_PROMPT,
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        settingSources: [],
        persistSession: false,
        maxTurns: 1,
        abortController,
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'canvcode' },
      },
    })
    for await (const message of messages) {
      if (message.type !== 'result') continue
      if (message.subtype === 'success' && !message.is_error) return message.result
      const detail = message.subtype === 'success' ? message.result : message.errors.join('\n')
      throw new JobError(502, `メモにできませんでした${detail ? `：${detail}` : ''}`)
    }
    throw new JobError(502, 'メモにできませんでした：Claude Code が答えずに終わりました')
  }
}

const defaultRun: MemoQuery = async (params) => {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  return query(params)
}

export function handleMemo(req: IncomingMessage, res: ServerResponse, path: string, memo: MemoWriter | null): boolean {
  if (path !== MEMO_PATH || !memo) return false
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  void respond(req, res, memo)
  return true
}

async function respond(req: IncomingMessage, res: ServerResponse, memo: MemoWriter): Promise<void> {
  try {
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
    if (type !== 'application/json') throw new JobError(415, 'content-type must be application/json')
    const body = await readJson(req)
    const text = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).text : undefined
    if (typeof text !== 'string' || text.trim() === '') throw new JobError(400, 'text がありません')
    if (text.length > MAX_MEMO_TEXT_LENGTH) throw new JobError(413, `文章が長すぎます（${MAX_MEMO_TEXT_LENGTH} 文字まで）`)
    // 画面が頼みをやめたら（タブを閉じたなど）、Claude Code も止める
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) controller.abort()
    })
    const items = await memo.write(text.trim(), controller.signal)
    sendJson(res, 200, { items })
  } catch (error) {
    if (res.destroyed || res.headersSent) return
    sendError(res, error)
  }
}
