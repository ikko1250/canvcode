import { createWriteStream } from 'node:fs'
import { mkdir, utimes } from 'node:fs/promises'
import { dirname, posix, resolve, sep } from 'node:path'
import { once } from 'node:events'

// ワークスペースのバックアップ（backup.ts）に使う tar の読み書き。外のコマンドに頼らず、tar（POSIX ustar + pax）を書く。
// - 100 バイトを超える名前や ASCII 以外の名前（日本語のファイル名）は、pax の拡張ヘッダー（path=）に書く。
//   GNU tar・bsdtar でもそのまま展開できる
// - 読むのは、ここで書いたもの（通常のファイル・フォルダ・pax・GNU の長い名前）だけ。リンクなどは断る
// - 展開先の外を指す名前（絶対パス・..）は断る

const BLOCK = 512
// ustar の size 欄（8 進 11 桁）に書ける上限
const MAX_USTAR_SIZE = 8 ** 11 - 1

export interface TarEntry {
  // 区切りは /（先頭に / を付けない）
  path: string
  data: Buffer
  // ミリ秒
  mtime: number
  mode?: number
}

// エントリーを順に tar のバイト列にする（最後に終わりの印の 0 のブロックを 2 つ付ける）
export async function* tarChunks(entries: AsyncIterable<TarEntry> | Iterable<TarEntry>): AsyncGenerator<Buffer> {
  for await (const entry of entries) {
    const path = safePath(entry.path)
    const pax: Record<string, string> = {}
    const ascii = /^[\x20-\x7e]*$/.test(path)
    if (!ascii || Buffer.byteLength(path) > 100) pax.path = path
    if (entry.data.length > MAX_USTAR_SIZE) pax.size = String(entry.data.length)
    if (Object.keys(pax).length > 0) {
      const body = paxBody(pax)
      yield header({ name: 'PaxHeader', size: body.length, mtime: entry.mtime, mode: 0o644, type: 'x' })
      yield body
      yield padding(body.length)
    }
    const name = pax.path ? asciiFallback(path) : path
    yield header({ name, size: pax.size ? 0 : entry.data.length, mtime: entry.mtime, mode: entry.mode ?? 0o644, type: '0' })
    yield entry.data
    yield padding(entry.data.length)
  }
  yield Buffer.alloc(BLOCK * 2)
}

// tar を dest に展開し、展開したファイルの（dest からの）パスを返す
export async function extractTar(source: AsyncIterable<Buffer>, dest: string): Promise<string[]> {
  const root = resolve(dest)
  const reader = new ByteReader(source)
  const written: string[] = []
  let nextPath: string | null = null
  let nextSize: number | null = null
  for (;;) {
    const block = await reader.read(BLOCK)
    if (!block) throw new Error('tar: 終わりの印がありません（途中で切れています）')
    if (block.every((b) => b === 0)) break
    verifyChecksum(block)
    const type = String.fromCharCode(block[156] || 0x30)
    let size = readOctal(block, 124, 12)
    if (nextSize !== null && (type === '0' || type === '5')) size = nextSize
    if (type === 'x' || type === 'g' || type === 'L') {
      const body = await reader.read(size)
      if (!body) throw new Error('tar: 途中で切れています')
      await reader.skip(padSize(size))
      if (type === 'x') {
        const records = parsePax(body)
        if (records.path !== undefined) nextPath = records.path
        if (records.size !== undefined) nextSize = Number(records.size)
      } else if (type === 'L') {
        nextPath = body.toString('utf8').replace(/\0+$/, '')
      }
      continue
    }
    const name = nextPath ?? ustarName(block)
    nextPath = null
    nextSize = null
    const rel = safePath(name.replace(/\/+$/, ''))
    const target = resolve(root, ...rel.split('/'))
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`tar: 展開先の外を指しています: ${name}`)
    if (type === '5') {
      await mkdir(target, { recursive: true })
      await reader.skip(size + padSize(size))
      continue
    }
    if (type !== '0') throw new Error(`tar: この種類のエントリーは扱えません（${type}）: ${name}`)
    await mkdir(dirname(target), { recursive: true })
    const out = createWriteStream(target, { flags: 'wx' })
    try {
      for await (const piece of reader.pieces(size)) {
        if (!out.write(piece)) await once(out, 'drain')
      }
    } finally {
      out.end()
      await once(out, 'close')
    }
    await reader.skip(padSize(size))
    // 更新日時も戻す（秒単位）
    const mtime = readOctal(block, 136, 12)
    if (mtime > 0) await utimes(target, mtime, mtime)
    written.push(rel)
  }
  return written
}

