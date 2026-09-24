import type { FileRecord } from '@canvcode/core'
import type { FileContentSource } from '@canvcode/nodes'
import type { Workspace } from './workspace.ts'

// File の本文の読み書き（MAI-10、MAI-30）。
// - 本文はサーバーの実ファイルが正本。ブラウザは読んだ本文と、そのときのハッシュ（base）を持つ
// - 編集は少し待ってまとめて保存する。保存するときに base を送り、その間に外で変わっていたら衝突として扱う
// - 外からの変更は WebSocket で届く。保存していない編集がなければ黙って読み込み直し、あれば衝突として尋ねる
// - 改行コードは元のまま保つ。エディタには LF で渡し、保存するときに元の改行に戻す

export type ConflictChoice = 'theirs' | 'mine' | 'saveAs'

export interface FileManagerOptions {
  workspace: Workspace
  baseUrl?: string
  eventsUrl?: string
  notify?: (message: string) => void
  // 保存していない編集があるときに、外で本文が変わった。どうするかを尋ねる（MAI-10 の「衝突」）
  onConflict?: (file: FileRecord) => Promise<ConflictChoice>
}

interface ServerFile {
  id: string
  kind: 'markdown' | 'code' | 'slides'
  title: string
  path: string
  size: number
  mtime: number
  hash: string
  missing: boolean
}

interface Entry {
  text: string
  // 本文の版（描画の画像キャッシュに使う）
  version: string
  // この本文を読んだとき（最後に保存したとき）のサーバーのハッシュ
  base: string
  crlf: boolean
  dirty: boolean
  timer: ReturnType<typeof setTimeout> | null
  saving: Promise<void> | null
}

// 打ち終えてから保存するまでの時間
const SAVE_DELAY_MS = 600
const RECONNECT_MAX_MS = 10_000
const KEEPALIVE_LIMIT = 60_000

export class FileManager implements FileContentSource {
  private readonly workspace: Workspace
  private readonly baseUrl: string
  private readonly eventsUrl: string
  private notify: (message: string) => void
  private onConflict: (file: FileRecord) => Promise<ConflictChoice>
  private readonly entries = new Map<string, Entry>()
  private readonly loading = new Map<string, Promise<void>>()
  private readonly listeners = new Set<(fileId: string) => void>()
  private socket: WebSocket | null = null
  private reconnectDelay = 500
  private disposed = false

  constructor(options: FileManagerOptions) {
    this.workspace = options.workspace
    this.baseUrl = options.baseUrl ?? '/api/files'
    this.eventsUrl = options.eventsUrl ?? '/api/events'
    this.notify = options.notify ?? ((message) => console.warn(message))
    this.onConflict = options.onConflict ?? (async () => 'theirs')
  }

  // 知らせる先と、衝突のときに尋ねる先をあとから決める（画面の準備ができてから）
  setHandlers(handlers: Pick<FileManagerOptions, 'notify' | 'onConflict'>): void {
    if (handlers.notify) this.notify = handlers.notify
    if (handlers.onConflict) this.onConflict = handlers.onConflict
  }

  // 一覧を読み、外からの変更の知らせを受け始める
  async start(): Promise<void> {
    await this.loadList()
    this.connect()
  }

