import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_MEMO_MODEL, handleMemo, MAX_RUNNING_MEMOS, MemoWriter, parseMemo, type MemoQuery } from './memo.ts'

// 付箋の文字を箇条書きのメモにする

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function success(result: string): SDKMessage {
  return { type: 'result', subtype: 'success', is_error: false, session_id: 's', total_cost_usd: 0, duration_ms: 1, result } as unknown as SDKMessage
}

// 決まった答えを返す偽の query。渡された頼みを calls に残す
function answering(answer: string, calls: { prompt: string; options: Options }[] = []): MemoQuery {
  return (params) => {
    calls.push(params)
    return (async function* () {
      yield { type: 'system', subtype: 'init' } as unknown as SDKMessage
      yield success(answer)
    })()
  }
}

// abortController が止めるまで答えない偽の query
const hanging: MemoQuery = ({ options }) =>
  (async function* () {
    const signal = options.abortController!.signal
    await new Promise<void>((_, reject) => {
      if (signal.aborted) reject(new Error('aborted'))
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
    yield success('')
  })()

describe('parseMemo', () => {
  it('「- 」の行を項目にし、字下げ 2 つで 1 段深くする', () => {
    expect(parseMemo('- 受信側も AI を使う\n  - 送信側も AI で喋る\n  - 受信側も AI で喋る\n- 人間の役割は何か')).toEqual([
      { text: '受信側も AI を使う', level: 0 },
      { text: '送信側も AI で喋る', level: 1 },
      { text: '受信側も AI で喋る', level: 1 },
      { text: '人間の役割は何か', level: 0 },
    ])
  })

  it('前置き・コードブロック・空の行は捨て、ほかの記号の箇条書きと太字も読む', () => {
    expect(parseMemo('以下がメモです：\n```\n* **送信側**も AI\n\n・受信側も AI\n1. 順番\n```')).toEqual([
      { text: '送信側も AI', level: 0 },
      { text: '受信側も AI', level: 0 },
      { text: '順番', level: 0 },
    ])
  })

  it('前の項目より 2 段以上深くせず、3 段より深くもしない', () => {
    expect(parseMemo('    - いきなり深い\n- 外\n  - 1 段\n    - 2 段\n      - 3 段')).toEqual([
      { text: 'いきなり深い', level: 0 },
      { text: '外', level: 0 },
      { text: '1 段', level: 1 },
      { text: '2 段', level: 2 },
      { text: '3 段', level: 2 },
    ])
  })

  it('「-5 度」「3.5 倍」のような行は箇条書きと読まない。箇条書きが 1 つもなければ、行をそのまま項目にする', () => {
    expect(parseMemo('-5 度まで下がる\n3.5 倍になった')).toEqual([
      { text: '-5 度まで下がる', level: 0 },
      { text: '3.5 倍になった', level: 0 },
    ])
    expect(parseMemo('\n\n')).toEqual([])
  })
})

describe('MemoWriter', () => {
  it('Haiku を、ツール・MCP・設定なし、会話を残さず、1 ターンだけ動かす', async () => {
    const calls: { prompt: string; options: Options }[] = []
    const memo = new MemoWriter({ run: answering('- 項目', calls) })
    expect(await memo.write('えっと、項目です')).toEqual([{ text: '項目', level: 0 }])
    expect(calls).toHaveLength(1)
    const { prompt, options } = calls[0]!
    expect(prompt).toContain('<text>\nえっと、項目です\n</text>')
    expect(options).toMatchObject({ model: DEFAULT_MEMO_MODEL, tools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], persistSession: false, maxTurns: 1 })
    expect(typeof options.systemPrompt).toBe('string')
  })

  it('モデルを変えられる', async () => {
    const calls: { prompt: string; options: Options }[] = []
    await new MemoWriter({ model: 'claude-sonnet-5-5', run: answering('- a', calls) }).write('a')
    expect(calls[0]!.options.model).toBe('claude-sonnet-5-5')
  })

  it('失敗の答え・箇条書きにならない答え・答えずに終わったときは 502', async () => {
    const failing: MemoQuery = () =>
      (async function* () {
        yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['だめでした'] } as unknown as SDKMessage
      })()
    await expect(new MemoWriter({ run: failing }).write('a')).rejects.toMatchObject({ status: 502, message: expect.stringContaining('だめでした') })
    await expect(new MemoWriter({ run: answering('\n') }).write('a')).rejects.toMatchObject({ status: 502 })
    const silent: MemoQuery = () => (async function* () {})()
    await expect(new MemoWriter({ run: silent }).write('a')).rejects.toMatchObject({ status: 502 })
  })

  it('時間がかかりすぎたら止めて 504、頼みをやめたら 499', async () => {
    await expect(new MemoWriter({ run: hanging, timeoutMs: 20 }).write('a')).rejects.toMatchObject({ status: 504 })
    const controller = new AbortController()
    const pending = new MemoWriter({ run: hanging }).write('a', controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ status: 499 })
  })

  it(`同時に ${MAX_RUNNING_MEMOS} つを超えたら 429。終われば、また頼める`, async () => {
    const controller = new AbortController()
    const memo = new MemoWriter({ run: hanging })
    const pending = Array.from({ length: MAX_RUNNING_MEMOS }, () => memo.write('a', controller.signal).catch(() => {}))
    await expect(memo.write('a')).rejects.toMatchObject({ status: 429 })
    controller.abort()
    await Promise.all(pending)
    const later = new AbortController()
    const again = memo.write('a', later.signal)
    later.abort()
    await expect(again).rejects.toMatchObject({ status: 499 })
  })
})

describe('POST /api/claude/memo', () => {
  async function start(memo: MemoWriter | null): Promise<string> {
    const server: Server = createServer((req, res) => {
      if (handleMemo(req, res, new URL(req.url!, 'http://x').pathname, memo)) return
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/claude/memo`
  }

  const post = (url: string, body: string, type = 'application/json') => fetch(url, { method: 'POST', headers: { 'content-type': type }, body })

  it('文章を項目の並びにして返す', async () => {
    const url = await start(new MemoWriter({ run: answering('- 送信側も AI\n  - 喋る') }))
    const response = await post(url, JSON.stringify({ text: '  送信側もAI使ってしゃぶるし  ' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      items: [
        { text: '送信側も AI', level: 0 },
        { text: '喋る', level: 1 },
      ],
    })
  })

  it('JSON でない・text がない・長すぎる・GET は断る', async () => {
    const url = await start(new MemoWriter({ run: answering('- a') }))
    expect((await post(url, 'text=a', 'application/x-www-form-urlencoded')).status).toBe(415)
    expect((await post(url, JSON.stringify({ text: '  ' }))).status).toBe(400)
    expect((await post(url, '{')).status).toBe(400)
    expect((await post(url, JSON.stringify({ text: 'あ'.repeat(20_001) }))).status).toBe(413)
    expect((await fetch(url)).status).toBe(405)
  })

  it('MemoWriter がなければ（CANVCODE_CLAUDE=0）受け持たない', async () => {
    const url = await start(null)
    expect((await post(url, JSON.stringify({ text: 'a' }))).status).toBe(404)
  })
})
