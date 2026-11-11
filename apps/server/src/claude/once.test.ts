import type { HookCallback, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { answeredModel, ClaudeOnce, DEFAULT_ONCE_MAX_TURNS, DEFAULT_ONCE_MAX_TURNS_WITH_TOOLS, MAX_RUNNING_ONCE, STRUCTURED_OUTPUT_TOOL, type OnceQuery } from './once.ts'

// Claude を 1 回だけ動かす共通の仕組み（単語を調べる MAI-99、APA の引用 MAI-98 などが使う）

type Call = { prompt: string; options: Options }

function success(extra: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 's',
    total_cost_usd: 0.0006,
    duration_ms: 1200,
    num_turns: 2,
    result: 'answer',
    modelUsage: { 'claude-haiku-5-5': {} },
    ...extra,
  } as unknown as SDKMessage
}

// 決まった答えを返す偽の query。渡された頼みを calls に残す
function answering(message: SDKMessage, calls: Call[] = []): OnceQuery {
  return (params) => {
    calls.push(params)
    return (async function* () {
      yield { type: 'system', subtype: 'init' } as unknown as SDKMessage
      yield message
    })()
  }
}

// abortController が止めるまで答えない偽の query
const hanging: OnceQuery = ({ options }) =>
  (async function* () {
    const signal = options.abortController!.signal
    await new Promise<void>((_, reject) => {
      if (signal.aborted) reject(new Error('aborted'))
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
    yield success()
  })()

const hookOf = (options: Options): HookCallback => options.hooks!.PreToolUse![0]!.hooks[0]!
const preToolUse = (tool_name: string) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input: {} }) as unknown as Parameters<HookCallback>[0]