  dispose(): void {
    this.disposed = true
    this.socket?.close()
    for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer)
  }

  // 本文が変わったとき（読み込めた・編集した・外で変わった）に呼ばれる
  onChange(listener: (fileId: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // 描画から呼ばれる。まだ読んでいなければ読み込みを始めて null を返す
  get(fileId: string): { text: string; version: string; path?: string; kind?: 'markdown' | 'code' | 'slides' } | null {
    const entry = this.entries.get(fileId)
    if (entry) {
      const file = this.workspace.getFile(fileId)
      return { text: entry.text, version: entry.version, path: file?.path, kind: file?.kind }
    }
    void this.load(fileId)
    return null
  }

  // 本文を読み込む（読み込み済みなら、それを返す）
  async text(fileId: string): Promise<string | null> {
    await this.load(fileId)
    return this.entries.get(fileId)?.text ?? null
  }

  isDirty(fileId: string): boolean {
    const entry = this.entries.get(fileId)
    return entry !== undefined && (entry.dirty || entry.saving !== null)
  }

  // 編集した本文（LF）。少し待ってから保存する
  edit(fileId: string, text: string): void {
    const entry = this.entries.get(fileId)
    if (!entry || entry.text === text) return
    entry.text = text
    entry.version = versionOf(text)
    entry.dirty = true
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => void this.save(fileId), SAVE_DELAY_MS)
    this.emit(fileId)
  }

  // 待たずに保存する（編集を終えたとき・ページを離れるとき）
  async flush(fileId?: string): Promise<void> {
    const ids = fileId ? [fileId] : [...this.entries.keys()]
    await Promise.all(ids.map((id) => this.save(id)))
  }

  async create(kind: 'markdown' | 'code' | 'slides', title: string, content = ''): Promise<FileRecord> {
    const initialContent = kind === 'slides' && content === '' ? '# タイトル\n' : content
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, title, content: initialContent }),
    })
    if (!response.ok) throw new Error(`Failed to create a file: ${response.status}`)
    const { file } = (await response.json()) as { file: ServerFile }
    this.workspace.applyServerFile(file)
    this.entries.set(file.id, makeEntry(initialContent, file.hash))
    return this.workspace.getFile(file.id)!
  }

  // 名前を変える（ファイル名も変わる。MAI-10）
  async rename(fileId: string, title: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/${encodeURIComponent(fileId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    if (!response.ok) {
      this.notify('名前を変えられませんでした')
      return
    }
    const { file } = (await response.json()) as { file: ServerFile }
    this.workspace.applyServerFile(file)
  }

  // ゴミ箱から完全に削除したとき。サーバーは実ファイルを .canvcode/deleted/ に移す
  async deleteForever(fileId: string): Promise<void> {
    this.entries.delete(fileId)
    await fetch(`${this.baseUrl}/${encodeURIComponent(fileId)}`, { method: 'DELETE' })
  }

  // ---- 読み込み ----

  private async loadList(): Promise<void> {
    const response = await fetch(this.baseUrl)
    if (!response.ok) throw new Error(`Failed to list files: ${response.status}`)
    const { files } = (await response.json()) as { files: ServerFile[] }
    for (const file of files) this.workspace.applyServerFile(file)
  }

  private load(fileId: string): Promise<void> {
    if (this.entries.has(fileId)) return Promise.resolve()
    let pending = this.loading.get(fileId)
    if (!pending) {
      pending = this.fetchContent(fileId)
        .then((result) => {
          if (result && !this.entries.has(fileId)) {
            this.entries.set(fileId, makeEntry(result.text, result.hash))
            this.emit(fileId)
          }
        })
        .catch((error: unknown) => console.error('Failed to load a file', fileId, error))
        .finally(() => this.loading.delete(fileId))
      this.loading.set(fileId, pending)
    }
    return pending
  }

  private async fetchContent(fileId: string): Promise<{ text: string; hash: string } | null> {
    if (!this.workspace.getFile(fileId) || this.workspace.getFile(fileId)?.missing) return null
    const response = await fetch(`${this.baseUrl}/${encodeURIComponent(fileId)}/content`)
    if (!response.ok) return null
    const hash = (response.headers.get('etag') ?? '').replace(/"/g, '')
    return { text: await response.text(), hash }
  }

  // ---- 保存 ----

  private save(fileId: string): Promise<void> {
    const entry = this.entries.get(fileId)
    if (!entry) return Promise.resolve()
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    // 保存中なら、それが終わってからもう一度（その間の編集を保存する）
    if (entry.saving) return entry.saving.then(() => this.save(fileId))
    if (!entry.dirty) return Promise.resolve()
    entry.dirty = false
    const text = entry.text
    entry.saving = this.put(fileId, entry, text, entry.base).finally(() => {
      entry.saving = null
    })
    return entry.saving
  }

  private async put(fileId: string, entry: Entry, text: string, base: string | null): Promise<void> {
    const body = entry.crlf ? text.replace(/\n/g, '\r\n') : text
    const response = await fetch(`${this.baseUrl}/${encodeURIComponent(fileId)}/content`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain; charset=utf-8', ...(base ? { 'if-match': `"${base}"` } : {}) },
      body,
      // ページを閉じる直前の保存でも届くように（keepalive で送れる大きさには上限がある）
      keepalive: body.length < KEEPALIVE_LIMIT,
    }).catch(() => null)
    if (!response) {
      entry.dirty = true
      this.notify('保存できませんでした（サーバーにつながりません）。つながり次第、保存し直します')
      entry.timer = setTimeout(() => void this.save(fileId), 3000)
      return
    }
    if (response.status === 409) {
      // 読んだあとで外で変わっていた
      entry.dirty = true
      await this.resolveConflict(fileId)
      return
    }
    if (!response.ok) {
      entry.dirty = true
      this.notify('保存できませんでした')
      return
    }
    const { file } = (await response.json()) as { file: ServerFile }
    entry.base = file.hash
    this.workspace.applyServerFile(file)
  }

  // 外で変わった本文と、保存していない自分の編集が食い違っている。どちらを使うか尋ねる（MAI-10）
  private async resolveConflict(fileId: string): Promise<void> {
    const entry = this.entries.get(fileId)
    const file = this.workspace.getFile(fileId)
    if (!entry || !file) return
    const theirs = await this.fetchContent(fileId)
    const choice = await this.onConflict(file)
    const mine = entry.text
    if (choice === 'mine') {
      // 外の変更を上書きする
      entry.dirty = false
      await this.put(fileId, entry, mine, null)
      return
    }
    if (choice === 'saveAs' && file.kind !== 'pdf') {
      const copy = await this.create(file.kind, `${file.title}（自分の編集）`, mine)
      this.notify(`自分の編集を「${copy.title}」として保存しました。サイドバーの「未配置」から置けます`)
    }
    // 外の内容を使う
    if (theirs) {
      entry.text = normalize(theirs.text)
      entry.crlf = theirs.text.includes('\r\n')
      entry.version = versionOf(entry.text)
      entry.base = theirs.hash
    }
    entry.dirty = false
    this.emit(fileId)
  }

  // ---- 外からの変更 ----

  private connect(): void {
    if (this.disposed || typeof WebSocket === 'undefined') return
    const url = new URL(this.eventsUrl, location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    this.socket = socket
    socket.onopen = () => {
      // つながり直したら、切れていた間の変更を取り込む
      if (this.reconnectDelay > 500) void this.loadList().then(() => this.recheckAll())
      this.reconnectDelay = 500
    }
    socket.onmessage = (message) => {
      const event = JSON.parse(String(message.data)) as { type: string; file?: ServerFile }
      if (event.file) void this.onServerFile(event.file)
    }
    socket.onclose = () => {
      if (this.disposed) return
      setTimeout(() => this.connect(), this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
    }
  }

  private async recheckAll(): Promise<void> {
    for (const fileId of this.entries.keys()) {
      const file = this.workspace.getFile(fileId)
      if (file && file.kind !== 'pdf') await this.onServerFile(file as ServerFile)
    }
  }

  private async onServerFile(file: ServerFile): Promise<void> {
    this.workspace.applyServerFile(file)
    const entry = this.entries.get(file.id)
    if (!entry) {
      this.emit(file.id)
      return
    }
    if (file.missing || file.hash === entry.base) {
      this.emit(file.id)
      return
    }
    if (entry.dirty || entry.saving) {
      await this.resolveConflict(file.id)
      return
    }
    const theirs = await this.fetchContent(file.id)
    if (!theirs) return
    entry.text = normalize(theirs.text)
    entry.crlf = theirs.text.includes('\r\n')
    entry.version = versionOf(entry.text)
    entry.base = theirs.hash
    this.emit(file.id)
  }

  private emit(fileId: string): void {
    for (const listener of this.listeners) listener(fileId)
  }
}

function makeEntry(raw: string, hash: string): Entry {
  const text = normalize(raw)
  return { text, version: versionOf(text), base: hash, crlf: raw.includes('\r\n'), dirty: false, timer: null, saving: null }
}

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

// 本文の版（FNV-1a と長さ）。描画の画像キャッシュが、中身が変わったかどうかを見分けるのに使う
function versionOf(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36) + text.length.toString(36)
}
