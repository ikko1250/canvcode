import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { FigureStore } from './figures.ts'
import { FileStore } from './files.ts'
import { SlidesApi } from './slides.ts'

// キャンバスのフレームを図にする（提案 B）：図の画像の保存と、デッキからの参照

const FRAME = 'node:Frame0123456789ab'
const PNG_A = Buffer.from('\x89PNG\r\n\x1a\nA', 'binary')
const PNG_B = Buffer.from('\x89PNG\r\n\x1a\nB', 'binary')

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(options: { frames?: string[] } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'canvcode-figures-'))
  cleanups.push(() => rmSync(workspace, { recursive: true, force: true }))
  const dataDir = join(workspace, '.canvcode')
  const announced: string[] = []
  const files = new FileStore(workspace, dataDir, (event) => {
    if (event.type === 'file-changed') announced.push(event.file.id)
  })
  await files.init()
  cleanups.push(() => files.close())
  const figures = new FigureStore(dataDir)
  await figures.init()
  const frames = new Set(options.frames ?? [FRAME])
  const api = new SlidesApi(files, workspace, 0, dataDir, { figures, frameExists: (id) => frames.has(id) })
  return { api, figures, files, workspace, announced, hooks: api.figureHooks() }
}

async function request(
  handle: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>,
  method: string,
  path: string,
  body?: { json?: unknown; png?: Buffer },
): Promise<{ status: number; body: Buffer; type: string }> {
  const url = new URL(path, 'http://127.0.0.1')
  const chunks = body?.png ? [body.png] : body?.json !== undefined ? [Buffer.from(JSON.stringify(body.json))] : []
  const headers = body?.png ? { 'content-type': 'image/png' } : {}
  const req = Object.assign(Readable.from(chunks), { method, headers }) as unknown as IncomingMessage
  let status = 0
  let type = ''
  const out: Buffer[] = []
  const res = {
    writeHead(code: number, head?: Record<string, unknown>) {
      status = code
      type = String(head?.['content-type'] ?? '')
      return this
    },
    end(data?: string | Buffer) {
      if (data) out.push(Buffer.from(data))
    },
  } as unknown as ServerResponse
  await handle(req, res, url)
  return { status, body: Buffer.concat(out), type }
}

function slidesHandler(api: SlidesApi) {
  return (req: IncomingMessage, res: ServerResponse, url: URL) => api.handle(req, res, url.pathname, url.searchParams)
}

function figuresHandler(ctx: Awaited<ReturnType<typeof setup>>) {
  return (req: IncomingMessage, res: ServerResponse, url: URL) => ctx.figures.handle(req, res, url.pathname, ctx.hooks)
}

