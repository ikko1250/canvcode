import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { EffortLevel, HookCallback, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { JobError } from './jobs.ts'
import { readPath, realish } from './permissions.ts'

// Claude を 1 回だけ動かして、答えを返す（画面の小さな頼みごとに使う共通の仕組み。単語を調べる claude/lookup.ts（MAI-99）など）。
// - Claude Agent SDK の query() を 1 回だけ呼ぶ。認証は claude/jobs.ts と同じく、このマシンの Claude Code のもの（ログインか API キー）
// - 呼ぶごとに、モデル（'haiku'・'sonnet' などの別名か、モデルの id）、使ってよいツール（なし、または WebSearch・WebFetch）、
//   ターン数の上限、答えの JSON の形（JSON Schema。構造化出力）を決める。サーバー全体のモデルの指定（CANVCODE_CLAUDE_MODEL。
//   Claude のパネルのジョブが使う）とは別
// - ファイルの書き込み・シェル・サブエージェント・設定（CLAUDE.md・.claude/）は使わせない。会話も残さない（persistSession: false）。
//   cwd は OS の一時フォルダ。使ってよいツールのほかは、フックと canUseTool の両方で断る
// - MCP とファイルを読むツールは、ふつうは使わせない。会話の質問（claude/answer.ts）だけが、読むだけの canvcode の MCP（canvas）と
//   ファイルを読むフォルダ（readRoots）を渡す（docs/question-canvas-tools-plan.md）。MCP は Agent SDK の同じプロセスの中の MCP としてつなぎ、
//   ONCE_CANVAS_TOOLS だけを許す。Read・Glob・Grep は readRoots の中だけを読ませる（fileRefusal）。
//   そのときは、キャンバスかファイルを読むツールを 1 度でも通したら、WebFetch に渡せる URL を、利用者が書いた文（userText。質問の文）に書かれた
//   URL だけにする（FetchGuard。読んだ中身を URL に入れて外に送らせない。docs/question-canvas-tools-plan.md の「レビューで見つかったこと」）
// - 頼む文の中の @パス（ファイルの言及）を、Claude Code に読ませない（CLAUDE_CODE_DISABLE_FILE_MENTIONS。読むツールのフックを通らずに
//   ファイルを読んで添えるため。材料に攻撃者が書けば、ワークスペースの外も読ませられた）。材料を頼む文に入れる所でも、語の頭の @ を ＠ にする（withoutFileMentions）
// - 同時に動かせる数と、待つ時間に上限がある（超えたら 429、時間切れは 504）

// 使わせてよいツール（Web を調べるだけのもの）
export const ONCE_TOOLS = ['WebSearch', 'WebFetch'] as const
export type OnceTool = (typeof ONCE_TOOLS)[number]

// 読むだけの canvcode の MCP のツール（mcp.ts の createMcpServer の readOnly が出すもの）。渡したサーバーがほかのツールを持っていても、これだけを使わせる
export const ONCE_CANVAS_TOOLS = ['list_canvases', 'read_canvas', 'read_nodes', 'get_canvas_format', 'resolve_reference', 'list_documents', 'read_document', 'render_canvas'] as const
// MCP のサーバーの名前（ツールの名前は mcp__canvcode__read_canvas など。会話のジョブと同じ）
export const ONCE_MCP_SERVER = 'canvcode'
// ファイルを読むツール（readRoots を渡したときだけ）
export const ONCE_FILE_TOOLS = ['Read', 'Glob', 'Grep'] as const

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
  // 読むだけの canvcode の MCP のサーバー（mcp.ts の createMcpServer の readOnly。頼みごとに作ったもの）。渡すと、同じプロセスの中の MCP として
  // つなぎ、ONCE_CANVAS_TOOLS だけを使わせる（フックと canUseTool の両方で許し、読んだ印を付ける）。閉じるのは渡した側
  canvas?: McpServer
  // ファイルを読ませるフォルダ（絶対パス）。渡すと Read・Glob・Grep を見せ、このフォルダの中だけを読ませる（fileRefusal）
  readRoots?: readonly string[]
  // 利用者が書いた文（質問の文）。読むツール（canvas・readRoots）を渡したとき、キャンバスかファイルを読んだあとに WebFetch で開けるのは、
  // この文に書かれた URL だけ（FetchGuard）
  userText?: string
  // フックが通したツールの呼び出し（断ったものは来ない）。何をしているかを画面に出すため
  onToolUse?: (name: string, input: Record<string, unknown>) => void
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

// 読むツールを渡す頼みなら、WebFetch を見張るもの。ほかは null（WebFetch は今のまま）
export function fetchGuard(request: OnceRequest): FetchGuard | null {
  return request.canvas || (request.readRoots ?? []).length > 0 ? new FetchGuard(request.userText ?? '') : null
}

// query() に渡すもの（テストで確かめるために出す）。guard は、頼みごとの WebFetch の見張り（fetchGuard）
export function onceOptions(request: OnceRequest, tools: readonly OnceTool[], abortController: AbortController, guard: FetchGuard | null = fetchGuard(request)): Options {
  const thinking = request.onThinking !== undefined && thinksAdaptively(request.model)
  const asText = jsonAsText(request)
  const roots = request.readRoots ?? []
  const fileTools: string[] = roots.length > 0 ? [...ONCE_FILE_TOOLS] : []
  const canvasTools = request.canvas ? ONCE_CANVAS_TOOLS.map((name) => `mcp__${ONCE_MCP_SERVER}__${name}`) : []
  // 尋ねずに使わせるもの。読むツール（ファイル・キャンバス）と、URL を確かめる WebFetch は入れない（入れると canUseTool を通らずに許されるので、
  // 確かめて読んだ印を付けるのがフックだけになる。ワークスペースは cwd の外なので、Claude Code は Read などを canUseTool に尋ねる。MCP のツールも尋ねる）
  const unasked = tools.filter((name) => !(guard && name === 'WebFetch'))
  const readTools = new Set([...canvasTools, ...fileTools])
  // 答えの JSON の形を渡したときは、答えを渡すツール（StructuredOutput。SDK が足す）も通す。断ると、答えられずにターン数の上限まで繰り返す
  const allowed = new Set<string>([...tools, ...canvasTools, ...(request.schema && !asText ? [STRUCTURED_OUTPUT_TOOL] : [])])
  const systemPrompt = asText ? [request.systemPrompt, jsonInstruction(request.schema!)].filter(Boolean).join('\n\n') : request.systemPrompt
  const usable = [...tools, ...fileTools, ...canvasTools]
  const deny = (name: string) => `${name} は使えません（使えるのは ${usable.length > 0 ? usable.join('・') : 'なし'}）`
  // 断る理由。使ってよいなら null。ファイルを読むツールは読む場所で、読むツールを渡したときの WebFetch は URL で決める。
  // キャンバスやファイルを読むツールを許したら、その時点で読んだ印を付ける（結果を待たない。同じターンに並べた WebFetch の URL は、
  // その結果を見る前に決めたものなので、中身は入らない）
  const refusal = (name: string, input: Record<string, unknown>): string | null => {
    const reason = fileTools.includes(name) ? fileRefusal(name, input, roots) : !allowed.has(name) ? deny(name) : guard && name === 'WebFetch' ? guard.refusal(input) : null
    // フック（PreToolUse）と canUseTool の両方で印を付ける（どちらか一方を通らずに来ても付くように）
    if (reason === null && readTools.has(name)) guard?.markRead()
    return reason
  }
  // 使ってよいツールのほかは、フックで断る（tools・MCP で見せていないので、ふつうは来ない。念のため）。ファイルを読むツールは、外を読むものを断る
  const check: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>
    const reason = refusal(input.tool_name, toolInput)
    if (reason === null) {
      request.onToolUse?.(input.tool_name, toolInput)
      return {}
    }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
  }
  // 質問の文に書かれた URL を WebFetch で開いて、ほかのホストへのリダイレクトの知らせが来たら、その行き先を 1 つ許す
  const redirected: HookCallback = async (input) => {
    if (input.hook_event_name === 'PostToolUse' && input.tool_name === 'WebFetch') guard?.followRedirect(input.tool_input, input.tool_response)
    return {}
  }
  return {
    cwd: tmpdir(),
    model: request.model,
    ...(request.effort ? { effort: request.effort } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    tools: [...tools, ...fileTools],
    // 使ってよいツールは尋ねずに使わせる（読むツールと WebFetch は、canUseTool でも確かめてから）。ほかは断る（画面で尋ねる仕組みはない）
    allowedTools: unasked,
    // 読むツールを渡すときは、尋ねる決まり（default）をはっきり渡す。canUseTool の 2 つめの守りは、尋ねるモードでないと呼ばれない。
    // 主の守りはフック（どのモードでも先に通る）。cwd は一時フォルダにしておく（cwd の下は、Claude Code が Read などを尋ねずに許す）
    ...(guard ? { permissionMode: 'default' as const } : {}),
    canUseTool: async (name, input) => {
      const reason = refusal(name, input)
      return reason === null ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: reason }
    },
    hooks: { PreToolUse: [{ hooks: [check] }], ...(guard ? { PostToolUse: [{ hooks: [redirected] }] } : {}) },
    // 読むだけの canvcode の MCP は、同じプロセスの中でつなぐ（ほかの MCP はつながない）
    mcpServers: request.canvas ? { [ONCE_MCP_SERVER]: { type: 'sdk', name: ONCE_MCP_SERVER, instance: request.canvas } } : {},
    strictMcpConfig: true,
    settingSources: [],
    persistSession: false,
    maxTurns: request.maxTurns ?? (usable.length > 0 ? DEFAULT_ONCE_MAX_TURNS_WITH_TOOLS : DEFAULT_ONCE_MAX_TURNS),
    ...(request.schema && !asText ? { outputFormat: { type: 'json_schema', schema: request.schema } } : {}),
    // 考えている中身を受けるときは、途中のメッセージも受け、考えている中身を要約して返すよう頼む（既定の omitted では空になる）
    ...(thinking ? { includePartialMessages: true, thinking: { type: 'adaptive', display: 'summarized' } } : {}),
    abortController,
    // 頼む文の中の @パス を読ませない（読むツールのフックを通らない。材料に攻撃者が書ける）
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'canvcode', CLAUDE_CODE_DISABLE_FILE_MENTIONS: '1' },
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

// 読むツール（キャンバス・ファイル）を渡す頼みの WebFetch の見張り（docs/question-canvas-tools-plan.md の「レビューで見つかったこと」）。
// - キャンバスかファイルを読むツールを通す前は、どの URL でも開ける（手元にあるのは、質問・添えた所・前の答えだけで、読むツールを足す前と同じ）
// - 1 度でも通したら（markRead）、開けるのは、利用者が書いた文（質問の文）に書かれた URL だけ。添えた所・前の答え・ツールの結果・検索結果の
//   URL は開けない（中の文で Claude を操って、読んだ中身を URL やその選び方に入れて送らせないため）
// - 比べるのは、WebFetch が実際に送る形（new URL().href）。同じとみなすのは http と https、末尾の / が 1 つあるかないかだけ
//   （%XX をほどいたり、/ をいくつも落としたりはしない。書き方の選び方で中身を送らせないため）
// - 質問の文の URL がほかのホストへリダイレクトしたら、その WebFetch の結果の知らせの行き先の行（サーバーが決めた URL）から、行き先を 1 つ許す
export class FetchGuard {
  private read = false
  private readonly asked: Set<string>
  private readonly redirects = new Set<string>()

  constructor(userText: string) {
    this.asked = new Set(urlsInText(userText).map(wireUrl).filter((url): url is string => url !== null))
  }

  // キャンバスかファイルを読むツールを通した
  markRead(): void {
    this.read = true
  }

  // WebFetch で開かせない理由。開いてよいなら null。理由の文には、渡された URL を入れない。
  // 空白・改行・制御文字を含む URL は断る（WebFetch の結果の知らせに、そのまま行として入るため。new URL はそれらを捨てて同じ href にする）
  refusal(input: Record<string, unknown>): string | null {
    if (!this.read) return null
    const url = typeof input.url === 'string' && !unsafeUrl(input.url) ? wireUrl(input.url) : null
    if (url && (sameUrl(url, this.asked) || sameUrl(url, this.redirects))) return null
    return FETCH_REFUSAL
  }

  // WebFetch の結果（PostToolUse）。質問の文に書かれた URL がリダイレクトしたときだけ、知らせから行き先を 1 つ許す。
  // 知らせとして読むのは、状態コードがリダイレクト（301・302・303・307・308）で、知らせの頭の 5 行が決まった形のものだけ
  // （ふつうに読めたページ（2xx）の結果は、要約するモデルの答えで、その prompt は Claude が決めるので、知らせの形の文を書かせられる）。
  // Original URL が開いた質問の URL で、Status が状態コードと同じであることも確かめる。Status の行のあと（prompt を含む）は読まない
  followRedirect(input: unknown, response: unknown): void {
    const raw = (input as { url?: unknown } | null)?.url
    const url = typeof raw === 'string' && !unsafeUrl(raw) ? wireUrl(raw) : null
    if (!url || !sameUrl(url, this.asked)) return
    const { code, result } = (typeof response === 'object' && response !== null ? response : {}) as { code?: unknown; result?: unknown }
    if (typeof code !== 'number' || !REDIRECT_CODES.has(code) || typeof result !== 'string') return
    const match = REDIRECT_NOTICE.exec(result)
    if (!match || Number(match[3]) !== code) return
    const original = wireUrl(match[1]!)
    const target = wireUrl(match[2]!)
    if (original && target && sameUrl(original, new Set([url]))) this.redirects.add(target)
  }
}

const FETCH_REFUSAL =
  'キャンバスやファイルを読んだあとは、WebFetch で開けるのは、質問の文に書かれた URL だけです。' +
  '開けなかったことと、そのサイトや資料の名前を答えに書いてください（URL は書かない）。要るときは、利用者に自分で URL を探して、質問の文に書いてもらってください。'

// URL に入れさせない字があるか（空白・改行・制御文字。全角の空白なども）
function unsafeUrl(url: string): boolean {
  return /\s/.test(url) || [...url].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
}

// 同梱の Claude Code が、リダイレクトの知らせを出す状態コード
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])

