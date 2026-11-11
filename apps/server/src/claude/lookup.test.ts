import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_LOOKUP_MODEL, handleLookup, LOOKUP_SCHEMA, lookupPrompt, MAX_LOOKUP_CONTEXT_LENGTH, WordLookup } from './lookup.ts'
import { ClaudeOnce, DEFAULT_ONCE_MAX_TURNS, type OnceQuery } from './once.ts'

// PDF の上で選んだ語を調べる（MAI-99）

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Call = { prompt: string; options: Options }

// structured_output に answer を入れて答える偽の query
function answering(answer: unknown, calls: Call[] = []): OnceQuery {
  return (params) => {
    calls.push(params)
    return (async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's',
        total_cost_usd: 0,
        duration_ms: 1,
        num_turns: 2,
        result: JSON.stringify(answer),
        structured_output: answer,
        modelUsage: { 'claude-haiku-5-5': {} },
      } as unknown as SDKMessage
    })()
  }
}

const lookupWith = (answer: unknown, calls: Call[] = [], model?: string) => new WordLookup({ once: new ClaudeOnce({ run: answering(answer, calls) }), ...(model ? { model } : {}) })

describe('WordLookup', () => {
  it('語と前後の文を囲んで、Haiku に、ツールなし・決めた JSON の形で頼む', async () => {
    const calls: Call[] = []
    const lookup = lookupWith({ meaning: '学習に使った文章の集まり', reading: '/ˈkɔːrpəs/', partOfSpeech: '名詞' }, calls)
    expect(await lookup.lookup('corpus', 'The model was trained on a corpus of text.')).toEqual({
      phrase: 'corpus',
      meaning: '学習に使った文章の集まり',
      reading: '/ˈkɔːrpəs/',
      partOfSpeech: '名詞',
      model: 'claude-haiku-5-5',
    })
    const { prompt, options } = calls[0]!
    expect(prompt).toBe(lookupPrompt('corpus', 'The model was trained on a corpus of text.'))
    expect(prompt).toContain('<phrase>corpus</phrase>')
    expect(prompt).toContain('<context>\nThe model was trained on a corpus of text.\n</context>')
    expect(options).toMatchObject({ model: DEFAULT_LOOKUP_MODEL, tools: [], maxTurns: DEFAULT_ONCE_MAX_TURNS, effort: 'low', outputFormat: { type: 'json_schema', schema: LOOKUP_SCHEMA } })
  })

  it('モデルを変えられる。読み方・品詞の空の答えは省き、意味がなければ 502', async () => {
    const calls: Call[] = []
    expect(await lookupWith({ meaning: ' 意味 ', reading: ' ', partOfSpeech: '' }, calls, 'sonnet').lookup('語', '')).toEqual({ phrase: '語', meaning: '意味', model: 'claude-haiku-5-5' })
    expect(calls[0]!.options.model).toBe('sonnet')
    expect(calls[0]!.prompt).not.toContain('<context>')
    await expect(lookupWith({ meaning: '' }).lookup('語', '')).rejects.toMatchObject({ status: 502 })
  })
})

describe('POST /api/claude/lookup', () => {
  async function start(lookup: WordLookup | null): Promise<string> {
    const server: Server = createServer((req, res) => {
      if (handleLookup(req, res, new URL(req.url!, 'http://x').pathname, lookup)) return
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/claude/lookup`
  }

  const post = (url: string, body: string, type = 'application/json') => fetch(url, { method: 'POST', headers: { 'content-type': type }, body })

  it('意味を返す（語の空白はまとめる）', async () => {
    const calls: Call[] = []
    const url = await start(lookupWith({ meaning: '意味' }, calls))
    const response = await post(url, JSON.stringify({ phrase: '  state of\nthe art ', context: '  文  ' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ phrase: 'state of the art', meaning: '意味', model: 'claude-haiku-5-5' })
    expect(calls[0]!.prompt).toBe(lookupPrompt('state of the art', '文'))
  })

  it('JSON でない・語がない・長すぎる・GET は断る', async () => {
    const url = await start(lookupWith({ meaning: '意味' }))
    expect((await post(url, 'phrase=a', 'application/x-www-form-urlencoded')).status).toBe(415)
    expect((await post(url, JSON.stringify({ phrase: ' ' }))).status).toBe(400)
    expect((await post(url, JSON.stringify({ phrase: 'a', context: 3 }))).status).toBe(400)
    expect((await post(url, '{')).status).toBe(400)
    expect((await post(url, JSON.stringify({ phrase: 'a'.repeat(201) }))).status).toBe(413)
    expect((await post(url, JSON.stringify({ phrase: 'a', context: 'あ'.repeat(MAX_LOOKUP_CONTEXT_LENGTH + 1) }))).status).toBe(413)
    expect((await fetch(url)).status).toBe(405)
  })

  it('WordLookup がなければ（CANVCODE_CLAUDE=0）受け持たない', async () => {
    const url = await start(null)
    expect((await post(url, JSON.stringify({ phrase: 'a' }))).status).toBe(404)
  })
})
