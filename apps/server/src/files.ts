import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { watch, type FSWatcher } from 'chokidar'

// Markdown / Python / スライドデッキの File（MAI-10、MAI-13、MAI-30）。
// - 本文は、ワークスペースのフォルダに .md / .py / .slide.md / .slide.json として置く。サブフォルダは SSH 側で自由に作ってよい
// - File の id とパスの対応は .canvcode/files.json に持つ（段階 11 で SQLite に移す）
// - 書き込むときは、ブラウザが読んだときのハッシュ（If-Match）と今のハッシュを比べ、違えば 409 で断る（衝突）
// - 外からの変更（SSH からの編集など）は chokidar で監視し、知らせる。アプリ自身が書いた変更は、ハッシュで見分けて無視する
// - 外で名前が変わった場合（削除と追加が短い間に続き、中身が同じ）は、同じ File とみなしてパスだけを更新する

export type FileKind = 'markdown' | 'code' | 'slides'

export interface FileInfo {
  id: string
  kind: FileKind
  // 拡張子を除いたファイル名
  title: string
  // ワークスペースのフォルダからの相対パス（区切りは /）
  path: string
  size: number
  mtime: number
  hash: string
  // ファイルが見つからなくなった（外で削除された）
  missing: boolean
}

export type FileEvent =
  | { type: 'file-added'; file: FileInfo }
  | { type: 'file-changed'; file: FileInfo }
  | { type: 'file-removed'; file: FileInfo }

const KIND_BY_EXT: Record<string, FileKind> = { '.md': 'markdown', '.markdown': 'markdown', '.py': 'code' }
const EXT_BY_KIND: Record<FileKind, string> = { markdown: '.md', code: '.py', slides: '.slide.md' }

function kindOfPath(path: string): FileKind | undefined {
  const lower = path.toLowerCase()
  if (lower.endsWith('.slide.md') || lower.endsWith('.slide.json')) return 'slides'
  return KIND_BY_EXT[extname(lower)]
}

function extensionOfPath(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.slide.md')) return '.slide.md'
  if (lower.endsWith('.slide.json')) return '.slide.json'
  return extname(path)
}
const MAX_FILE_BYTES = 10 * 1024 * 1024
// 削除と追加がこの時間内に続き、中身が同じなら、名前が変わったとみなす
const RENAME_WINDOW_MS = 1500

interface IndexFile {
  version: 1
  files: { id: string; path: string }[]
}

export class FileStore {
  private readonly workspace: string
  private readonly dataDir: string
  private readonly indexPath: string
  private readonly broadcast: (event: FileEvent) => void
  private readonly files = new Map<string, FileInfo>()
  private readonly byPath = new Map<string, string>()
  // アプリ自身が書いた中身のハッシュ（監視で届いた変更と比べて、自分の書き込みを無視する）
  private readonly ownWrites = new Map<string, string>()
  // 外で削除されたもの（名前の変更かどうかを、少し待って確かめる）
  private readonly pendingUnlinks = new Map<string, { id: string; hash: string; timer: ReturnType<typeof setTimeout> }>()
  private watcher: FSWatcher | null = null
  private indexQueue: Promise<void> = Promise.resolve()
  private indexWrites = 0

  constructor(workspace: string, dataDir: string, broadcast: (event: FileEvent) => void) {
    this.workspace = resolve(workspace)
    this.dataDir = dataDir
    this.indexPath = join(dataDir, 'files.json')
    this.broadcast = broadcast
  }

  async init(): Promise<void> {
    await mkdir(join(this.dataDir, 'deleted'), { recursive: true })
    const saved = await readFile(this.indexPath, 'utf8')
      .then((text) => JSON.parse(text) as IndexFile)
      .catch(() => ({ version: 1, files: [] }) as IndexFile)
    const known = new Map(saved.files.map((f) => [f.path, f.id]))
    // 今あるファイルを調べ、索引に合わせる（前回からなくなったものは「ファイルなし」として残す）
    for (const path of await this.scan(this.workspace)) {
      const info = await this.readInfo(known.get(path) ?? newFileId(), path)
      if (info) this.put(info)
    }
    for (const { id, path } of saved.files) {
      if (this.files.has(id)) continue
      const kind = kindOfPath(path)
      if (kind) this.put({ id, kind, title: titleOf(path), path, size: 0, mtime: 0, hash: '', missing: true })
    }
    await this.saveIndex()
    this.startWatching()
  }

  async close(): Promise<void> {
    await this.watcher?.close()
  }

  list(): FileInfo[] {
    return [...this.files.values()]
  }

  getInfo(id: string): FileInfo {
    return this.get(id)
  }

