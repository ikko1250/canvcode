import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { RecordStore } from './records.ts'
import { RenderBroker, RenderError, type RenderRequest } from './renders.ts'
import { SyncHub } from './sync.ts'

// Canvas を画像にする：サーバーが開いているタブに頼み、PNG を受け取る（MAI-89。docs/canvas-image-plan.md の 4.3）

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(options: ConstructorParameters<typeof RenderBroker>[1] = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-renders-'))
  const records = new RecordStore(dir)
  const hub = new SyncHub(records)
  const broker = new RenderBroker(hub, options)
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    void broker.handle(req, res, path).then((handled) => {
      if (handled || hub.handle(req, res, path)) return
      res.writeHead(404)
      res.end()
    })
  })
  server.on('upgrade', (req, socket, head) => hub.server.handleUpgrade(req, socket, head, (ws) => hub.server.emit('connection', ws, req)))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `127.0.0.1:${(server.address() as AddressInfo).port}`
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.push(() => records.close())
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  cleanups.push(() => broker.dispose())
  cleanups.push(() => {
    for (const client of hub.server.clients) client.terminate()
  })
  return { records, hub, broker, base }
}

// タブ。hello（と presence）を送り、届いた render を順に受け取る
async function tab(base: string, options: { features?: string[]; canvases?: string[]; viewing?: string; visible?: boolean } = {}) {
  const socket = new WebSocket(`ws://${base}/api/sync`)
  const renders: Record<string, any>[] = []
  const waiters: (() => void)[] = []
  socket.on('message', (data) => {
    const message = JSON.parse(String(data))
    if (message.type !== 'render') return
    renders.push(message)
    for (const waiter of waiters.splice(0)) waiter()
  })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  socket.send(JSON.stringify({ type: 'hello', since: 0, canvases: options.canvases ?? [], ...(options.features ? { features: options.features } : { features: ['render'] }) }))
  if (options.viewing) {
    socket.send(JSON.stringify({ type: 'presence', canvasId: options.viewing, viewport: { x: 0, y: 0, w: 100, h: 100 }, visible: options.visible ?? true }))
  }
  return {
    socket,
    renders,
    async nextRender(): Promise<Record<string, any>> {
      if (renders.length > 0) return renders.shift()!
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for render')), 2000)
        waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
      return renders.shift()!
    },
    close: () => new Promise<void>((resolve) => {
      socket.once('close', () => resolve())
      socket.close()
    }),
  }
}

// IHDR までの、幅と高さだけを持つ PNG（サーバーは署名と IHDR しか読まない）
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'ascii')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return header
}

const answer = (base: string, attempt: string, body: Buffer | object, query = 'x=0&y=0&w=200&h=100&scale=2&rev=3') =>
  fetch(`http://${base}/api/renders/${encodeURIComponent(attempt)}?${query}`, {
    method: 'PUT',
    headers: { 'content-type': Buffer.isBuffer(body) ? 'image/png' : 'application/json' },
    body: Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body),
  })

const answer2 = (base: string, attempt: string) => answer(base, attempt, png(10, 10))

const request = (fields: Partial<RenderRequest> = {}): RenderRequest => ({ canvasId: 'canvas:a', target: { kind: 'canvas' }, maxEdge: 1568, rev: 3, ...fields })

