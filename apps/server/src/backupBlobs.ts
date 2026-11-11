import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, type Stats } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { safePath } from './tar.ts'
import { writeViaTemp } from './writeAtomic.ts'

// バックアップのアーカイブの外に置くファイルの中身（MAI-101）。
// PDF・画像などは一度置いたら変わらないのに、アーカイブに入れると毎回まるごと入る。そこで、アーカイブ（backup.ts）には
// 「パス・中身の SHA-256・大きさ・更新時刻」だけを書き、中身はハッシュを名前にしたファイルとして 1 回だけ置く（<置き場所>/<sha256>）。
// - 置いたファイルは書き換えず、消さない（Asset と同じ。どのアーカイブからも参照されなくなったものを消す仕組みは、まだない）
// - 元のファイルを 1 回読みながら、ハッシュの計算と一時ファイルへの写しを同時に行い、終わってからハッシュの名前に変える。
//   読んでいる途中で元のファイルが置き換わっても、置いた中身と名前は必ず合う。ハードリンクにはしない（元のファイルを
//   その場で書き換えられると、置いた中身も変わるため）
// - パス・大きさ・更新時刻・inode・ctime が前と同じなら、前に計算したハッシュを使う（<置き場所>/.index.json）。5 分ごとに
//   全部を読み直さない。更新時刻を保ったまま置き換えられたファイル（cp -p・rsync -t・展開したもの）も、inode か ctime が変わるので
//   読み直す。ただし、その中身が置き場所にある（大きさも合う）ことは毎回確かめ、なければ読み直して置く
// - 置き場所の中の . で始まる名前（.index.json・書きかけの .put-….tmp）は中身ではない。Drive にも送らない（backupSync.ts）

export const BLOB_MIN_SIZE = 1024 * 1024
// テキストの種類のファイルは、これ未満ならアーカイブに残す（サーバーが編集するのは 10 MiB まで。files.ts の MAX_FILE_BYTES）
export const TEXT_MAX_SIZE = 16 * 1024 * 1024
export const BLOB_NAME_PATTERN = /^[0-9a-f]{64}$/
const INDEX_FILE = '.index.json'
const PUT_TEMP_PATTERN = /^\.put-.+\.tmp$/
// 残った書きかけ（前の回が途中で落ちた）は、これより古ければ消す
const TEMP_GRACE_MS = 60 * 60 * 1000
// 更新時刻か ctime が、今からこれ以内のファイルのハッシュは覚えない。読んだ直後に、時刻の刻みの中で同じ大きさのまま
// 書き換えられると見分けられないため（次の回に読み直す）
const RACY_MS = 2000

// 種類でアーカイブの外に出すファイルの拡張子（圧縮しても縮まず、ふつうは置いたら変わらないもの）
const BLOB_EXTENSIONS = new Set([
  'pdf',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'heif',
  'mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac',
  'mp4', 'mov', 'webm', 'mkv', 'avi',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'zip', 'gz', 'tgz', '7z', 'xz', 'bz2', 'zst', 'rar', 'ricbackup',
  'woff', 'woff2', 'ttf', 'otf',
])

// テキストの種類のファイルの拡張子。書き換わることが多く、圧縮がよく効くので、TEXT_MAX_SIZE 未満ならアーカイブに残す。
// 外に出すと、編集のたびに、圧縮しない中身が 1 つずつ増えて消えない（アーカイブの中なら、古いものと一緒に消える）
const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'py', 'csv', 'tsv', 'json', 'jsonl', 'ndjson',
  'html', 'htm', 'xml', 'svg', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx',
  'yaml', 'yml', 'toml', 'ini', 'tex', 'bib', 'log', 'sql', 'sh', 'ipynb',
])

// アーカイブの外に出すファイルか（path はワークスペースからの相対パス。区切りは /）。
// 上の種類のファイル（大きさによらず）と、BLOB_MIN_SIZE 以上のファイル（テキストの種類は TEXT_MAX_SIZE 以上）。
// .canvcode の直下のファイル（files.json・asset-gc.json など。サーバーが書き換え続ける）は、大きくてもアーカイブに残す。
// 外に出すと、書き換わるたびに中身が 1 つずつ増えるため（workspace.db の写しも同じ理由でアーカイブに入れる。backup.ts）
export function isBlobFile(path: string, size: number): boolean {
  if (/^\.canvcode\/[^/]+$/.test(path)) return false
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (BLOB_EXTENSIONS.has(extension)) return true
  return size >= (TEXT_EXTENSIONS.has(extension) ? TEXT_MAX_SIZE : BLOB_MIN_SIZE)
}