// リダイレクトの知らせの頭（Claude Code の WebFetch）：1 行目、空の行、Original URL、行き先の行（今の形と古い形）、Status。
// 行き先の URL のあとに何か続く（長すぎて切った・名前が長すぎる）ものは読まない。Status の行のあとは読まない（prompt を含む）
const REDIRECT_NOTICE =
  /^REDIRECT DETECTED: The URL redirects to a location that was not fetched automatically\.\n\n {4}Original URL: (\S+)\n {4}Redirect URL(?: \(from the server's Location header \u2014 server-supplied, not verified\))?: (https?:\/\/\S+)\n {4}Status: (\d{3})(?: [^\n]*)?(?:\n|$)/

// WebFetch が送る形。http は https にする（WebFetch も https にして送る）。URL でなければ null
function wireUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol === 'http:') parsed.protocol = 'https:'
    return parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

// 末尾の / が 1 つあるかないかだけを同じとみなす
function sameUrl(url: string, urls: ReadonlySet<string>): boolean {
  return urls.has(url) || urls.has(`${url}/`) || (url.endsWith('/') && urls.has(url.slice(0, -1)))
}

// 文の中の http(s) の URL。空白・引用符・山括弧で切り、末尾の句読点（全角も）と閉じていない括弧を落とす。
// 日本語の文にすぐ続けて書かれた URL（「https://example.com/aを読んで」「https://example.jp/ページ。続きは」）は、
// 全角の句読点・括弧の手前までのものと、ASCII でない字の手前までのものも足す（どれも、利用者が書いた文字の一部）
export function urlsInText(text: string): string[] {
  const found = new Set<string>()
  for (const [match] of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    found.add(trimUrl(match))
    found.add(trimUrl(match.replace(/[。、，．：；！？「」『』（）【】〔〕〈〉《》][\s\S]*$/, '')))
    found.add(trimUrl(match.replace(/[^\x21-\x7e][\s\S]*$/, '')))
  }
  return [...found].filter((url) => /^https?:\/\/[^/?#\s]+/i.test(url))
}

// 材料を頼む文に入れるときに、語の頭の @ を全角の ＠ にする（Claude Code のファイルの言及（@パス）として読ませない。見た目はほとんど同じ）。
// メールアドレスのように、英数字などのすぐあとの @ はそのまま
export function withoutFileMentions(text: string): string {
  return text.replace(/(?<![A-Za-z0-9._%+-])@/g, '\uff20')
}

// 末尾の句読点（全角のものも）と、閉じていない括弧を落とす
function trimUrl(url: string): string {
  let out = url
  for (;;) {
    const last = out.at(-1)
    if (last && '.,;:!?。、，．：；！？」』）】〕〉》'.includes(last)) out = out.slice(0, -1)
    else if (last && ')]}'.includes(last) && count(out, last) > count(out, { ')': '(', ']': '[', '}': '{' }[last]!)) out = out.slice(0, -1)
    else return out
  }
}

function count(text: string, char: string): number {
  return text.split(char).length - 1
}

// ファイルを読むツール（Read・Glob・Grep）で読ませない理由。読ませてよいなら null（docs/question-canvas-tools-plan.md の 2）。
// - 読ませるのは、roots の中で、そこからのパスに . で始まる名前（隠しファイル・フォルダ）を通らない所だけ（readableFile）
// - 触る場所は permissions.ts の readPath で出す（Glob は path と、pattern の固定の部分）。相対パスは cwd（一時フォルダ）から読むことになるので、外になる
// - path を省いた Glob・Grep（cwd を探す）と、.. を含む Glob の pattern は断る
// - Grep は、ファイル 1 つの中だけを探させる。Claude Code の Grep は ripgrep を --hidden で動かすので、フォルダを探させると、
//   隠しファイル（.env など）の中身まで返す。フォルダの中は Glob（名前だけを返す）で探させる
export function fileRefusal(name: string, input: Record<string, unknown>, roots: readonly string[]): string | null {
  const where = `読めるのは ${roots.join('・')} の中だけです（. で始まる名前のファイル・フォルダは読めません）`
  if (name === 'Glob' && typeof input.pattern === 'string' && input.pattern.split(/[\\/]/).includes('..')) return `Glob の pattern には .. を使えません。${where}`
  const cwd = tmpdir()
  const path = readPath(name, input, cwd)
  if (path === undefined) return `${name} には、${name === 'Read' ? 'file_path に読むファイル' : 'path に探す所'}の絶対パスを渡してください。${where}`
  const target = path === null ? null : resolve(cwd, path)
  // 理由の文には、渡されたパスを入れない
  if (target === null || !readableFile(target, roots)) return `その場所は読めません。${where}`
  if (name === 'Grep' && !isFile(target)) return `Grep は、ファイル 1 つの中だけを探せます（path にファイルを渡す。フォルダの中は、Glob でファイルを探してから）。${where}`
  return null
}

// path が roots のどれかの中で、そこからのパスに . で始まる名前（隠しファイル・フォルダと ..）がないか。
// 書いたままのパスと、シンボリックリンクをたどった先（まだないファイルは、ある所までの親で）の両方で確かめる
export function readableFile(path: string, roots: readonly string[]): boolean {
  const given = resolve(path)
  const real = realish(given)
  return roots.some((root) => {
    const realRoot = realish(resolve(root))
    return (plainlyInside(resolve(root), given) || plainlyInside(realRoot, given)) && plainlyInside(realRoot, real)
  })
}

function plainlyInside(dir: string, path: string): boolean {
  const rel = relative(dir, path)
  return rel === '' || (!isAbsolute(rel) && rel.split(sep).every((part) => !part.startsWith('.')))
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
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
