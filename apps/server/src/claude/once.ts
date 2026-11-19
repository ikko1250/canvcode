import { tmpdir } from 'node:os'
import type { EffortLevel, HookCallback, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { JobError } from './jobs.ts'

// Claude を 1 回だけ動かして、答えを返す（画面の小さな頼みごとに使う共通の仕組み。単語を調べる claude/lookup.ts（MAI-99）など）。
// - Claude Agent SDK の query() を 1 回だけ呼ぶ。認証は claude/jobs.ts と同じく、このマシンの Claude Code のもの（ログインか API キー）
// - 呼ぶごとに、モデル（'haiku'・'sonnet' などの別名か、モデルの id）、使ってよいツール（なし、または WebSearch・WebFetch）、
//   ターン数の上限、答えの JSON の形（JSON Schema。構造化出力）を決める。サーバー全体のモデルの指定（CANVCODE_CLAUDE_MODEL。
//   Claude のパネルのジョブが使う）とは別
// - ファイルの読み書き・シェル・サブエージェント・MCP・設定（CLAUDE.md・.claude/）は使わせない。会話も残さない（persistSession: false）。
//   cwd は OS の一時フォルダ。使ってよいツールのほかは、フックと canUseTool の両方で断る
// - 同時に動かせる数と、待つ時間に上限がある（超えたら 429、時間切れは 504）

// 使わせてよいツール（Web を調べるだけのもの）
export const ONCE_TOOLS = ['WebSearch', 'WebFetch'] as const
export type OnceTool = (typeof ONCE_TOOLS)[number]

// 構造化出力で、モデルが答えを渡すのに呼ぶツール（outputFormat を渡すと、SDK が足す）
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput'

// 同時に動かせる数。超えたら 429
export const MAX_RUNNING_ONCE = 4
// これを過ぎても答えが来なければ止める（ミリ秒）。呼ぶごとに変えられる
export const ONCE_TIMEOUT_MS = 90_000
// ターン数の上限の既定。ツールなしなら 3（構造化出力は、答えを渡すツール（StructuredOutput）を呼ぶので 2 ターン要る。
// 1 にすると、本物の Haiku で error_max_turns になることがあった。形が合わずにやり直す分も見て 3）。
// ツールがあれば、調べる回数の分だけ要る
export const DEFAULT_ONCE_MAX_TURNS = 3
export const DEFAULT_ONCE_MAX_TURNS_WITH_TOOLS = 8

export interface OnceRequest {
  prompt: string
  // 'haiku'・'sonnet'・'opus' などの別名か、モデルの id（claude-haiku-5-5 など）
  model: string
  // 既定は Claude Code の既定のシステムプロンプト（ツールなしでも、長くて答えが遅くなるので、ふつうは渡す）
  systemPrompt?: string
  // 使ってよいツール。既定はなし
  tools?: readonly OnceTool[]
  // 既定は、ツールなしなら DEFAULT_ONCE_MAX_TURNS、ツールがあれば DEFAULT_ONCE_MAX_TURNS_WITH_TOOLS（ツールのない答えは 1 ターンで終わる）
  maxTurns?: number
  // 答えの JSON の形（JSON Schema）。渡すと、答えを OnceResult の output に入れて返す
  schema?: Record<string, unknown>
  effort?: EffortLevel
  // 既定は ClaudeOnce に渡した timeoutMs（さらにその既定は ONCE_TIMEOUT_MS）
  timeoutMs?: number
  // 止める（画面が頼みをやめたときなど）
  signal?: AbortSignal
  // 失敗したときの知らせの頭（「調べられませんでした」など）。既定は「Claude が答えられませんでした」。
  // 空の文字なら頭を付けず、わけだけにする（画面が頭を付けるとき。付箋の答え）
  failure?: string
  // Claude Code から届いたメッセージを 1 つずつ見る（ツールの結果から、実際に開いた URL を集めるなど。APA の引用 MAI-98）
  onMessage?: (message: SDKMessage) => void
  // Claude の考えている中身（thinking）を、少しずつ受ける。渡すと、考えている中身を要約して返すよう頼み（既定では返さない）、
  // 途中のメッセージも受ける。考える仕組み（adaptive thinking）を持たない古いモデルでは何も届かない。
  // 考えるかはモデルが決める（effort が high 以上でないと、考えずに答えることが多い）。
  // schema と一緒に渡すと、構造化出力（答えを渡すツールを必ず使わせる。そのときモデルは考えない）を使わず、
  // JSON を文字で返すよう頼んで、それを読む（読めなければ 502）。
  // 長い Markdown を JSON の文字列に入れさせると、モデルが Markdown をそのまま返して読めないことがある
  // （付箋の答えで起きた。answer.ts は schema を渡さず、本文を Markdown のまま書かせて自分で読む。docs/ai-note-answer-format-plan.md）
  onThinking?: (text: string) => void
}

export interface OnceResult<T = unknown> {
  // 答えの文章（schema を渡したときは、その JSON の文字列）
  text: string
  // schema を渡したときの答え（形は SDK が確かめている）。渡さなければ undefined
  output: T | undefined
  // 実際に答えたモデル（claude-haiku-5-5 など。わからなければ、頼んだ model）
  model: string
  // Claude Code が見積もった費用（USD）と、かかった時間・ターン数
  costUsd: number
  durationMs: number
  turns: number
}

// 既定は Agent SDK の query（使うときに読み込む）
export type OnceQuery = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage> | Promise<AsyncIterable<SDKMessage>>

export interface ClaudeOnceOptions {
  run?: OnceQuery
  // 既定は MAX_RUNNING_ONCE・ONCE_TIMEOUT_MS
  maxRunning?: number
  timeoutMs?: number
}

export class ClaudeOnce {
  private running = 0
  private readonly options: ClaudeOnceOptions

  constructor(options: ClaudeOnceOptions = {}) {
    this.options = options
  }

  // 1 回動かして、答えを返す。失敗は JobError（429：多すぎる・499：やめた・504：時間切れ・502：答えられなかった）
  async ask<T = unknown>(request: OnceRequest): Promise<OnceResult<T>> {
    const tools = checkTools(request.tools ?? [])
    const maxRunning = this.options.maxRunning ?? MAX_RUNNING_ONCE
    if (this.running >= maxRunning) throw new JobError(429, `Claude への頼みが多すぎます（同時に ${maxRunning} つまで）。少し待ってから試してください`)
    this.running++
    const abort = new AbortController()
    const stop = () => abort.abort()
    if (request.signal?.aborted) abort.abort()
    request.signal?.addEventListener('abort', stop)
    let timedOut = false
    const timer = setTimeout(
      () => {
        timedOut = true
        abort.abort()
      },
      request.timeoutMs ?? this.options.timeoutMs ?? ONCE_TIMEOUT_MS,
    )
    try {
      return await this.run<T>(request, tools, abort)
    } catch (error) {
      if (timedOut) throw new JobError(504, '時間がかかりすぎたので、止めました')
      if (abort.signal.aborted) throw new JobError(499, '頼むのをやめました')
      throw error
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', stop)
      this.running--
    }
  }

  private async run<T>(request: OnceRequest, tools: OnceTool[], abortController: AbortController): Promise<OnceResult<T>> {
    const run = this.options.run ?? defaultRun
    const failure = request.failure ?? 'Claude が答えられませんでした'
    // 失敗の知らせ（頭とわけ。頭が空なら、わけだけ）
    const fail = (detail: string) => new JobError(502, failure ? `${failure}${detail ? `：${detail}` : ''}` : detail || 'Claude Code が誤りで終わりました')
    const messages = await run({ prompt: request.prompt, options: onceOptions(request, tools, abortController) })
    for await (const message of messages) {
      request.onMessage?.(message)
      if (request.onThinking && message.type === 'stream_event') {
        const event = message.event
        if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta' && event.delta.thinking) request.onThinking(event.delta.thinking)
        continue
      }
      if (message.type !== 'result') continue
      if (message.subtype === 'success' && !message.is_error) {
        const output = request.schema ? (jsonAsText(request) ? jsonFromText(message.result) : message.structured_output) : undefined
        if (request.schema && output === undefined) throw fail('答えが決めた形になっていません')
        return {
          text: message.result,
          output: output as T | undefined,
          model: answeredModel(message.modelUsage ?? {}, request.model),
          costUsd: message.total_cost_usd,
          durationMs: message.duration_ms,
          turns: message.num_turns,
        }
      }
      const detail = message.subtype === 'success' ? message.result : resultErrorDetail(message.subtype, message.errors)
      throw fail(detail)
    }
    throw fail('Claude Code が答えずに終わりました')
  }
}

// query() に渡すもの（テストで確かめるために出す）
export function onceOptions(request: OnceRequest, tools: readonly OnceTool[], abortController: AbortController): Options {
  const thinking = request.onThinking !== undefined && thinksAdaptively(request.model)
  const asText = jsonAsText(request)
  // 答えの JSON の形を渡したときは、答えを渡すツール（StructuredOutput。SDK が足す）も通す。断ると、答えられずにターン数の上限まで繰り返す
  const allowed = new Set<string>(request.schema && !asText ? [...tools, STRUCTURED_OUTPUT_TOOL] : tools)
  const systemPrompt = asText ? [request.systemPrompt, jsonInstruction(request.schema!)].filter(Boolean).join('\n\n') : request.systemPrompt
  const deny = (name: string) => `${name} は使えません（使えるのは ${tools.length > 0 ? tools.join('・') : 'なし'}）`
  // 使ってよいツールのほかは、フックで断る（tools で見せていないので、ふつうは来ない。念のため）
  const guard: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse' || allowed.has(input.tool_name)) return {}
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: deny(input.tool_name) } }
  }
  return {
    cwd: tmpdir(),
    model: request.model,
    ...(request.effort ? { effort: request.effort } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    tools: [...tools],
    // 使ってよいツールは尋ねずに使わせる。ほかは断る（画面で尋ねる仕組みはない）
    allowedTools: [...tools],
    canUseTool: async (name, input) => (allowed.has(name) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: deny(name) }),
    hooks: { PreToolUse: [{ hooks: [guard] }] },
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    persistSession: false,
    maxTurns: request.maxTurns ?? (tools.length > 0 ? DEFAULT_ONCE_MAX_TURNS_WITH_TOOLS : DEFAULT_ONCE_MAX_TURNS),
    ...(request.schema && !asText ? { outputFormat: { type: 'json_schema', schema: request.schema } } : {}),
    // 考えている中身を受けるときは、途中のメッセージも受け、考えている中身を要約して返すよう頼む（既定の omitted では空になる）
    ...(thinking ? { includePartialMessages: true, thinking: { type: 'adaptive', display: 'summarized' } } : {}),
    abortController,
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'canvcode' },
  }
}