// アーカイブの manifest に書く、外に置いたファイル
export interface BlobFile {
  // ワークスペースからの相対パス（区切りは /）
  path: string
  sha256: string
  size: number
  // 更新時刻（ミリ秒）。復元のときに戻す
  mtime: number
}

interface IndexEntry {
  size: number
  mtimeMs: number
  // 更新時刻を保ったまま置き換えられたファイルを見分ける（inode は名前の変更で、ctime は中身や属性の変更で変わり、utimes では戻せない）
  ino: number
  ctimeMs: number
  sha256: string
}

function sameFile(entry: IndexEntry, info: Stats): boolean {
  return entry.size === info.size && entry.mtimeMs === info.mtimeMs && entry.ino === info.ino && entry.ctimeMs === info.ctimeMs
}

export class BlobStore {
  readonly dir: string
  // この回に、読んでハッシュを計算したファイルの数と、新しく置いた中身の数・大きさ
  hashed = 0
  added = 0
  addedBytes = 0
  private readonly index: Map<string, IndexEntry>
  // この回に見たファイル（save で、これだけを覚え直す。なくなったファイルの分は忘れる）
  private readonly seen = new Map<string, IndexEntry>()
  private counter = 0
  private readonly now: number

  private constructor(dir: string, index: Map<string, IndexEntry>, now: number) {
    this.dir = dir
    this.index = index
    this.now = now
  }

  // now は、バックアップを作っている時刻（ミリ秒）。書かれたばかりのファイルかどうかを、これと比べる
  static async open(dir: string, now: number = Date.now()): Promise<BlobStore> {
    const root = resolve(dir)
    await mkdir(root, { recursive: true })
    for (const name of await readdir(root)) {
      if (!PUT_TEMP_PATTERN.test(name)) continue
      const info = await stat(join(root, name)).catch(() => null)
      if (info && Date.now() - info.mtimeMs > TEMP_GRACE_MS) await rm(join(root, name), { force: true })
    }
    return new BlobStore(root, await readIndex(join(root, INDEX_FILE)), now)
  }

  // abs のファイルの中身を置き（まだなければ）、manifest に書く内容を返す。ファイルがなくなっていれば null
  async put(path: string, abs: string): Promise<BlobFile | null> {
    const info = await stat(abs).catch(() => null)
    if (!info?.isFile()) return null
    const mtime = Math.floor(info.mtimeMs)
    const cached = this.index.get(path)
    if (cached && sameFile(cached, info) && (await this.has(cached.sha256, cached.size))) {
      this.seen.set(path, cached)
      return { path, sha256: cached.sha256, size: cached.size, mtime }
    }
    const temp = join(this.dir, `.put-${process.pid}-${Date.now()}-${this.counter++}.tmp`)
    const hash = createHash('sha256')
    let size = 0
    let sha256: string
    try {
      try {
        await pipeline(
          createReadStream(abs),
          async function* (source: AsyncIterable<Buffer>) {
            for await (const chunk of source) {
              hash.update(chunk)
              size += chunk.length
              yield chunk
            }
          },
          createWriteStream(temp, { flags: 'wx' }),
        )
      } catch (error) {
        // 集めたあとで消えたもの（名前を変えた・ゴミ箱に移した）
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && (error as NodeJS.ErrnoException).path === abs) return null
        throw error
      }
      this.hashed++
      sha256 = hash.digest('hex')
      if (!(await this.has(sha256, size))) {
        // 名前を変える前にディスクに書き切る（電源が落ちて、ハッシュの名前で中身が欠けたファイルが残らないように）
        const handle = await open(temp, 'r')
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
        await rename(temp, join(this.dir, sha256))
        this.added++
        this.addedBytes += size
      }
    } finally {
      await rm(temp, { force: true })
    }
    // 読んでいる間に変わっておらず、書かれたばかりでもないときだけ、ハッシュを覚える
    const after = await stat(abs).catch(() => null)
    const entry: IndexEntry = { size, mtimeMs: info.mtimeMs, ino: info.ino, ctimeMs: info.ctimeMs, sha256 }
    if (after && size === info.size && sameFile(entry, after) && Math.abs(this.now - info.mtimeMs) >= RACY_MS && Math.abs(this.now - info.ctimeMs) >= RACY_MS) {
      this.seen.set(path, entry)
    }
    return { path, sha256, size, mtime }
  }

  // 覚えたハッシュを書く
  async save(): Promise<void> {
    const files = Object.fromEntries([...this.seen].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    const path = join(this.dir, INDEX_FILE)
    await writeViaTemp(`${path}.${process.pid}.${Date.now()}.tmp`, path, `${JSON.stringify({ version: 1, files })}\n`)
  }

  private async has(sha256: string, size: number): Promise<boolean> {
    const info = await stat(join(this.dir, sha256)).catch(() => null)
    return !!info?.isFile() && info.size === size
  }
}

