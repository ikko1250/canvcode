import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

// Canvas のサムネイル（MAI-8 の「4. 親の Canvas 上でのプレビュー」、MAI-10、MAI-13）。
// ブラウザが Canvas を離れるときに描いた PNG を、.canvcode/thumbnails/<Canvas の id>.png に置く。
// PDF のページの Canvas は、取り込むときに 1 ページ目を描いたもの

const ID_PATTERN = /^canvas:[A-Za-z0-9_-]{1,120}$/
const MAX_BYTES = 8 * 1024 * 1024

export class ThumbnailStore {
  private readonly dir: string

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'thumbnails')
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  // 保存する（旧データの取り込みから使う）
  async save(canvasId: string, png: Buffer): Promise<void> {
    if (!ID_PATTERN.test(canvasId)) return
    const file = join(this.dir, `${canvasId.replace(':', '_')}.png`)
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, png)
    await rename(temp, file)
  }

  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const match = /^\/api\/thumbnails\/([^/]+)$/.exec(path)
    if (!match) return false
    let id: string
    try {
      id = decodeURIComponent(match[1])
    } catch {
      id = ''
    }
    if (!ID_PATTERN.test(id)) {
      send(res, 404, 'not found')
      return true
    }
    const file = join(this.dir, `${id.replace(':', '_')}.png`)
    if (req.method === 'GET') {
      try {
        const data = await readFile(file)
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': data.length, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' })
        res.end(data)
      } catch {
        // まだないのはふつうのこと（ブラウザのコンソールに 404 を出させないよう、中身なしで返す）
        res.writeHead(204, { 'cache-control': 'no-cache' })
        res.end()
      }
      return true
    }
    if (req.method === 'PUT') {
      if ((req.headers['content-type'] ?? '') !== 'image/png') {
        send(res, 415, 'png only')
        return true
      }
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of req) {
        total += (chunk as Buffer).length
        if (total > MAX_BYTES) {
          send(res, 413, 'too large')
          return true
        }
        chunks.push(chunk as Buffer)
      }
      const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
      await writeFile(temp, Buffer.concat(chunks))
      await rename(temp, file)
      send(res, 200, 'ok')
      return true
    }
    if (req.method === 'DELETE') {
      await rm(file, { force: true })
      send(res, 200, 'ok')
      return true
    }
    send(res, 405, 'method not allowed')
    return true
  }
}

function send(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(status === 200 ? { ok: true } : { error: message }))
}