// JSON の答えを文字で返させるか（考えている中身を受けるとき。構造化出力ではモデルが考えないため）
function jsonAsText(request: OnceRequest): boolean {
  return request.schema !== undefined && request.onThinking !== undefined && thinksAdaptively(request.model)
}

// JSON を文字で返させるときに、システムプロンプトに足す頼み方
export function jsonInstruction(schema: Record<string, unknown>): string {
  return `答えの返し方:\n- 次の JSON Schema に合う JSON の値を 1 つだけ返す。前後に文を書かない。コードブロックの記号（\`\`\`）で囲まない\n${JSON.stringify(schema)}`
}

// 文字で返った JSON を読む（コードブロックで囲んであれば外し、前後に文があれば最初の { から最後の } までを読む）。読めなければ undefined
export function jsonFromText(text: string): unknown {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text)
  const body = (fenced ? fenced[1]! : text).trim()
  for (const candidate of [body, body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)]) {
    try {
      const value = JSON.parse(candidate) as unknown
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value
    } catch {
      // 次を試す
    }
  }
  return undefined
}

// adaptive thinking を持つモデルか。別名（sonnet・opus・haiku・fable）は今の版を指すので持つ。版を書いた古いモデル（4.5 まで、3 系）は持たない
export function thinksAdaptively(model: string): boolean {
  return !/^claude-(?:3|(?:haiku|sonnet|opus)-(?:3|4(?:-[0-5])?(?:$|@|-\d{8})))/.test(model)
}