// 画像を作る処理が終わるまで待つ（テストの環境では Chromium が無く、失敗して終わる）
async function settledPages(api: SlidesApi, id: string): Promise<{ key: string; hash: string }[]> {
  for (let i = 0; i < 100; i++) {
    const response = await request(slidesHandler(api), 'GET', `/api/slides/${encodeURIComponent(id)}/pages`)
    const state = JSON.parse(response.body.toString()) as { pages: { key: string; hash: string }[]; pending: boolean }
    if (!state.pending) return state.pages
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('slide pages did not settle')
}

describe('FigureStore', () => {
  it('stores and serves a frame image, and rejects other ids', async () => {
    const ctx = await setup()
    const handler = figuresHandler(ctx)
    expect((await request(handler, 'GET', `/api/figures/${FRAME}.png`)).status).toBe(404)
    expect((await request(handler, 'PUT', `/api/figures/${FRAME}.png`, { png: PNG_A })).status).toBe(200)
    const served = await request(handler, 'GET', `/api/figures/${encodeURIComponent(FRAME)}.png`)
    expect(served.status).toBe(200)
    expect(served.body.equals(PNG_A)).toBe(true)
    expect((await request(handler, 'GET', '/api/figures/canvas%3Ax.png')).status).toBe(404)
    expect((await request(handler, 'PUT', '/api/figures/..%2Fx.png', { png: PNG_A })).status).toBe(404)
  })

  it('lists the frames referenced from decks', async () => {
    const ctx = await setup()
    const deck = await ctx.files.create('slides', 'deck', `# 図 {#s-aaaaaa}\n| a | b |\n![図](canvas:${FRAME})\n`, { extension: '.slide.md' })
    await ctx.files.create('slides', 'broken', '# x\n- a\n| a | b |\n', { extension: '.slide.md' })
    const listed = await request(figuresHandler(ctx), 'GET', '/api/figures')
    expect(JSON.parse(listed.body.toString())).toEqual({ frames: [{ id: FRAME, decks: [deck.id], hasImage: false }] })
  })

  it('tells the decks that use a frame when its image changes, but not when it is the same', async () => {
    const ctx = await setup()
    const deck = await ctx.files.create('slides', 'deck', `# 図 {#s-aaaaaa}\n| a | b |\n![図](canvas:${FRAME})\n`, { extension: '.slide.md' })
    const handler = figuresHandler(ctx)
    const before = (await settledPages(ctx.api, deck.id))[0]?.hash
    ctx.announced.length = 0
    await request(handler, 'PUT', `/api/figures/${FRAME}.png`, { png: PNG_A })
    expect(ctx.announced).toEqual([deck.id])
    const drawn = (await settledPages(ctx.api, deck.id))[0]?.hash
    expect(drawn).not.toBe(before)
    ctx.announced.length = 0
    await request(handler, 'PUT', `/api/figures/${FRAME}.png`, { png: PNG_A })
    expect(ctx.announced).toEqual([])
    await request(handler, 'PUT', `/api/figures/${FRAME}.png`, { png: PNG_B })
    expect((await settledPages(ctx.api, deck.id))[0]?.hash).not.toBe(drawn)
  })
})

describe('SlidesApi canvas figures', () => {
  it('serves the frame image or a placeholder through the deck asset endpoint', async () => {
    const ctx = await setup()
    const deck = await ctx.files.create('slides', 'deck', '# タイトル\n', { extension: '.slide.md' })
    const asset = (path: string) => request(slidesHandler(ctx.api), 'GET', `/api/slides/${encodeURIComponent(deck.id)}/asset?path=${encodeURIComponent(path)}`)
    const missing = await asset(`canvas:${FRAME}`)
    expect(missing.status).toBe(200)
    expect(missing.type).toBe('image/svg+xml')
    expect(missing.body.toString()).toContain('まだありません')
    const gone = await asset('canvas:node:Gone0123456789abc')
    expect(gone.body.toString()).toContain('見つかりません')
    await ctx.figures.save(FRAME, PNG_A)
    const drawn = await asset(`canvas:${FRAME}`)
    expect(drawn.type).toBe('image/png')
    expect(drawn.body.equals(PNG_A)).toBe(true)
  })

  it('warns about missing frames and malformed canvas paths', async () => {
    const ctx = await setup()
    const deck = await ctx.files.create('slides', 'deck', `# A {#s-aaaaaa}\n| a | b |\n![図](canvas:node:Gone0123456789abc)\n\n# B {#s-bbbbbb}\n| a | b |\n![図](canvas:oops)\n`, { extension: '.slide.md' })
    const { warnings } = await ctx.api.inspectDeck(deck.id)
    expect(warnings).toEqual([
      's-aaaaaa: 図のフレームが見つかりません（node:Gone0123456789abc）',
      's-bbbbbb: キャンバスの図のパスが不正です（canvas:oops。canvas:node:… の形で書きます）',
    ])
  })

  it('puts a frame into a table slide, turning it into table-image', async () => {
    const ctx = await setup()
    const deck = await ctx.files.create('slides', 'deck', '# 表 {#s-aaaaaa}\n\n| a | b |\n', { extension: '.slide.md' })
    const response = await request(slidesHandler(ctx.api), 'POST', `/api/slides/${encodeURIComponent(deck.id)}/figure`, {
      json: { slideKey: 's-aaaaaa', slot: 'image', frameId: FRAME, alt: '構成図' },
    })
    expect(response.status).toBe(200)
    expect(readFileSync(join(ctx.workspace, 'deck.slide.md'), 'utf8')).toBe(`# 表 {#s-aaaaaa}\n\n| a | b |\n\n![構成図](canvas:${FRAME})\n`)
  })

  it('asks before replacing code, and fills the chosen slot of a two-figure slide', async () => {
    const ctx = await setup()
    const text = '# コード {#s-aaaaaa}\n\n| a | b |\n\n```py\nprint(1)\n```\n\n# 2 図 {#s-bbbbbb}\n\n| a | b |\n\n![左](assets/l.png "左")\n![右](assets/r.png "右")\n'
    const deck = await ctx.files.create('slides', 'deck', text, { extension: '.slide.md' })
    const post = (json: unknown) => request(slidesHandler(ctx.api), 'POST', `/api/slides/${encodeURIComponent(deck.id)}/figure`, { json })
    const asked = await post({ slideKey: 's-aaaaaa', slot: 'image', frameId: FRAME })
    expect(asked.status).toBe(409)
    expect(JSON.parse(asked.body.toString()).reason).toBe('has-code')
    expect((await post({ slideKey: 's-aaaaaa', slot: 'image', frameId: FRAME, replaceCode: true })).status).toBe(200)
    expect((await post({ slideKey: 's-bbbbbb', slot: 'images.1', frameId: FRAME })).status).toBe(200)
    expect((await post({ slideKey: 's-bbbbbb', slot: 'image', frameId: FRAME })).status).toBe(400)
    expect((await post({ slideKey: 's-nothing', slot: 'image', frameId: FRAME })).status).toBe(404)
    const saved = readFileSync(join(ctx.workspace, 'deck.slide.md'), 'utf8')
    expect(saved).not.toContain('print(1)')
    expect(saved).toContain(`![キャンバスの図](canvas:${FRAME})`)
    expect(saved).toContain('![左](assets/l.png "左")')
    expect(saved).toContain(`![右](canvas:${FRAME} "右")`)
  })
})
