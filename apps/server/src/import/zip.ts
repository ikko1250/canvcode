import { open, type FileHandle } from 'node:fs/promises'
import { promisify } from 'node:util'
import { inflateRaw } from 'node:zlib'

// ZIP の読み込み（.ricbackup は fflate で作った ZIP。MAI-13）。
// 中身の一覧（中央ディレクトリ）だけを先に読み、各ファイルは頼まれたときにディスクから読んで展開する。
// 数百 MB のファイルでも、全体をメモリに載せない。ZIP64（4GB 超）と暗号化には対応しない

const inflate = promisify(inflateRaw)

interface Entry {
  name: string
  method: number
  compressedSize: number
  size: number
  localHeaderOffset: number
}

export class ZipReader {
  private readonly file: FileHandle
  private readonly entries: Map<string, Entry>

  private constructor(file: FileHandle, entries: Map<string, Entry>) {
    this.file = file
    this.entries = entries
  }

  static async open(path: string): Promise<ZipReader> {
    const file = await open(path, 'r')
    try {
      const { size } = await file.stat()
      // 末尾の「中央ディレクトリの終わり」（コメントの分、最大 64KB ほど前から探す）
      const tailSize = Math.min(size, 65_557)
      const tail = Buffer.alloc(tailSize)
      await file.read(tail, 0, tailSize, size - tailSize)
      let eocd = -1
      for (let i = tailSize - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === 0x06054b50) {
          eocd = i
          break
        }
      }
      if (eocd < 0) throw new Error('ZIP ではありません')
      const count = tail.readUInt16LE(eocd + 10)
      const dirSize = tail.readUInt32LE(eocd + 12)
      const dirOffset = tail.readUInt32LE(eocd + 16)
      if (dirOffset === 0xffffffff || count === 0xffff) throw new Error('ZIP64 には対応していません')
      const dir = Buffer.alloc(dirSize)
      await file.read(dir, 0, dirSize, dirOffset)
      const entries = new Map<string, Entry>()
      let p = 0
      for (let n = 0; n < count; n++) {
        if (dir.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP の中央ディレクトリが壊れています')
        const flags = dir.readUInt16LE(p + 8)
        const method = dir.readUInt16LE(p + 10)
        const compressedSize = dir.readUInt32LE(p + 20)
        const entrySize = dir.readUInt32LE(p + 24)
        const nameLength = dir.readUInt16LE(p + 28)
        const extraLength = dir.readUInt16LE(p + 30)
        const commentLength = dir.readUInt16LE(p + 32)
        const localHeaderOffset = dir.readUInt32LE(p + 42)
        const name = dir.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLength)
        if (flags & 1) throw new Error('暗号化された ZIP には対応していません')
        entries.set(name, { name, method, compressedSize, size: entrySize, localHeaderOffset })
        p += 46 + nameLength + extraLength + commentLength
      }
      return new ZipReader(file, entries)
    } catch (error) {
      await file.close()
      throw error
    }
  }

  names(): string[] {
    return [...this.entries.keys()]
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  async read(name: string): Promise<Buffer> {
    const entry = this.entries.get(name)
    if (!entry) throw new Error(`ZIP の中に ${name} がありません`)
    const header = Buffer.alloc(30)
    await this.file.read(header, 0, 30, entry.localHeaderOffset)
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`ZIP のファイル見出しが壊れています：${name}`)
    const start = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
    const data = Buffer.alloc(entry.compressedSize)
    await this.file.read(data, 0, entry.compressedSize, start)
    if (entry.method === 0) return data
    if (entry.method === 8) return inflate(data)
    throw new Error(`対応していない圧縮方式です（${entry.method}）：${name}`)
  }

  async readJson<T>(name: string): Promise<T> {
    return JSON.parse((await this.read(name)).toString('utf8')) as T
  }

  async close(): Promise<void> {
    await this.file.close()
  }
}