// 展開してよい相対パスか確かめ、正規化したものを返す
function safePath(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, '/'))
  if (!normalized || normalized === '.' || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`tar: 使えない名前です: ${path}`)
  }
  return normalized
}

function header(h: { name: string; size: number; mtime: number; mode: number; type: string }): Buffer {
  const block = Buffer.alloc(BLOCK)
  block.write(h.name.slice(0, 100), 0, 100, 'ascii')
  writeOctal(block, 100, 8, h.mode)
  writeOctal(block, 108, 8, 0)
  writeOctal(block, 116, 8, 0)
  writeOctal(block, 124, 12, h.size)
  writeOctal(block, 136, 12, Math.max(0, Math.floor(h.mtime / 1000)))
  block.fill(0x20, 148, 156)
  block.write(h.type, 156, 1, 'ascii')
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const b of block) sum += b
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return block
}

function verifyChecksum(block: Buffer): void {
  const stored = readOctal(block, 148, 8)
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]
  if (sum !== stored) throw new Error('tar: ヘッダーが壊れています（チェックサムが合いません）')
}

function writeOctal(block: Buffer, offset: number, length: number, value: number): void {
  block.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii')
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const text = block.toString('ascii', offset, offset + length).replace(/[\0 ]+$/, '').trim()
  return text ? parseInt(text, 8) : 0
}

function ustarName(block: Buffer): string {
  const field = (offset: number, length: number) => {
    const raw = block.subarray(offset, offset + length)
    const end = raw.indexOf(0)
    return raw.subarray(0, end < 0 ? length : end).toString('utf8')
  }
  const name = field(0, 100)
  const prefix = block.toString('ascii', 257, 262) === 'ustar' ? field(345, 155) : ''
  return prefix ? `${prefix}/${name}` : name
}

// pax のレコード（「<長さ> <キー>=<値>\n」。長さは自分自身の桁も含む）
function paxBody(records: Record<string, string>): Buffer {
  const parts = Object.entries(records).map(([key, value]) => {
    const rest = ` ${key}=${value}\n`
    let length = Buffer.byteLength(rest) + 1
    while (String(length).length + Buffer.byteLength(rest) !== length) length = String(length).length + Buffer.byteLength(rest)
    return `${length}${rest}`
  })
  return Buffer.from(parts.join(''), 'utf8')
}

function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let at = 0
  while (at < body.length) {
    const space = body.indexOf(0x20, at)
    if (space < 0) break
    const length = Number(body.toString('ascii', at, space))
    if (!(length > 0)) break
    const record = body.toString('utf8', space + 1, at + length - 1)
    const eq = record.indexOf('=')
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1)
    at += length
  }
  return out
}

// pax に本当の名前を書いたときの、ustar の name 欄に入れる名前（pax を読まない tar 向けの目印）
function asciiFallback(path: string): string {
  const ascii = path.replace(/[^\x20-\x7e]/g, '_')
  return ascii.length <= 100 ? ascii : ascii.slice(-100)
}

function padSize(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK
}

function padding(size: number): Buffer {
  return Buffer.alloc(padSize(size))
}

// 流れてくるバイト列から、決まった長さずつ読む
class ByteReader {
  private buffer: Buffer = Buffer.alloc(0)
  private readonly iterator: AsyncIterator<Buffer>
  private done = false

  constructor(source: AsyncIterable<Buffer>) {
    this.iterator = source[Symbol.asyncIterator]()
  }

  // ちょうど n バイト。何もなければ null、途中で切れていれば投げる
  async read(n: number): Promise<Buffer | null> {
    while (this.buffer.length < n && (await this.fill()));
    if (this.buffer.length === 0 && n > 0) return null
    if (this.buffer.length < n) throw new Error('tar: 途中で切れています')
    const out = this.buffer.subarray(0, n)
    this.buffer = this.buffer.subarray(n)
    return out
  }

  // n バイトを、届いた分ずつ返す（大きなファイルをまとめてメモリーに載せない）
  async *pieces(n: number): AsyncGenerator<Buffer> {
    let left = n
    while (left > 0) {
      if (this.buffer.length === 0 && !(await this.fill())) throw new Error('tar: 途中で切れています')
      const piece = this.buffer.subarray(0, Math.min(left, this.buffer.length))
      this.buffer = this.buffer.subarray(piece.length)
      left -= piece.length
      yield piece
    }
  }

  async skip(n: number): Promise<void> {
    for await (const piece of this.pieces(n)) void piece
  }

  private async fill(): Promise<boolean> {
    if (this.done) return false
    const next = await this.iterator.next()
    if (next.done) {
      this.done = true
      return false
    }
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, next.value]) : next.value
    return true
  }
}