describe('ClaudeOnce', () => {
  it('頼んだモデルで、ツール・MCP・設定なし、会話を残さず動かす（ターン数の上限は既定のもの）', async () => {
    const calls: Call[] = []
    const once = new ClaudeOnce({ run: answering(success(), calls) })
    const result = await once.ask({ prompt: '問い', model: 'haiku', systemPrompt: '係です', effort: 'low' })
    expect(result).toEqual({ text: 'answer', output: undefined, model: 'claude-haiku-5-5', costUsd: 0.0006, durationMs: 1200, turns: 2 })
    const { prompt, options } = calls[0]!
    expect(prompt).toBe('問い')
    expect(options).toMatchObject({
      model: 'haiku',
      effort: 'low',
      systemPrompt: '係です',
      tools: [],
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      maxTurns: DEFAULT_ONCE_MAX_TURNS,
    })
    expect(options.outputFormat).toBeUndefined()
    expect(options.env?.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('canvcode')
  })

  it('JSON の形を渡すと構造化出力にして、答えを output で返す。形にならなければ 502', async () => {
    const schema = { type: 'object', properties: { meaning: { type: 'string' } }, required: ['meaning'] }
    const calls: Call[] = []
    const once = new ClaudeOnce({ run: answering(success({ result: '{"meaning":"意味"}', structured_output: { meaning: '意味' } }), calls) })
    const result = await once.ask<{ meaning: string }>({ prompt: 'p', model: 'sonnet', schema })
    expect(result.output).toEqual({ meaning: '意味' })
    expect(calls[0]!.options.outputFormat).toEqual({ type: 'json_schema', schema })
    // 答えを渡すツール（StructuredOutput）は、フックでも canUseTool でも断らない（断ると、ターン数の上限まで繰り返す）
    const signal = new AbortController().signal
    expect(await hookOf(calls[0]!.options)(preToolUse(STRUCTURED_OUTPUT_TOOL), undefined, { signal })).toEqual({})
    expect(await calls[0]!.options.canUseTool!(STRUCTURED_OUTPUT_TOOL, { meaning: 'm' }, { signal } as never)).toMatchObject({ behavior: 'allow' })
    await expect(new ClaudeOnce({ run: answering(success()) }).ask({ prompt: 'p', model: 'haiku', schema })).rejects.toMatchObject({ status: 502 })
    const retries = success({ subtype: 'error_max_structured_output_retries', is_error: true, errors: [] })
    await expect(new ClaudeOnce({ run: answering(retries) }).ask({ prompt: 'p', model: 'haiku', schema, failure: '引用を作れませんでした' })).rejects.toMatchObject({
      status: 502,
      message: '引用を作れませんでした：答えを決めた形にできませんでした',
    })
  })

  it('WebSearch・WebFetch だけを使わせられる。ほかのツールは頼めず、来てもフックと canUseTool で断る', async () => {
    const calls: Call[] = []
    const once = new ClaudeOnce({ run: answering(success(), calls) })
    await once.ask({ prompt: 'p', model: 'sonnet', tools: ['WebSearch', 'WebFetch'] })
    const { options } = calls[0]!
    expect(options.tools).toEqual(['WebSearch', 'WebFetch'])
    expect(options.allowedTools).toEqual(['WebSearch', 'WebFetch'])
    expect(options.maxTurns).toBe(DEFAULT_ONCE_MAX_TURNS_WITH_TOOLS)
    const hook = hookOf(options)
    const signal = new AbortController().signal
    expect(await hook(preToolUse('WebFetch'), undefined, { signal })).toEqual({})
    // JSON の形を渡していなければ、StructuredOutput も断る
    for (const name of ['Bash', 'Write', 'Read', 'Agent', 'mcp__canvcode__edit_canvas', STRUCTURED_OUTPUT_TOOL]) {
      expect(await hook(preToolUse(name), undefined, { signal })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
      expect(await options.canUseTool!(name, {}, { signal } as never)).toMatchObject({ behavior: 'deny' })
    }
    expect(await options.canUseTool!('WebSearch', { query: 'q' }, { signal } as never)).toEqual({ behavior: 'allow', updatedInput: { query: 'q' } })
    // ターン数の上限は呼ぶごとに変えられる
    await once.ask({ prompt: 'p', model: 'sonnet', tools: ['WebSearch'], maxTurns: 3 })
    expect(calls[1]!.options.maxTurns).toBe(3)
    // 使わせられないツール
    await expect(once.ask({ prompt: 'p', model: 'haiku', tools: ['Bash' as never] })).rejects.toMatchObject({ status: 400 })
  })

  it('失敗の答え・ターン数の上限・答えずに終わったときは 502', async () => {
    const failing = success({ subtype: 'error_during_execution', is_error: true, errors: ['だめでした'] })
    await expect(new ClaudeOnce({ run: answering(failing) }).ask({ prompt: 'p', model: 'haiku' })).rejects.toMatchObject({ status: 502, message: expect.stringContaining('だめでした') })
    const turns = success({ subtype: 'error_max_turns', is_error: true, errors: [] })
    await expect(new ClaudeOnce({ run: answering(turns) }).ask({ prompt: 'p', model: 'haiku' })).rejects.toMatchObject({ status: 502, message: expect.stringContaining('ターン数') })
    const silent: OnceQuery = () => (async function* () {})()
    await expect(new ClaudeOnce({ run: silent }).ask({ prompt: 'p', model: 'haiku' })).rejects.toMatchObject({ status: 502 })
  })

  it('時間がかかりすぎたら止めて 504、頼みをやめたら 499（やめてから頼んでも 499）', async () => {
    await expect(new ClaudeOnce({ run: hanging, timeoutMs: 20 }).ask({ prompt: 'p', model: 'haiku' })).rejects.toMatchObject({ status: 504 })
    await expect(new ClaudeOnce({ run: hanging }).ask({ prompt: 'p', model: 'haiku', timeoutMs: 20 })).rejects.toMatchObject({ status: 504 })
    const controller = new AbortController()
    const pending = new ClaudeOnce({ run: hanging }).ask({ prompt: 'p', model: 'haiku', signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ status: 499 })
    await expect(new ClaudeOnce({ run: hanging }).ask({ prompt: 'p', model: 'haiku', signal: controller.signal })).rejects.toMatchObject({ status: 499 })
  })

  it(`同時に ${MAX_RUNNING_ONCE} つを超えたら 429。終われば、また頼める`, async () => {
    const controller = new AbortController()
    const once = new ClaudeOnce({ run: hanging })
    const pending = Array.from({ length: MAX_RUNNING_ONCE }, () => once.ask({ prompt: 'p', model: 'haiku', signal: controller.signal }).catch(() => {}))
    await expect(once.ask({ prompt: 'p', model: 'haiku' })).rejects.toMatchObject({ status: 429 })
    controller.abort()
    await Promise.all(pending)
    const later = new AbortController()
    const again = once.ask({ prompt: 'p', model: 'haiku', signal: later.signal })
    later.abort()
    await expect(again).rejects.toMatchObject({ status: 499 })
  })
})

describe('answeredModel', () => {
  it('WebFetch がページを読ませたモデル（Haiku）ではなく、頼んだモデルを返す（MAI-98）', () => {
    const usage = { 'claude-haiku-5-5': { costUSD: 0.001 }, 'claude-sonnet-5-5': { costUSD: 0.03 } }
    expect(answeredModel(usage, 'sonnet')).toBe('claude-sonnet-5-5')
    expect(answeredModel(usage, 'claude-haiku-5-5')).toBe('claude-haiku-5-5')
    // 別名が合わなければ、費用のいちばん大きいもの。何もなければ頼んだもの
    expect(answeredModel(usage, 'claude-opus-x')).toBe('claude-sonnet-5-5')
    expect(answeredModel({}, 'haiku')).toBe('haiku')
  })
})
