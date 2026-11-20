import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HookCallback, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { answeredModel, ClaudeOnce, DEFAULT_ONCE_MAX_TURNS, DEFAULT_ONCE_MAX_TURNS_WITH_TOOLS, MAX_RUNNING_ONCE, STRUCTURED_OUTPUT_TOOL, jsonFromText, jsonInstruction, thinksAdaptively, type OnceQuery } from './once.ts'

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

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

// 会話の質問に渡す、読むだけの canvcode の MCP のツール（mcp.ts の readOnly）と、渡さない書くツール
const CANVAS_READ_TOOLS = ['list_canvases', 'read_canvas', 'read_nodes', 'get_canvas_format', 'resolve_reference', 'list_documents', 'read_document', 'render_canvas'].map(
  (name) => `mcp__canvcode__${name}`,
)
const CANVAS_WRITE_TOOLS = ['edit_canvas', 'undo_canvas_edit', 'plot_csv', 'list_plot_styles', 'create_document', 'update_document', 'edit_document'].map((name) => `mcp__canvcode__${name}`)

// root/ws がワークスペース、root/ws/.canvcode/assets が PDF の文字の置き場所、root/outside が外
function folders() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'canvcode-once-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const ws = join(root, 'ws')
  const assets = join(ws, '.canvcode', 'assets')
  for (const dir of [join(ws, 'notes'), join(ws, '.git'), assets, join(root, 'outside')]) mkdirSync(dir, { recursive: true })
  for (const file of [join(ws, 'notes', 'a.md'), join(ws, '.env'), join(ws, '.git', 'config'), join(ws, '.canvcode', 'claude.db'), join(assets, 'abc.txt'), join(root, 'outside', 'secret.txt')]) {
    writeFileSync(file, 'x')
  }
  symlinkSync(join(root, 'outside', 'secret.txt'), join(ws, 'notes', 'out.md'))
  symlinkSync(join(ws, '.env'), join(ws, 'notes', 'env.md'))
  symlinkSync(join(ws, '.canvcode'), join(ws, 'notes', 'data'))
  return { root, ws, assets }
}

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
    // 頭を空にすると、わけだけにする（画面が頭を付けるとき）
    await expect(new ClaudeOnce({ run: answering(retries) }).ask({ prompt: 'p', model: 'haiku', schema, failure: '' })).rejects.toMatchObject({
      status: 502,
      message: '答えを決めた形にできませんでした',
    })
    const noDetail = success({ subtype: 'error_during_execution', is_error: true, errors: [] })
    await expect(new ClaudeOnce({ run: answering(noDetail) }).ask({ prompt: 'p', model: 'haiku', failure: '' })).rejects.toMatchObject({
      message: 'Claude Code が誤りで終わりました',
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

  it('読むだけの canvcode の MCP を渡すと、同じプロセスの中の MCP としてつなぎ、読むツールだけを許す（書くツールは来ても断る）', async () => {
    const calls: Call[] = []
    const canvas = new McpServer({ name: 'canvcode', version: '0.0.0' })
    await new ClaudeOnce({ run: answering(success(), calls) }).ask({ prompt: 'p', model: 'sonnet', tools: ['WebSearch'], canvas })
    const { options } = calls[0]!
    expect(options.mcpServers).toEqual({ canvcode: { type: 'sdk', name: 'canvcode', instance: canvas } })
    expect(options.strictMcpConfig).toBe(true)
    expect(options.tools).toEqual(['WebSearch'])
    expect(options.allowedTools).toEqual(['WebSearch', ...CANVAS_READ_TOOLS])
    expect(options.maxTurns).toBe(DEFAULT_ONCE_MAX_TURNS_WITH_TOOLS)
    const hook = hookOf(options)
    const signal = new AbortController().signal
    for (const name of CANVAS_READ_TOOLS) {
      expect(await hook(preToolUse(name), undefined, { signal }), name).toEqual({})
      expect(await options.canUseTool!(name, { id: 'x' }, { signal } as never), name).toEqual({ behavior: 'allow', updatedInput: { id: 'x' } })
    }
    for (const name of [...CANVAS_WRITE_TOOLS, 'mcp__other__read_canvas', 'Bash', 'Read', 'Glob', 'Grep']) {
      expect(await hook(preToolUse(name), undefined, { signal }), name).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
      expect(await options.canUseTool!(name, {}, { signal } as never), name).toMatchObject({ behavior: 'deny' })
    }
    // MCP だけでも、ツールのあるときのターン数の上限
    await new ClaudeOnce({ run: answering(success(), calls) }).ask({ prompt: 'p', model: 'sonnet', canvas: new McpServer({ name: 'canvcode', version: '0.0.0' }) })
    expect(calls[1]!.options.maxTurns).toBe(DEFAULT_ONCE_MAX_TURNS_WITH_TOOLS)
    expect(calls[1]!.options.tools).toEqual([])
  })

  describe('読むツールを渡すときの WebFetch（読んだ中身を URL に入れて外に送らせない）', () => {
    type Decide = (input: Record<string, unknown>) => Promise<boolean>
    // フックと canUseTool の両方で同じに決めることを確かめて、WebFetch を許したか（true）を返す
    const fetcher = (options: Options): Decide => async (input) => {
      const signal = new AbortController().signal
      const hooked = await hookOf(options)({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: input } as unknown as Parameters<HookCallback>[0], undefined, { signal })
      const used = (await options.canUseTool!('WebFetch', input, { signal } as never)) as { behavior: string; message?: string }
      const denied = (hooked as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput
      expect(denied?.permissionDecision === 'deny', JSON.stringify(input)).toBe(used.behavior === 'deny')
      if (denied) expect(denied.permissionDecisionReason).toContain('そのまま渡してください')
      return used.behavior === 'allow'
    }
    // PostToolUse のフック（Claude Code は、ツールの結果を Claude に渡す前に、これを待つ）
    const postToolUse = (options: Options, tool_name: string, tool_response: unknown) =>
      options.hooks!.PostToolUse![0]!.hooks[0]!(
        { hook_event_name: 'PostToolUse', tool_name, tool_input: {}, tool_response, tool_use_id: 't' } as unknown as Parameters<HookCallback>[0],
        undefined,
        { signal: new AbortController().signal },
      )
    const prompt = '次の資料を読んで：https://example.org/report.pdf。（参考 https://example.org/a_(b)）と https://example.jp/ページ。続きは https://example.com/nextです'

    it('頼む文に出た URL はそのまま渡せる。文字やクエリを足したもの・どこにも出ていない URL は断る。尋ねずには許さない（allowedTools に入れない）', async () => {
      const calls: Call[] = []
      await new ClaudeOnce({ run: answering(success(), calls) }).ask({ prompt, model: 'sonnet', tools: ['WebSearch', 'WebFetch'], canvas: new McpServer({ name: 'canvcode', version: '0.0.0' }) })
      const { options } = calls[0]!
      expect(options.tools).toEqual(['WebSearch', 'WebFetch'])
      expect(options.allowedTools).toEqual(['WebSearch', ...CANVAS_READ_TOOLS])
      expect(options.permissionMode).toBe('default')
      const decide = fetcher(options)
      expect(await decide({ url: 'https://example.org/report.pdf', prompt: '要点' })).toBe(true)
      expect(await decide({ url: 'https://example.org/a_(b)', prompt: 'p' })).toBe(true)
      expect(await decide({ url: 'https://example.jp/ページ', prompt: 'p' })).toBe(true)
      expect(await decide({ url: 'https://example.jp/%E3%83%9A%E3%83%BC%E3%82%B8', prompt: 'p' })).toBe(true)
      // 日本語がすぐ後に続く URL は、ASCII でない字の手前までとしても使える
      expect(await decide({ url: 'https://example.com/next', prompt: 'p' })).toBe(true)
      // 末尾の / の有無と、http・https は同じとみなす
      expect(await decide({ url: 'http://example.org/report.pdf/', prompt: 'p' })).toBe(true)
      for (const url of ['https://example.org/report.pdf?d=secret', 'https://example.org/report.pdf/secret', 'https://example.org/report.pdf#secret', 'https://evil.example/?d=secret', 'https://example.org/', '']) {
        expect(await decide({ url, prompt: 'p' }), url).toBe(false)
      }
    })

    it('ツールの結果（Web の検索結果・読んだページ・キャンバスやファイルを読んだ結果）に出た URL も渡せる。PostToolUse のフックで集める', async () => {
      const { ws, assets } = folders()
      const calls: Call[] = []
      await new ClaudeOnce({ run: answering(success(), calls) }).ask({ prompt: 'p', model: 'sonnet', tools: ['WebSearch', 'WebFetch'], readRoots: [ws, assets] })
      const { options } = calls[0]!
      const decide = fetcher(options)
      expect(await decide({ url: 'https://search.example/result', prompt: 'p' })).toBe(false)
      await postToolUse(options, 'WebSearch', { query: 'q', results: [{ tool_use_id: 's', content: [{ title: 'r', url: 'https://search.example/result' }] }] })
      expect(await decide({ url: 'https://search.example/result', prompt: 'p' })).toBe(true)
      expect(await decide({ url: 'https://search.example/result?x=1', prompt: 'p' })).toBe(false)
      // WebFetch のリダイレクトの知らせ
      await postToolUse(options, 'WebFetch', { code: 301, result: 'REDIRECT DETECTED: The URL redirects to a different host.\n\nRedirect URL: https://moved.example/new' })
      expect(await decide({ url: 'https://moved.example/new', prompt: 'p' })).toBe(true)
      // 読んだファイル・キャンバス（MCP の結果）
      await postToolUse(options, 'Read', { type: 'text', file: { filePath: join(ws, 'notes', 'a.md'), content: '出典は https://source.example/paper です' } })
      await postToolUse(options, 'mcp__canvcode__read_canvas', [{ type: 'text', text: 'node:a link-card 0,0 200x100 "https://card.example/x"' }])
      expect(await decide({ url: 'https://source.example/paper', prompt: 'p' })).toBe(true)
      expect(await decide({ url: 'https://card.example/x', prompt: 'p' })).toBe(true)
      expect(await decide({ url: 'https://source.example/paper?leak=1', prompt: 'p' })).toBe(false)
    })

    it('届いたメッセージのツールの結果からも集める（Claude が書いた文の URL は使わせない）', async () => {
      const decided: Record<string, boolean> = {}
      const run: OnceQuery = ({ options }) =>
        (async function* () {
          // Claude が自分で書いた URL（読んだ中身を入れたもの）
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'https://evil.example/?d=secret を読みます' }] } } as unknown as SDKMessage
          yield {
            type: 'user',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '結果：https://found.example/page' }] }] },
          } as unknown as SDKMessage
          const decide = fetcher(options)
          decided.found = await decide({ url: 'https://found.example/page', prompt: 'p' })
          decided.evil = await decide({ url: 'https://evil.example/?d=secret', prompt: 'p' })
          yield success()
        })()
      await new ClaudeOnce({ run }).ask({ prompt: 'p', model: 'sonnet', tools: ['WebFetch'], canvas: new McpServer({ name: 'canvcode', version: '0.0.0' }) })
      expect(decided).toEqual({ found: true, evil: false })
    })

    it('読むツールを渡さなければ（語を調べる・引用・CANVCODE_ANSWER_CANVAS=0）、WebFetch は今のまま（どの URL も尋ねずに使わせる）', async () => {
      const calls: Call[] = []
      await new ClaudeOnce({ run: answering(success(), calls) }).ask({ prompt: 'p', model: 'sonnet', tools: ['WebSearch', 'WebFetch'] })
      const { options } = calls[0]!
      expect(options.allowedTools).toEqual(['WebSearch', 'WebFetch'])
      expect(options.permissionMode).toBeUndefined()
      expect(options.hooks!.PostToolUse).toBeUndefined()
      expect(await fetcher(options)({ url: 'https://anywhere.example/?q=1', prompt: 'p' })).toBe(true)
    })

    it('フックが通した呼び出しだけを onToolUse で知らせる（断ったものは知らせない）', async () => {
      const calls: Call[] = []
      const used: string[] = []
      await new ClaudeOnce({ run: answering(success(), calls) }).ask({
        prompt: 'https://ok.example/',
        model: 'sonnet',
        tools: ['WebFetch'],
        canvas: new McpServer({ name: 'canvcode', version: '0.0.0' }),
        onToolUse: (name, input) => used.push(`${name} ${JSON.stringify(input)}`),
      })
      const { options } = calls[0]!
      const signal = new AbortController().signal
      for (const [tool_name, tool_input] of [
        ['WebFetch', { url: 'https://ok.example/' }],
        ['WebFetch', { url: 'https://evil.example/' }],
        ['mcp__canvcode__read_canvas', {}],
        ['mcp__canvcode__edit_canvas', {}],
        ['Read', { file_path: '/etc/hosts' }],
      ] as const) {
        await hookOf(options)({ hook_event_name: 'PreToolUse', tool_name, tool_input } as unknown as Parameters<HookCallback>[0], undefined, { signal })
      }
      expect(used).toEqual(['WebFetch {"url":"https://ok.example/"}', 'mcp__canvcode__read_canvas {}'])
    })
  })

  describe('ファイルを読むツール（Read・Glob・Grep）', () => {

    async function asked(readRoots: string[] | undefined) {
      const calls: Call[] = []
      await new ClaudeOnce({ run: answering(success(), calls) }).ask({ prompt: 'p', model: 'sonnet', ...(readRoots ? { readRoots } : {}) })
      const { options } = calls[0]!
      const signal = new AbortController().signal
      const hook = hookOf(options)
      // フックと canUseTool の両方で同じに決めることを確かめて、許したか（true）断ったか（false）を返す
      const decide = async (name: string, input: Record<string, unknown>): Promise<boolean> => {
        const hooked = await hook({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input } as unknown as Parameters<HookCallback>[0], undefined, { signal })
        const used = (await options.canUseTool!(name, input, { signal } as never)) as { behavior: string; updatedInput?: unknown }
        const denied = (hooked as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision === 'deny'
        expect(denied, `${name} ${JSON.stringify(input)}`).toBe(used.behavior === 'deny')
        if (used.behavior === 'allow') expect(used.updatedInput).toEqual(input)
        return !denied
      }
      return { options, decide }
    }

    it('読めるフォルダを渡すと Read・Glob・Grep を見せる。尋ねずには許さない（allowedTools に入れず、canUseTool でも確かめる）', async () => {
      const { ws, assets } = folders()
      const { options } = await asked([ws, assets])
      expect(options.tools).toEqual(['Read', 'Glob', 'Grep'])
      expect(options.allowedTools).toEqual([])
      expect(options.mcpServers).toEqual({})
      expect(options.cwd).toBe(tmpdir())
      expect(options.maxTurns).toBe(DEFAULT_ONCE_MAX_TURNS_WITH_TOOLS)
      // 渡さなければ（語を調べる・引用・メモ）、今のまま
      expect((await asked(undefined)).options.tools).toEqual([])
      expect((await asked([])).options.tools).toEqual([])
    })

    it('読めるフォルダの中は読ませる（PDF の文字の置き場所は、.canvcode の中でも読める）', async () => {
      const { ws, assets } = folders()
      const { decide } = await asked([ws, assets])
      expect(await decide('Read', { file_path: join(ws, 'notes', 'a.md') })).toBe(true)
      expect(await decide('Read', { file_path: join(assets, 'abc.txt'), offset: 10, limit: 50 })).toBe(true)
      expect(await decide('Grep', { pattern: 'page 3', path: join(assets, 'abc.txt'), output_mode: 'content' })).toBe(true)
      expect(await decide('Glob', { pattern: '**/*.md', path: ws })).toBe(true)
      expect(await decide('Glob', { pattern: '*.txt', path: assets })).toBe(true)
      expect(await decide('Glob', { pattern: `${ws}/notes/*.md` })).toBe(true)
      // まだないファイルも、場所で決める
      expect(await decide('Read', { file_path: join(ws, 'notes', 'new.md') })).toBe(true)
    })

    it('外・隠しファイル・.canvcode の中・シンボリックリンクや ../ で外に出るものは断る', async () => {
      const { root, ws, assets } = folders()
      const { decide } = await asked([ws, assets])
      for (const path of [
        join(root, 'outside', 'secret.txt'),
        `${ws}/../outside/secret.txt`,
        `${assets}/../claude.db`,
        join(ws, '.env'),
        join(ws, '.git', 'config'),
        join(ws, '.canvcode', 'claude.db'),
        // リンクで外・隠しファイル・.canvcode に出る
        join(ws, 'notes', 'out.md'),
        join(ws, 'notes', 'env.md'),
        join(ws, 'notes', 'data', 'claude.db'),
        '/etc/passwd',
        tmpdir(),
      ]) {
        expect(await decide('Read', { file_path: path }), path).toBe(false)
      }
      expect(await decide('Glob', { pattern: '*', path: join(ws, '.git') })).toBe(false)
      expect(await decide('Glob', { pattern: '*', path: join(root, 'outside') })).toBe(false)
      expect(await decide('Glob', { pattern: '/etc/*' })).toBe(false)
      expect(await decide('Glob', { pattern: '.canvcode/*', path: ws })).toBe(false)
      expect(await decide('Glob', { pattern: '../outside/*', path: ws })).toBe(false)
      expect(await decide('Glob', { pattern: '**/../../outside/*', path: ws })).toBe(false)
      expect(await decide('Grep', { pattern: 'x', path: join(ws, '.env') })).toBe(false)
      expect(await decide('Grep', { pattern: 'x', path: join(ws, 'notes', 'out.md') })).toBe(false)
    })

    it('相対パスと、path を省いた Glob・Grep（cwd の一時フォルダを探す）、フォルダを探す Grep（隠しファイルの中まで探す）は断る', async () => {
      const { ws, assets } = folders()
      const { decide } = await asked([ws, assets])
      expect(await decide('Read', { file_path: 'notes/a.md' })).toBe(false)
      expect(await decide('Read', {})).toBe(false)
      expect(await decide('Glob', { pattern: '**/*.md' })).toBe(false)
      expect(await decide('Glob', { pattern: 'notes/*.md' })).toBe(false)
      expect(await decide('Grep', { pattern: 'x' })).toBe(false)
      expect(await decide('Grep', { pattern: 'x', path: ws })).toBe(false)
      expect(await decide('Grep', { pattern: 'x', path: assets })).toBe(false)
      expect(await decide('Grep', { pattern: 'x', path: 'notes/a.md' })).toBe(false)
      // ほかのツールは、今までどおり断る
      expect(await decide('Bash', { command: `cat ${join(ws, 'notes', 'a.md')}` })).toBe(false)
      expect(await decide('Write', { file_path: join(ws, 'notes', 'a.md'), content: 'y' })).toBe(false)
      expect(await decide('NotebookEdit', { notebook_path: join(ws, 'a.ipynb') })).toBe(false)
    })
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

describe('thinking', () => {
  const delta = (thinking: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } } }) as unknown as SDKMessage

  it('onThinking を渡すと、考えている中身を要約して返すよう頼み、届いた分を渡す。渡さなければ頼まない', async () => {
    const calls: Call[] = []
    const run: OnceQuery = (params) => {
      calls.push(params)
      return (async function* () {
        yield delta('まず')
        yield delta('')
        yield delta('考える。')
        yield success()
      })()
    }
    const got: string[] = []
    await new ClaudeOnce({ run }).ask({ prompt: '問い', model: 'sonnet', onThinking: (text) => got.push(text) })
    expect(got).toEqual(['まず', '考える。'])
    expect(calls[0]!.options).toMatchObject({ includePartialMessages: true, thinking: { type: 'adaptive', display: 'summarized' } })
    await new ClaudeOnce({ run }).ask({ prompt: '問い', model: 'sonnet' })
    expect(calls[1]!.options.includePartialMessages).toBeUndefined()
    expect(calls[1]!.options.thinking).toBeUndefined()
    // 考える仕組みを持たない古いモデルには頼まない
    await new ClaudeOnce({ run }).ask({ prompt: '問い', model: 'claude-haiku-4-5-20251001', onThinking: () => undefined })
    expect(calls[2]!.options.thinking).toBeUndefined()
  })

  it('JSON の形と一緒に onThinking を渡すと、構造化出力を使わず（モデルが考えないので）、JSON を文字で返させて読む。読めなければ 502', async () => {
    const schema = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] }
    const calls: Call[] = []
    const result = await new ClaudeOnce({ run: answering(success({ result: '```json\n{"a": 1}\n```' }), calls) }).ask({
      prompt: '問い',
      model: 'sonnet',
      systemPrompt: '係です',
      schema,
      onThinking: () => undefined,
    })
    expect(result.output).toEqual({ a: 1 })
    const { options } = calls[0]!
    expect(options.outputFormat).toBeUndefined()
    expect(options.systemPrompt).toBe(`係です\n\n${jsonInstruction(schema)}`)
    expect(options.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    // 答えを渡すツールは使わせない
    expect(await hookOf(options)(preToolUse(STRUCTURED_OUTPUT_TOOL), undefined, { signal: new AbortController().signal })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    })
    // 前後に文があっても、{ から } までを読む
    const wordy = await new ClaudeOnce({ run: answering(success({ result: 'はい。{"a": 2} です' })) }).ask({ prompt: '問い', model: 'sonnet', schema, onThinking: () => undefined })
    expect(wordy.output).toEqual({ a: 2 })
    await expect(new ClaudeOnce({ run: answering(success({ result: 'JSON ではない' })) }).ask({ prompt: '問い', model: 'sonnet', schema, onThinking: () => undefined })).rejects.toMatchObject({
      status: 502,
    })
    // 考えない古いモデルなら、これまでどおり構造化出力
    const old: Call[] = []
    await new ClaudeOnce({ run: answering(success({ structured_output: { a: 3 } }), old) }).ask({ prompt: '問い', model: 'claude-sonnet-4-5', schema, onThinking: () => undefined })
    expect(old[0]!.options.outputFormat).toEqual({ type: 'json_schema', schema })
  })

  it('jsonFromText は、オブジェクトでない JSON を読まない', () => {
    expect(jsonFromText('[1, 2]')).toBeUndefined()
    expect(jsonFromText('"text"')).toBeUndefined()
    expect(jsonFromText('{"a": {"b": 1}}')).toEqual({ a: { b: 1 } })
  })

  it('adaptive thinking を持つモデル：別名と 4.6 以降。4.5 までと 3 系は持たない', () => {
    for (const model of ['sonnet', 'opus', 'haiku', 'fable', 'claude-sonnet-4-6', 'claude-opus-4-7', 'claude-opus-5-5', 'claude-haiku-5-5']) expect(thinksAdaptively(model)).toBe(true)
    for (const model of ['claude-sonnet-4-5', 'claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001', 'claude-opus-4-1', 'claude-3-7-sonnet-latest', 'claude-sonnet-4-5@20250929']) {
      expect(thinksAdaptively(model)).toBe(false)
    }
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