  // 開いているブラウザに、中身が変わったことを知らせる（スライドのエディタが /api/slides から保存したときなど）
  announce(id: string): void {
    this.broadcast({ type: 'file-changed', file: this.get(id) })
  }

  resolveWorkspacePath(path: string): string {
    return this.abs(path)
  }

  // /api/files 以下を扱う。扱わないパスなら false を返す
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const parts = path.split('/').filter(Boolean)
    if (parts[0] !== 'api' || parts[1] !== 'files') return false
    // id の「:」は、ブラウザが %3A にして送ってくる
    const id = parts[2] === undefined ? undefined : safeDecode(parts[2])
    const sub = parts[3]
    try {
      if (parts.length === 2 && req.method === 'GET') {
        sendJson(res, 200, { files: this.list() })
      } else if (parts.length === 2 && req.method === 'POST') {
        const body = JSON.parse((await readBody(req, MAX_FILE_BYTES)).toString('utf8')) as {
          kind?: FileKind
          title?: string
          content?: string
          format?: 'md' | 'json'
        }
        if (body.kind !== 'markdown' && body.kind !== 'code' && body.kind !== 'slides') throw new HttpError(400, 'kind must be markdown, code or slides')
        const json = body.kind === 'slides' && body.format === 'json'
        // 空のデッキはスライドとして読めないので、表紙 1 枚を入れて作る
        const content = body.content || (body.kind === 'slides' ? emptyDeck(json) : '')
        sendJson(res, 200, { file: await this.create(body.kind, body.title ?? '無題', content, { extension: json ? '.slide.json' : undefined }) })
      } else if (parts.length === 3 && req.method === 'PATCH') {
        const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')) as { title?: string }
        if (!body.title) throw new HttpError(400, 'title is required')
        sendJson(res, 200, { file: await this.rename(id!, body.title) })
      } else if (parts.length === 3 && req.method === 'DELETE') {
        await this.removeForever(id!)
        sendJson(res, 200, { ok: true })
      } else if (parts.length === 4 && sub === 'content' && req.method === 'GET') {
        const { text, hash } = await this.read(id!)
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', etag: `"${hash}"`, 'cache-control': 'no-store' })
        res.end(text)
      } else if (parts.length === 4 && sub === 'content' && req.method === 'PUT') {
        const ifMatch = (req.headers['if-match'] ?? '').toString().replace(/"/g, '')
        const text = (await readBody(req, MAX_FILE_BYTES)).toString('utf8')
        sendJson(res, 200, { file: await this.write(id!, text, ifMatch) })
      } else {
        sendJson(res, 405, { error: 'method not allowed' })
      }
    } catch (error) {
      if (error instanceof HttpError) sendJson(res, error.status, { error: error.message, ...error.extra })
      else {
        console.error('file request failed', error)
        sendJson(res, 500, { error: 'internal error' })
      }
    }
    return true
  }

  // ---- 操作 ----

  async read(id: string): Promise<{ text: string; hash: string }> {
    const info = this.get(id)
    const buffer = await readFile(this.abs(info.path)).catch(() => {
      throw new HttpError(404, 'file is missing')
    })
    return { text: buffer.toString('utf8'), hash: hashOf(buffer) }
  }

  async write(id: string, text: string, ifMatch: string): Promise<FileInfo> {
    const info = this.get(id)
    const current = await readFile(this.abs(info.path)).catch(() => null)
    const currentHash = current ? hashOf(current) : ''
    // ブラウザが読んだあとで、外で変わっていたら書かない（MAI-10 の「衝突」）
    if (ifMatch && current && ifMatch !== currentHash) {
      throw new HttpError(409, 'the file was changed outside', { file: info, hash: currentHash })
    }
    const buffer = Buffer.from(text, 'utf8')
    await this.writeAtomic(info.path, buffer)
    const next = { ...info, ...(await this.statOf(info.path)), hash: hashOf(buffer), missing: false }
    this.put(next)
    return next
  }

  // id を渡すと、その id で作る（旧データの取り込み。旧の ID を引き継ぐ）。announce なら、開いているブラウザに知らせる
  async create(kind: FileKind, title: string, content: string, options: { id?: string; announce?: boolean; extension?: string } = {}): Promise<FileInfo> {
    if (options.id && this.files.has(options.id)) throw new HttpError(409, `file already exists: ${options.id}`)
    const path = await this.freePath(sanitizeTitle(title), options.extension ?? EXT_BY_KIND[kind])
    const buffer = Buffer.from(content, 'utf8')
    await this.writeAtomic(path, buffer)
    const info: FileInfo = { id: options.id ?? newFileId(), kind, title: titleOf(path), path, ...(await this.statOf(path)), hash: hashOf(buffer), missing: false }
    this.put(info)
    await this.saveIndex()
    if (options.announce) this.broadcast({ type: 'file-added', file: info })
    return info
  }

