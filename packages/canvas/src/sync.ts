import type { WorkspaceRecord } from '@canvcode/core'
import type { Workspace } from './workspace.ts'

// サーバーとのレコードの同期（MAI-11、MAI-13、MAI-15）。
// - 開くとき：GET /api/records でワークスペースのレコードをまとめて読み、履歴に入れずに当てる
// - 自分の操作（Undo・Redo を含む）で確定した差分を、少し待ってまとめて /api/sync に送る。
//   応答（ack）が来るまでは手元に持っておき、切れたら、つなぎ直したときに送り直す
// - ほかのタブの変更は、履歴に入れずに当てる。まだ送っていない（応答のない）レコードへの変更は当てない（自分のほうが新しい）
// - ドラッグや文字の編集の途中（トランザクションが開いている間）に届いた変更は、終わってから当てる

export interface InitialRecords {
  rootCanvasId: string
  rev: number
  records: WorkspaceRecord[]
}

export type SyncStatus = 'saved' | 'saving' | 'offline'

export interface SyncOptions {
  baseUrl?: string
  // 保存の状態が変わったとき（画面に出す）
  onStatus?: (status: SyncStatus) => void
  // 保存できなかったとき
  notify?: (message: string) => void
  // 何ミリ秒待ってまとめて送るか
  delayMs?: number
}

const SEND_DELAY_MS = 100
const RECONNECT_MAX_MS = 10_000

// ワークスペースのレコードをまとめて読む
export async function loadRecords(baseUrl = ''): Promise<InitialRecords> {
  const response = await fetch(`${baseUrl}/api/records`)
  if (!response.ok) throw new Error(`Failed to load records: ${response.status}`)
  return (await response.json()) as InitialRecords
}

// id → 送る値（null は削除）
type Outbox = Map<string, WorkspaceRecord | null>

export class SyncClient {
  private readonly workspace: Workspace
  private readonly options: Required<Omit<SyncOptions, 'baseUrl'>> & { baseUrl: string }
  private rev: number
  private socket: WebSocket | null = null
  private open = false
  private outbox: Outbox = new Map()
  private readonly inflight = new Map<number, Outbox>()
  private seq = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 500
  private disposed = false
  // トランザクションの途中に届いた、まだ当てていない変更
  private deferred: { records: WorkspaceRecord[]; deleted: string[] }[] = []
  private status: SyncStatus = 'saved'
  private readonly unlisten: () => void

  constructor(workspace: Workspace, initial: InitialRecords, options: SyncOptions = {}) {
    this.workspace = workspace
    this.options = {
      baseUrl: options.baseUrl ?? '',
      onStatus: options.onStatus ?? (() => {}),
      notify: options.notify ?? ((message) => console.warn(message)),
      delayMs: options.delayMs ?? SEND_DELAY_MS,
    }
    this.rev = initial.rev
    this.applyRemote(initial.records, [])
    this.unlisten = workspace.store.listen((event) => {
      if (event.phase === 'commit') {
        // サーバー・ほかのタブから届いた変更（File の情報を含む）は送り返さない
        if (event.options.source !== 'remote') {
          for (const [id, change] of event.patch) this.outbox.set(id, change.after ?? null)
          this.schedule()
        }
        // ほかの購読者がこの知らせを受け取り終えてから当てる（知らせの順番が入れ替わらないように）
        if (this.deferred.length > 0) queueMicrotask(() => this.applyDeferred())
      }
    })
    this.connect()
  }

  // まだ保存が済んでいない変更があるか
  get pending(): boolean {
    return this.outbox.size > 0 || this.inflight.size > 0
  }

