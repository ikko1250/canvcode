import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

// 画像の Asset の保存と配信（MAI-10、MAI-13、MAI-26）。
// - 実体は <ワークスペース>/.canvcode/assets/<ハッシュ>.<拡張子> に置く。名前が中身の SHA-256 なので、
//   同じファイルを 2 回受け取っても 1 つにまとまり、中身が変わることもない（ブラウザに長くキャッシュさせる）
// - 縮小版（長辺 256px・1024px）はブラウザが作って送ってくる（MAI-14）。<ハッシュ>.<長辺>.<拡張子> に置く
// - 種類や縮小版の一覧は <ハッシュ>.json に書いておく。段階 11 で Asset のレコードを SQLite に入れたら、そちらに移す

const ORIGINAL_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
}
const VARIANT_TYPES: Record<string, string> = { 'image/webp': 'webp', 'image/png': 'png' }
const VARIANT_SIZES = new Set([256, 1024])
const MAX_ORIGINAL_BYTES = 100 * 1024 * 1024
const MAX_VARIANT_BYTES = 10 * 1024 * 1024
const HASH_PATTERN = /^[0-9a-f]{64}$/

interface AssetMeta {
  mime: string
  size: number
  // 長辺 → 縮小版の種類
  variants: Record<string, string>
}

export class AssetStore {
  private readonly dir: string

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'assets')
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  // /api/assets 以下を扱う。扱わないパスなら false を返す
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const parts = path.split('/').filter(Boolean)
    if (parts[0] !== 'api' || parts[1] !== 'assets') return false
    const [, , hash, size] = parts
    try {
      if (req.method === 'POST' && parts.length === 2) {
        await this.receiveOriginal(req, res)
      } else if (req.method === 'PUT' && parts.length === 4) {
        await this.receiveVariant(req, res, hash, Number(size))
      } else if ((req.method === 'GET' || req.method === 'HEAD') && (parts.length === 3 || parts.length === 4)) {
        await this.send(req, res, hash, size === undefined ? null : Number(size))
      } else {
        sendJson(res, 405, { error: 'method not allowed' })
      }
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message })
      } else {
        console.error('asset request failed', error)
        sendJson(res, 500, { error: 'internal error' })
      }
    }
    return true
  }

  private async receiveOriginal(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const mime = contentType(req)
    const ext = ORIGINAL_TYPES[mime]
    if (!ext) throw new HttpError(415, `unsupported type: ${mime}`)
    const body = await readBody(req, MAX_ORIGINAL_BYTES)
    const hash = createHash('sha256').update(body).digest('hex')
    // ブラウザが計算したハッシュと違えば、途中で壊れている
    const claimed = req.headers['x-canvcode-sha256']
    if (typeof claimed === 'string' && claimed !== hash) throw new HttpError(400, 'hash mismatch')
    if (!(await this.readMeta(hash))) {
      await writeAtomic(join(this.dir, `${hash}.${ext}`), body)
      await this.writeMeta(hash, { mime, size: body.length, variants: {} })
    }
    sendJson(res, 200, { hash, mime, size: body.length })
  }

  private async receiveVariant(req: IncomingMessage, res: ServerResponse, hash: string, size: number): Promise<void> {
    if (!HASH_PATTERN.test(hash) || !VARIANT_SIZES.has(size)) throw new HttpError(404, 'not found')
    const meta = await this.readMeta(hash)
    if (!meta) throw new HttpError(404, 'original not found')
    const ext = VARIANT_TYPES[contentType(req)]
    if (!ext) throw new HttpError(415, 'variant must be webp or png')
    const body = await readBody(req, MAX_VARIANT_BYTES)
    await writeAtomic(join(this.dir, `${hash}.${size}.${ext}`), body)
    await this.writeMeta(hash, { ...meta, variants: { ...meta.variants, [size]: ext } })
    sendJson(res, 200, { hash, size })
  }

  private async send(req: IncomingMessage, res: ServerResponse, hash: string, size: number | null): Promise<void> {
    if (!HASH_PATTERN.test(hash) || (size !== null && !VARIANT_SIZES.has(size))) throw new HttpError(404, 'not found')
    const meta = await this.readMeta(hash)
    if (!meta) throw new HttpError(404, 'not found')
    let file: string
    let mime: string
    if (size === null) {
      file = `${hash}.${ORIGINAL_TYPES[meta.mime]}`
      mime = meta.mime
    } else {
      const ext = meta.variants[size]
      if (!ext) throw new HttpError(404, 'variant not found')
      file = `${hash}.${size}.${ext}`
      mime = `image/${ext}`
    }
    const path = join(this.dir, file)
    const info = await stat(path).catch(() => null)
    if (!info) throw new HttpError(404, 'not found')
    res.writeHead(200, {
      'content-type': mime,
      'content-length': info.size,
      // 名前が中身のハッシュなので、中身は変わらない
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(path).pipe(res)
  }

  private async readMeta(hash: string): Promise<AssetMeta | null> {
    try {
      return JSON.parse(await readFile(join(this.dir, `${hash}.json`), 'utf8')) as AssetMeta
    } catch {
      return null
    }
  }

  private async writeMeta(hash: string, meta: AssetMeta): Promise<void> {
    await writeAtomic(join(this.dir, `${hash}.json`), Buffer.from(JSON.stringify(meta)))
  }
}

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function contentType(req: IncomingMessage): string {
  return (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > limit) throw new HttpError(413, 'too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

// 一時ファイルに書いてから名前を変える（書きかけのファイルが残らない。MAI-13）
async function writeAtomic(path: string, data: Buffer): Promise<void> {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, data)
  await rename(temp, path)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
