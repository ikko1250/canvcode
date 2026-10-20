import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'

// ビルドした画面のファイルを、圧縮して配る。画面のコードは 2MB ほどあり、圧縮しないと遅い回線・端末（Tailscale 越しの iPad など）で
// 読み込みに 2 秒かかっていた（brotli なら 4 分の 1 ほどになる）。dist のファイルは書き換わらないので、圧縮した結果は
// ファイルの更新時刻ごとに覚えておき、2 回目からは圧縮しない

export type Encoding = 'br' | 'gzip'

// 圧縮して効く種類（woff2・png などは、もともと圧縮されている）
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.map', '.wasm', '.bcmap', '.pfb', '.ttf'])
// これより小さいファイルは、圧縮しても得がない
const MIN_BYTES = 1024
// 覚えておく量の上限（超えたら古いものから捨てる）
const CACHE_LIMIT_BYTES = 64 * 1024 * 1024

const brotli = promisify(brotliCompress)
const gzipAsync = promisify(gzip)

// Accept-Encoding から、使う圧縮の方法（brotli を優先）。q=0 は使えないものとして扱う
export function pickEncoding(acceptEncoding: string | string[] | undefined): Encoding | null {
  const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : (acceptEncoding ?? '')
  const accepted = new Set<string>()
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
    if (name && !(q && Number(q.slice(2)) === 0)) accepted.add(name)
  }
  if (accepted.has('br')) return 'br'
  if (accepted.has('gzip')) return 'gzip'
  return null
}

export function isCompressible(path: string, size: number): boolean {
  return size >= MIN_BYTES && COMPRESSIBLE.has(extname(path).toLowerCase())
}

interface Cached {
  mtimeMs: number
  data: Buffer
}

export class CompressedFiles {
  private readonly cache = new Map<string, Cached>()
  private bytes = 0
  private readonly pending = new Map<string, Promise<Buffer>>()

  // path を encoding で圧縮した中身（mtimeMs が変わっていれば作り直す）
  async get(path: string, mtimeMs: number, encoding: Encoding): Promise<Buffer> {
    const key = `${encoding}:${path}`
    const cached = this.cache.get(key)
    if (cached && cached.mtimeMs === mtimeMs) {
      // 最近使ったものとして、後ろに付け直す
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached.data
    }
    const pendingKey = `${key}@${mtimeMs}`
    let pending = this.pending.get(pendingKey)
    if (!pending) {
      pending = (async () => {
        const raw = await readFile(path)
        const data =
          encoding === 'br'
            ? await brotli(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
            : await gzipAsync(raw, { level: 9 })
        this.store(key, { mtimeMs, data })
        return data
      })().finally(() => this.pending.delete(pendingKey))
      this.pending.set(pendingKey, pending)
    }
    return pending
  }

  // dir の下の圧縮して効くファイルを、前もって brotli で圧縮しておく（起動したときに裏で。最初に開いた人を待たせないため）。
  // 1 つずつ順に行い、終えた数を返す
  async warm(dir: string): Promise<number> {
    let count = 0
    const walk = async (current: string): Promise<void> => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const path = join(current, entry.name)
        if (entry.isDirectory()) {
          await walk(path)
        } else if (entry.isFile()) {
          const info = await stat(path)
          if (!isCompressible(path, info.size)) continue
          await this.get(path, info.mtimeMs, 'br')
          count++
        }
      }
    }
    await walk(dir)
    return count
  }

  private store(key: string, entry: Cached): void {
    const old = this.cache.get(key)
    if (old) this.bytes -= old.data.length
    this.cache.delete(key)
    this.cache.set(key, entry)
    this.bytes += entry.data.length
    for (const [k, v] of this.cache) {
      if (this.bytes <= CACHE_LIMIT_BYTES) break
      this.cache.delete(k)
      this.bytes -= v.data.length
    }
  }
}