  // 待たずにすぐ送る（ページを閉じるときなど）
  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.send()
  }

  dispose(): void {
    this.disposed = true
    this.flush()
    this.unlisten()
    this.socket?.close()
  }

  private schedule(): void {
    this.setStatus('saving')
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.send()
    }, this.options.delayMs)
  }

  private send(): void {
    if (!this.open || !this.socket || this.outbox.size === 0) {
      this.updateStatus()
      return
    }
    const batch = this.outbox
    this.outbox = new Map()
    const seq = ++this.seq
    this.inflight.set(seq, batch)
    const puts: WorkspaceRecord[] = []
    const deletes: string[] = []
    for (const [id, record] of batch) {
      if (record) puts.push(record)
      else deletes.push(id)
    }
    this.socket.send(JSON.stringify({ type: 'push', seq, puts, deletes }))
  }

  private connect(): void {
    if (this.disposed || typeof WebSocket === 'undefined') return
    const base = this.options.baseUrl || location.origin
    const url = `${base.replace(/^http/, 'ws')}/api/sync`
    const socket = new WebSocket(url)
    this.socket = socket
    socket.onopen = () => {
      this.open = true
      this.reconnectDelay = 500
      // 切れている間の変更をもらってから、手元の変更を送る
      socket.send(JSON.stringify({ type: 'hello', since: this.rev }))
    }
    socket.onmessage = (message) => this.receive(String(message.data))
    socket.onclose = () => {
      this.open = false
      if (this.socket === socket) this.socket = null
      // 応答のなかった分は、送り直す（あとの変更のほうが新しいので、上書きしない）
      const seqs = [...this.inflight.keys()].sort((a, b) => b - a)
      for (const seq of seqs) {
        for (const [id, record] of this.inflight.get(seq)!) if (!this.outbox.has(id)) this.outbox.set(id, record)
      }
      this.inflight.clear()
      this.updateStatus()
      if (this.disposed) return
      setTimeout(() => this.connect(), this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
    }
  }

  private receive(text: string): void {
    let message: { type: string; seq?: number; rev?: number; records?: WorkspaceRecord[]; deleted?: string[]; message?: string }
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (message.type === 'changes') {
      this.rev = Math.max(this.rev, message.rev ?? 0)
      this.applyRemote(message.records ?? [], message.deleted ?? [])
      // hello への応答のあとで、手元の変更を送る
      this.send()
    } else if (message.type === 'ack' && message.seq !== undefined) {
      this.inflight.delete(message.seq)
      this.rev = Math.max(this.rev, message.rev ?? 0)
      this.updateStatus()
    } else if (message.type === 'error' && message.seq !== undefined) {
      // 保存を断られた変更は、送り直しても同じなので捨てる
      this.inflight.delete(message.seq)
      console.error('The server refused changes', message.message)
      this.options.notify('変更の一部を保存できませんでした。再読み込みすると、保存されている状態に戻ります')
      this.updateStatus()
    }
  }

  private applyRemote(records: WorkspaceRecord[], deleted: string[]): void {
    if (records.length === 0 && deleted.length === 0) return
    if (this.workspace.store.activeTransaction) {
      this.deferred.push({ records, deleted })
      // 取り消し（Esc）で終わったトランザクションは知らせが来ないので、少し待って確かめ直す
      this.retryDeferred()
      return
    }
    const mine = new Set<string>(this.outbox.keys())
    for (const batch of this.inflight.values()) for (const id of batch.keys()) mine.add(id)
    this.workspace.store.transact(
      'remote',
      (tx) => {
        for (const record of records) if (!mine.has(record.id)) tx.put(record)
        for (const id of deleted) if (!mine.has(id)) tx.remove(id)
      },
      { history: 'ignore', source: 'remote' },
    )
  }

  private retryTimer: ReturnType<typeof setTimeout> | null = null

  private retryDeferred(): void {
    if (this.retryTimer !== null) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.applyDeferred()
    }, 250)
  }

  private applyDeferred(): void {
    if (this.deferred.length === 0) return
    if (this.workspace.store.activeTransaction) {
      this.retryDeferred()
      return
    }
    const deferred = this.deferred
    this.deferred = []
    for (const { records, deleted } of deferred) this.applyRemote(records, deleted)
  }

  private updateStatus(): void {
    this.setStatus(!this.open && this.pending ? 'offline' : this.pending ? 'saving' : !this.open ? 'offline' : 'saved')
  }

  private readonly statusListeners = new Set<() => void>()

  // React からは useSyncExternalStore で読む
  getStatus = (): SyncStatus => this.status

  subscribeStatus = (listener: () => void): (() => void) => {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private setStatus(status: SyncStatus): void {
    if (status === this.status) return
    this.status = status
    this.options.onStatus(status)
    for (const listener of this.statusListeners) listener()
  }
}
