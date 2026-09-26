import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { isFrameId } from '@canvcode/slides'

// スライドの図にするキャンバスのフレームの画像（提案 B）。
// デッキの画像のパスに canvas:<フレームの id> と書くと、ブラウザがそのフレームを描いた PNG を
// .canvcode/figures/<id>.png に置き、スライドの画像（キャンバスの並び・出力・AI の確認）に使う。
// サーバーではキャンバスを描かない（描くのはブラウザ。Canvas を開いたときと、フレームの中が変わったとき）

const MAX_BYTES = 8 * 1024 * 1024

export interface FigureReference {
  // フレームの id
  id: string
  // このフレームを図に使っているデッキ（File の id）
  decks: string[]
}

export interface FigureHooks {
  // デッキから参照されているフレームの一覧
  references(): Promise<FigureReference[]>
  // 画像が変わった（参照しているデッキのスライドの画像を作り直す）
  changed(frameId: string): Promise<void>
}

export class FigureStore {
  private readonly dir: string

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'figures')
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  // フレームの画像（まだ無ければ null）
  async read(frameId: string): Promise<Buffer | null> {
    if (!isFrameId(frameId)) return null
    return readFile(this.pathOf(frameId)).catch(() => null)
  }

  async has(frameId: string): Promise<boolean> {
    if (!isFrameId(frameId)) return false
    return stat(this.pathOf(frameId)).then((s) => s.isFile(), () => false)
  }

  async save(frameId: string, png: Buffer): Promise<void> {
    if (!isFrameId(frameId)) throw new Error(`invalid frame id: ${frameId}`)
    await mkdir(this.dir, { recursive: true })
    const file = this.pathOf(frameId)
    const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    await writeFile(temp, png)
    await rename(temp, file)
  }

  // GET /api/figures：参照されているフレームと、画像があるか
  // GET・PUT・DELETE /api/figures/<フレームの id>.png
  async handle(req: IncomingMessage, res: ServerResponse, path: string, hooks: FigureHooks): Promise<boolean> {
    if (path === '/api/figures') {
      if (req.method !== 'GET') {
        send(res, 405, { error: 'method not allowed' })
        return true
      }
      const frames = await Promise.all((await hooks.references()).map(async (ref) => ({ ...ref, hasImage: await this.has(ref.id) })))
      send(res, 200, { frames })
      return true
    }
    const match = /^\/api\/figures\/([^/]+)\.png$/.exec(path)
    if (!match) return false
    let id: string
    try {
      id = decodeURIComponent(match[1] ?? '')
    } catch {
      id = ''
    }
    if (!isFrameId(id)) {
      send(res, 404, { error: 'not found' })
      return true
    }
    if (req.method === 'GET') {
      const data = await this.read(id)
      if (!data) {
        send(res, 404, { error: 'not found' })
        return true
      }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': data.length, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' })
      res.end(data)
      return true
    }
    if (req.method === 'PUT') {
      if ((req.headers['content-type'] ?? '') !== 'image/png') {
        send(res, 415, { error: 'png only' })
        return true
      }
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of req) {
        total += (chunk as Buffer).length
        if (total > MAX_BYTES) {
          send(res, 413, { error: 'too large' })
          return true
        }
        chunks.push(chunk as Buffer)
      }
      const png = Buffer.concat(chunks)
      // 同じ画像なら、スライドの画像を作り直させない（Canvas を開くたびに描き直して送ってくるので）
      const previous = await this.read(id)
      if (!previous || !previous.equals(png)) {
        await this.save(id, png)
        await hooks.changed(id)
      }
      send(res, 200, { ok: true })
      return true
    }
    if (req.method === 'DELETE') {
      await rm(this.pathOf(id), { force: true })
      await hooks.changed(id)
      send(res, 200, { ok: true })
      return true
    }
    send(res, 405, { error: 'method not allowed' })
    return true
  }

  private pathOf(frameId: string): string {
    return join(this.dir, `${frameId.replace(':', '_')}.png`)
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