async function readIndex(path: string): Promise<Map<string, IndexEntry>> {
  const index = new Map<string, IndexEntry>()
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { version?: number; files?: Record<string, Partial<IndexEntry>> }
    if (parsed.version !== 1 || !parsed.files) return index
    for (const [file, entry] of Object.entries(parsed.files)) {
      if (typeof entry?.size === 'number' && typeof entry.mtimeMs === 'number' && typeof entry.ino === 'number' && typeof entry.ctimeMs === 'number' && typeof entry.sha256 === 'string' && BLOB_NAME_PATTERN.test(entry.sha256)) {
        index.set(file, { size: entry.size, mtimeMs: entry.mtimeMs, ino: entry.ino, ctimeMs: entry.ctimeMs, sha256: entry.sha256 })
      }
    }
  } catch {
    // ない・壊れている：読み直して作り直す
  }
  return index
}

// manifest の blobFiles を、from（<sha256> のファイルを置いたフォルダ）から root の下の元のパスに写す。
// 写しながらハッシュと大きさを確かめる。足りない・合わないものがあれば、全部を見てから、どれかを挙げて投げる。
// すでにあるファイルには上書きしない（アーカイブから展開したものと同じパスなら、壊れた manifest として止まる）
export async function restoreBlobs(files: BlobFile[], from: string | undefined, root: string): Promise<number> {
  if (files.length === 0) return 0
  if (!from) throw new Error(`このバックアップは、PDF・画像などのファイル（${files.length} 個）の中身を別に置いています。中身を置いたフォルダを指定してください（--blobs <フォルダ>）`)
  const source = resolve(from)
  const base = resolve(root)
  const missing: string[] = []
  const broken: string[] = []
  for (const file of files) {
    if (typeof file?.path !== 'string' || typeof file.sha256 !== 'string' || !BLOB_NAME_PATTERN.test(file.sha256) || typeof file.size !== 'number') {
      throw new Error('バックアップの canvcode-backup.json が壊れています（blobFiles）')
    }
    const rel = safePath(file.path)
    const target = resolve(base, ...rel.split('/'))
    if (!target.startsWith(base + sep)) throw new Error(`復元先の外を指しています: ${file.path}`)
    const blob = join(source, file.sha256)
    if (!(await stat(blob).catch(() => null))?.isFile()) {
      missing.push(`${file.path}（${file.sha256.slice(0, 12)}…）`)
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    const hash = createHash('sha256')
    let size = 0
    await pipeline(
      createReadStream(blob),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          hash.update(chunk)
          size += chunk.length
          yield chunk
        }
      },
      createWriteStream(target, { flags: 'wx' }),
    )
    if (size !== file.size || hash.digest('hex') !== file.sha256) {
      broken.push(`${file.path}（${file.sha256.slice(0, 12)}…）`)
      continue
    }
    if (typeof file.mtime === 'number' && file.mtime > 0) await utimes(target, new Date(file.mtime), new Date(file.mtime))
  }
  const some = (list: string[]) => `${list.slice(0, 5).join(', ')}${list.length > 5 ? ' …' : ''}`
  const problems: string[] = []
  if (missing.length > 0) problems.push(`中身が見つかりません（${missing.length} 個）: ${some(missing)}`)
  if (broken.length > 0) problems.push(`中身がハッシュと合いません（${broken.length} 個）: ${some(broken)}`)
  if (problems.length > 0) throw new Error(`PDF・画像などのファイルを戻せません。${problems.join('。')}`)
  return files.length
}