// 実際に答えたモデル。WebFetch はページを別のモデル（Haiku）に読ませるので、modelUsage には 2 つ入ることがある。
// 頼んだモデル（別名なら、その名前を含む id）を選び、なければ費用のいちばん大きいもの
export function answeredModel(usage: Record<string, { costUSD?: number }>, requested: string): string {
  const models = Object.keys(usage)
  const alias = requested.toLowerCase()
  return (
    models.find((id) => id === requested) ??
    models.find((id) => id.toLowerCase().includes(alias)) ??
    models.sort((a, b) => (usage[b]?.costUSD ?? 0) - (usage[a]?.costUSD ?? 0))[0] ??
    requested
  )
}

function checkTools(tools: readonly string[]): OnceTool[] {
  for (const tool of tools) {
    if (!(ONCE_TOOLS as readonly string[]).includes(tool)) throw new JobError(400, `${tool} は使わせられません（使えるのは ${ONCE_TOOLS.join('・')}）`)
  }
  return [...new Set(tools)] as OnceTool[]
}

function resultErrorDetail(subtype: string, errors: readonly string[]): string {
  if (subtype === 'error_max_turns') return 'ターン数の上限に達しました'
  if (subtype === 'error_max_structured_output_retries') return '答えを決めた形にできませんでした'
  return errors.join('\n')
}

const defaultRun: OnceQuery = async (params) => {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  return query(params)
}