// 届くのを待つ（WebSocket の hello・presence がサーバーで処理されるまで）
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe('RenderBroker', () => {
  it('asks the tab viewing the canvas, and resolves with the PNG and what the tab drew', async () => {
    const { broker, base } = await setup()
    const other = await tab(base, { canvases: ['canvas:b'], viewing: 'canvas:b' })
    const viewing = await tab(base, { canvases: ['canvas:a'], viewing: 'canvas:a' })
    await settle()
    expect(broker.hasTabs()).toBe(true)
    const result = broker.request(request({ target: { kind: 'slide', id: 'node:s' } }))
    const message = await viewing.nextRender()
    expect(message).toMatchObject({ type: 'render', canvasId: 'canvas:a', rev: 3, target: { kind: 'slide', id: 'node:s' }, maxEdge: 1568 })
    // id は推測されにくい 128 ビットの乱数
    expect(message.attempt).toMatch(/^[A-Za-z0-9_-]{22}$/)
    const response = await answer(base, message.attempt, png(1568, 882), 'x=0&y=0&w=1920&h=1080&scale=0.8167&rev=4&capped=1&incomplete=pdf,card&missing=node:x')
    expect(response.status).toBe(201)
    expect(await result).toMatchObject({
      width: 1568,
      height: 882,
      box: { x: 0, y: 0, w: 1920, h: 1080 },
      scale: 0.8167,
      rev: 4,
      capped: true,
      empty: false,
      incomplete: ['pdf', 'card'],
      missing: ['node:x'],
    })
    // 答えたら消す（遅れて届いた 2 回目は 404）
    expect((await answer(base, message.attempt, png(10, 10))).status).toBe(404)
    expect(other.renders).toHaveLength(0)
  })

  it('orders tabs: viewing, then loaded, then any, with hidden tabs last; skips tabs that cannot render', async () => {
    const { broker, base } = await setup({ attemptTimeoutMs: 5000 })
    const old = await tab(base, { features: [], canvases: ['canvas:a'], viewing: 'canvas:a' })
    const hidden = await tab(base, { canvases: ['canvas:a'], viewing: 'canvas:a', visible: false })
    const any = await tab(base, { canvases: [] })
    const loaded = await tab(base, { canvases: ['canvas:a'], viewing: 'canvas:b' })
    await settle()
    const result = broker.request(request())
    // 見えていて、その Canvas を読んだタブ → 見えている、そのほかのタブ → 裏のタブ。描けないタブ（古いタブ）には頼まない
    const order: string[] = []
    for (const [name, t] of [['loaded', loaded], ['any', any], ['hidden', hidden]] as const) {
      const message = await t.nextRender()
      order.push(name)
      if (name !== 'hidden') await answer(base, message.attempt, { error: 'could not load the canvas', retry: true })
      else await answer(base, message.attempt, png(100, 50))
    }
    expect(order).toEqual(['loaded', 'any', 'hidden'])
    expect((await result).width).toBe(100)
    expect(old.renders).toHaveLength(0)
  })

  it('asks the next tab when a tab does not answer in time or closes', async () => {
    const { broker, base } = await setup({ attemptTimeoutMs: 200 })
    const slow = await tab(base, { canvases: ['canvas:a'], viewing: 'canvas:a' })
    const closing = await tab(base, { canvases: ['canvas:a'] })
    const last = await tab(base, {})
    await settle()
    const result = broker.request(request())
    const first = await slow.nextRender()
    // 打ち切った頼みに遅れて答えても 404
    await closing.nextRender()
    expect((await answer(base, first.attempt, png(10, 10))).status).toBe(404)
    await closing.close()
    const message = await last.nextRender()
    await answer(base, message.attempt, png(10, 10))
    expect((await result).width).toBe(10)
  })

  it('does not ask again when the tab says no tab would do better', async () => {
    const { broker, base } = await setup()
    const first = await tab(base, { canvases: ['canvas:a'], viewing: 'canvas:a' })
    const second = await tab(base, {})
    await settle()
    // 答えたときに断られるので、先に受け取っておく
    const result = broker.request(request()).catch((e: unknown) => e)
    await answer(base, (await first.nextRender()).attempt, { error: 'the rect is empty', retry: false })
    expect(await result).toMatchObject({ code: 'failed', message: 'the rect is empty' })
    expect(second.renders).toHaveLength(0)
  })

  it('refuses invalid answers and asks the next tab', async () => {
    const { broker, base } = await setup()
    const tabs = await Promise.all([0, 1, 2, 3].map(() => tab(base, {})))
    await settle()
    const result = broker.request(request({ maxEdge: 100 })).catch((e: unknown) => e)
    const next = async () => {
      for (;;) {
        const found = tabs.find((t) => t.renders.length > 0)
        if (found) return found.renders.shift()!
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    // PNG でない・頼んだより大きい・範囲がない・型が違う
    expect((await answer(base, (await next()).attempt, Buffer.from('not a png'))).status).toBe(400)
    expect((await answer(base, (await next()).attempt, png(400, 100))).status).toBe(400)
    expect((await answer(base, (await next()).attempt, png(100, 50), 'x=0&y=0&w=0&h=1&scale=1&rev=0')).status).toBe(400)
    const attempt = (await next()).attempt
    const text = await fetch(`http://${base}/api/renders/${attempt}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'hello' })
    expect(text.status).toBe(415)
    const error = await result
    expect(error).toBeInstanceOf(RenderError)
    expect(error).toMatchObject({ code: 'failed' })
    expect((error as Error).message).toContain('asked 4 tabs')
  })

  it('fails right away without a tab that can render, and when too many are pending', async () => {
    const { broker, base } = await setup({ maxPending: 1 })
    await expect(broker.request(request())).rejects.toMatchObject({ code: 'no-tab' })
    await tab(base, { features: [] })
    await settle()
    expect(broker.hasTabs()).toBe(false)
    await expect(broker.request(request())).rejects.toMatchObject({ code: 'no-tab' })
    const t = await tab(base, {})
    await settle()
    const pending = broker.request(request())
    await expect(broker.request(request())).rejects.toMatchObject({ code: 'busy' })
    await answer(base, (await t.nextRender()).attempt, png(10, 10))
    await pending
  })

  // レビュー：答えを読み始めると 1 回の打ち切りを止めるので、本文を送り始めて止まるタブがいると、全体の期限も効かずに返らなかった
  it('ends within the total time even when a tab starts sending its answer and stalls, and closes that answer', async () => {
    const { broker, base } = await setup({ attemptTimeoutMs: 5000, totalTimeoutMs: 300 })
    const stalling = await tab(base, {})
    await settle()
    const started = Date.now()
    const result = broker.request(request()).catch((e: unknown) => e)
    const { attempt } = await stalling.nextRender()
    // PNG の頭だけを送って止まる（content-length はもっと大きい）
    const [host, port] = base.split(':')
    const answer = httpRequest({ host, port: Number(port), method: 'PUT', path: `/api/renders/${attempt}?x=0&y=0&w=10&h=10&scale=1&rev=3`, headers: { 'content-type': 'image/png', 'content-length': '100000' } })
    const closed = new Promise<string>((resolve) => {
      answer.on('error', (error) => resolve(`error ${(error as NodeJS.ErrnoException).code}`))
      answer.on('response', (response) => resolve(`response ${response.statusCode}`))
    })
    answer.write(png(10, 10))
    const error = await result
    expect(error).toMatchObject({ code: 'timeout' })
    expect((error as Error).message).toContain('timed out after 0 s')
    // 全体の期限（300 ms）のうちに終わる（1 回の打ち切りの 5 秒は待たない）
    expect(Date.now() - started).toBeLessThan(1500)
    // 読みかけの答えは捨てて、その接続を閉じる
    expect(await closed).toMatch(/^error (ECONNRESET|EPIPE)$|^response 410$/)
    // 期限を過ぎた頼みに答えても 404
    expect((await answer2(base, attempt)).status).toBe(404)
  })

  it('gives up after the total time', async () => {
    const { broker, base } = await setup({ attemptTimeoutMs: 100, totalTimeoutMs: 150 })
    const tabs = await Promise.all([0, 1, 2].map(() => tab(base, {})))
    await settle()
    const error = await broker.request(request()).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'timeout' })
    // 打ち切りまでに頼めたのは 2 つ（100 ms と、残りの 50 ms）
    expect(tabs.reduce((n, t) => n + t.renders.length, 0)).toBe(2)
  })
})