  // 名前を変える。File の名前はファイル名と同じ（MAI-10）。同じ名前があれば、末尾に番号を付ける。フォルダはそのまま
  async rename(id: string, title: string): Promise<FileInfo> {
    const info = this.get(id)
    const ext = extensionOfPath(info.path)
    const dir = dirname(info.path) === '.' ? '' : dirname(info.path)
    const wanted = sanitizeTitle(title)
    if (wanted === info.title) return info
    const path = await this.freePath(wanted, ext, dir)
    // 名前の変更は、監視には削除と追加として届く。自分の変更なので、その知らせは無視する
    this.ownWrites.set(path, info.hash)
    await rename(this.abs(info.path), this.abs(path))
    this.byPath.delete(info.path)
    const next = { ...info, path, title: titleOf(path) }
    this.put(next)
    await this.saveIndex()
    return next
  }

  // ゴミ箱から完全に削除したとき。実ファイルは消さず、.canvcode/deleted/ に移す（MAI-13）
  async removeForever(id: string): Promise<void> {
    const info = this.get(id)
    if (!info.missing) {
      const target = join(this.dataDir, 'deleted', `${Date.now()}-${basename(info.path)}`)
      this.ownWrites.set(info.path, 'deleted')
      await rename(this.abs(info.path), target).catch(() => {})
    }
    this.files.delete(id)
    this.byPath.delete(info.path)
    await this.saveIndex()
  }

  // ---- 監視 ----

  private startWatching(): void {
    this.watcher = watch(this.workspace, {
      ignoreInitial: true,
      // 名前が . で始まるフォルダ（.git、.canvcode など）と node_modules は見ない（MAI-10）
      ignored: (path, stats) => {
        const rel = relative(this.workspace, path)
        if (!rel) return false
        if (rel.split(sep).some((part) => part.startsWith('.') || part === 'node_modules')) return true
        return stats?.isFile() === true && !kindOfPath(path)
      },
      // 書き込みの途中を読まないよう、少し落ち着くのを待つ
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
    })
    // 監視から呼ぶ処理が失敗しても、サーバーは止めずに記録だけする
    const guard = (task: Promise<void> | void) => void Promise.resolve(task).catch((error: unknown) => console.error('file watch failed', error))
    this.watcher.on('add', (path) => guard(this.onAdd(this.rel(path))))
    this.watcher.on('change', (path) => guard(this.onChange(this.rel(path))))
    this.watcher.on('unlink', (path) => guard(this.onUnlink(this.rel(path))))
  }

  private async onAdd(path: string): Promise<void> {
    if (!kindOfPath(path)) return
    if (this.ownWrites.has(path)) {
      this.ownWrites.delete(path)
      return
    }
    const existing = this.byPath.get(path)
    if (existing && !this.files.get(existing)?.missing) return
    const info = await this.readInfo(existing ?? newFileId(), path)
    if (!info) return
    // 少し前に消えた、中身が同じファイルがあれば、名前が変わったものとみなす
    for (const [oldPath, pending] of this.pendingUnlinks) {
      if (pending.hash !== info.hash) continue
      clearTimeout(pending.timer)
      this.pendingUnlinks.delete(oldPath)
      this.byPath.delete(oldPath)
      const moved = { ...info, id: pending.id }
      this.put(moved)
      await this.saveIndex()
      this.broadcast({ type: 'file-changed', file: moved })
      return
    }
    this.put(info)
    await this.saveIndex()
    this.broadcast({ type: existing ? 'file-changed' : 'file-added', file: info })
  }

  private async onChange(path: string): Promise<void> {
    const id = this.byPath.get(path)
    if (!id) return this.onAdd(path)
    const info = await this.readInfo(id, path)
    if (!info) return
    const previous = this.files.get(id)
    // アプリ自身の書き込み（write で記録した値と同じハッシュ）なら、知らせない
    if (previous && previous.hash === info.hash) return
    this.put(info)
    this.broadcast({ type: 'file-changed', file: info })
  }

  private onUnlink(path: string): void {
    // アプリ自身が消した（完全に削除して deleted/ に移した）もの
    if (this.ownWrites.get(path) === 'deleted') {
      this.ownWrites.delete(path)
      return
    }
    // アプリ自身が名前を変えたものは、もう古いパスでは引けない
    const id = this.byPath.get(path)
    if (!id) return
    const info = this.files.get(id)
    if (!info || info.path !== path) return
    const timer = setTimeout(() => {
      this.pendingUnlinks.delete(path)
      const missing = { ...info, missing: true }
      this.put(missing)
      this.saveIndex().catch((error: unknown) => console.error('failed to save the file index', error))
      this.broadcast({ type: 'file-removed', file: missing })
    }, RENAME_WINDOW_MS)
    this.pendingUnlinks.set(path, { id, hash: info.hash, timer })
  }

  // ---- 下回り ----

  private get(id: string): FileInfo {
    const info = this.files.get(id)
    if (!info) throw new HttpError(404, 'no such file')
    return info
  }

  private put(info: FileInfo): void {
    const previous = this.files.get(info.id)
    if (previous && previous.path !== info.path && this.byPath.get(previous.path) === info.id) this.byPath.delete(previous.path)
    this.files.set(info.id, info)
    this.byPath.set(info.path, info.id)
  }

  private async readInfo(id: string, path: string): Promise<FileInfo | null> {
    const kind = kindOfPath(path)
    if (!kind) return null
    try {
      const buffer = await readFile(this.abs(path))
      if (buffer.length > MAX_FILE_BYTES) return null
      return { id, kind, title: titleOf(path), path, ...(await this.statOf(path)), hash: hashOf(buffer), missing: false }
    } catch {
      return null
    }
  }

  private async statOf(path: string): Promise<{ size: number; mtime: number }> {
    const info = await stat(this.abs(path))
    return { size: info.size, mtime: info.mtimeMs }
  }

  private async scan(dir: string): Promise<string[]> {
    const out: string[] = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...(await this.scan(full)))
      else if (entry.isFile() && kindOfPath(entry.name)) out.push(this.rel(full))
    }
    return out
  }

  // 使われていない名前（同じ名前があれば「名前 2」「名前 3」…）
  private async freePath(title: string, ext: string, dir = ''): Promise<string> {
    for (let n = 1; ; n++) {
      const name = `${n === 1 ? title : `${title} ${n}`}${ext}`
      const path = dir ? `${dir}/${name}` : name
      const taken = this.byPath.has(path) || (await stat(this.abs(path)).then(() => true, () => false))
      if (!taken) return path
    }
  }

  // 一時ファイルに書いてから名前を変える（書きかけのファイルが残らない。MAI-13）
  private async writeAtomic(path: string, data: Buffer): Promise<void> {
    const abs = this.abs(path)
    await mkdir(dirname(abs), { recursive: true })
    // 一時ファイルは . で始まる名前にして、監視に拾わせない
    const temp = join(dirname(abs), `.${basename(abs)}.${process.pid}.${Date.now()}.tmp`)
    await writeFile(temp, data)
    await rename(temp, abs)
  }

  // 索引を書く。同時に呼ばれても、順番に 1 つずつ書く（一時ファイルの取り合いで失敗しないように）
  private saveIndex(): Promise<void> {
    const run = async () => {
      const index: IndexFile = { version: 1, files: this.list().map(({ id, path }) => ({ id, path })) }
      const temp = `${this.indexPath}.${process.pid}.${++this.indexWrites}.tmp`
      await writeFile(temp, JSON.stringify(index, null, 2))
      await rename(temp, this.indexPath)
    }
    this.indexQueue = this.indexQueue.then(run, run)
    return this.indexQueue
  }

  // ワークスペースの中のパスを、絶対パスにする。外を指していたら断る
  private abs(path: string): string {
    const abs = resolve(this.workspace, path)
    if (abs !== this.workspace && !abs.startsWith(this.workspace + sep)) throw new HttpError(400, 'path outside the workspace')
    return abs
  }

  private rel(abs: string): string {
    return relative(this.workspace, abs).split(sep).join('/')
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function newFileId(): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  return `file:${[...randomBytes(16)].map((b) => alphabet[b % 62]).join('')}`
}

function hashOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function emptyDeck(json: boolean): string {
  return json ? `${JSON.stringify({ slides: [{ layout: 'title', title: 'タイトル' }] }, null, 2)}\n` : '# タイトル\n'
}

function titleOf(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.slide.md')) return basename(path).slice(0, -'.slide.md'.length)
  if (lower.endsWith('.slide.json')) return basename(path).slice(0, -'.slide.json'.length)
  return basename(path, extname(path))
}

// ファイル名に使えない文字を除く。空になったら「無題」
function sanitizeTitle(title: string): string {
  const cleaned = [...title]
    .filter((c) => c.charCodeAt(0) >= 0x20)
    .join('')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
  return cleaned || '無題'
}

export class HttpError extends Error {
  readonly status: number
  readonly extra: Record<string, unknown>
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
