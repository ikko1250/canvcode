import type { WorkspaceRecord } from '@canvcode/core'
import type { CitationLink, Workspace } from './workspace.ts'

// サーバーとのレコードの同期（MAI-11、MAI-13、MAI-15）。
// - 開くとき：GET /api/records でワークスペースのレコードをまとめて読み、履歴に入れずに当てる
// - 自分の操作（Undo・Redo を含む）で確定した差分を、少し待ってまとめて /api/sync に送る。
//   応答（ack）が来るまでは手元に持っておき、切れたら、つなぎ直したときに送り直す
// - ほかのタブの変更は、履歴に入れずに当てる。まだ送っていない（応答のない）レコードへの変更は当てない（自分のほうが新しい）
// - ドラッグや文字の編集の途中（トランザクションが開いている間）に届いた変更は、終わってから当てる
// - AI（MCP の edit_canvas）がサーバーで行った変更は origin: { kind: 'ai' } 付きで届く。onAgentChange で画面に知らせる。
//   AI が PDF を取り込んだときは、その Asset（assets）も一緒に届く。レコードを当てる前に onAssets で登録する
// - いま見ている Canvas と範囲（reportPresence）を、カメラが止まってから送る。AI のツールが、ユーザーの見ている所を既定にする
// - 開いた Canvas の分だけ読む（docs/lazy-canvas-loading-plan.md）。最初の読み込みに canvases があれば、一覧のレコード
//   （Canvas・File・SourceAnchor）と、その Canvas のノードと Binding だけが届いている。ほかの Canvas は ensureCanvas で読む
//   （WebSocket の load）。読んだ Canvas は hello で伝え、サーバーはその分の変更だけを送る。読んだ Canvas から出ていったものは
//   evicted で届き、手元から外す。canvases がなければ（古いサーバー）、すべてを読んだものとして扱う
// - 手元で作った Canvas は、作ったときに読んだ Canvas に入れる（ほかのタブで足した中身も届くように）
// - 引用ノートのつながり（citations）は、読んだ Canvas によらず届く。ワークスペースの引用の索引に足す

export interface InitialRecords {
  rootCanvasId: string
  rev: number
  records: WorkspaceRecord[]
  // 読んだ Canvas（なければ、すべてを読んでいる）。最初のものが、開いた Canvas
  canvases?: string[]
  // 引用ノートのつながり（すべて。canvases があるときだけ）
  citations?: CitationLink[]
}

// 開くときに読むもの：Canvas（なければルート）か、File（その持ち主の Canvas）
export type LoadTarget = { canvasId?: string; fileId?: string }

export type SyncStatus = 'saved' | 'saving' | 'offline'

// AI がサーバーで行った編集（1 回の edit_canvas）。batchId で取り消せる（POST /api/agent-ops/<batchId>/undo）
export interface AgentChange {
  batchId: string
  label: string
  canvasId: string
  // 変わったノードの数
  count: number
}

// サーバーが保存した Asset（GET /api/assets の一覧の 1 つと同じ形）
export interface RemoteAsset {
  hash: string
  mime: string
  size: number
  width: number
  height: number
  variants: number[]
}

// 画面に見えている範囲（ワールド座標）
export interface Viewport {
  x: number
  y: number
  w: number
  h: number
}

export interface SyncOptions {
  baseUrl?: string
  // 保存の状態が変わったとき（画面に出す）
  onStatus?: (status: SyncStatus) => void
  // 保存できなかったとき
  notify?: (message: string) => void
  // 何ミリ秒待ってまとめて送るか
  delayMs?: number
  // サーバーが旧データを取り込んだ（その変更は、このあと届く changes と一緒に当たる）
  onImported?: (report: unknown) => void
  // AI の編集が届いたとき（当てたあとで呼ぶ）
  onAgentChange?: (change: AgentChange) => void
  // 変更と一緒に、まだ一覧にないかもしれない Asset が届いたとき（当てる前に呼ぶ）
  onAssets?: (assets: RemoteAsset[]) => void
  // 見ている範囲を、カメラが止まってから何ミリ秒後に送るか
  presenceDelayMs?: number
}

const SEND_DELAY_MS = 100
const PRESENCE_DELAY_MS = 500
const RECONNECT_MAX_MS = 10_000

// AI の編集を取り消すようサーバーに頼む。取り消せなければ（そのあと変わった・古すぎる）理由を投げる
export async function undoAgentChange(batchId: string, baseUrl = ''): Promise<void> {
  const response = await fetch(`${baseUrl}/api/agent-ops/${encodeURIComponent(batchId)}/undo`, { method: 'POST' })
  if (response.ok) return
  const body = (await response.json().catch(() => ({}))) as { error?: string }
  throw new Error(body.error ?? `undo failed: ${response.status}`)
}

// ワークスペースのレコードを読む。target を渡すと、一覧のレコードと、その Canvas の分だけを読む
// （Canvas が見つからない・ゴミ箱の中ならルート。File なら持ち主の Canvas）。渡さなければすべて
export async function loadRecords(baseUrl = '', target?: LoadTarget): Promise<InitialRecords> {
  const params = new URLSearchParams()
  if (target?.canvasId) params.append('canvas', target.canvasId)
  if (target?.fileId) params.set('file', target.fileId)
  if (target && !target.canvasId && !target.fileId) params.set('root', '')
  const query = target ? `?${params}` : ''
  const response = await fetch(`${baseUrl}/api/records${query}`)
  if (!response.ok) throw new Error(`Failed to load records: ${response.status}`)
  return (await response.json()) as InitialRecords
}

// レコードの所属する Canvas をサーバーに聞く（手元にないノードの Canvas。所属がなければ null）
export async function fetchCanvasOf(id: string, baseUrl = ''): Promise<string | null> {
  const response = await fetch(`${baseUrl}/api/records/${encodeURIComponent(id)}/canvas`)
  if (!response.ok) throw new Error(`Failed to read the canvas of a record: ${response.status}`)
  return ((await response.json()) as { canvasId: string | null }).canvasId
}

// id → 送る値（null は削除）
type Outbox = Map<string, WorkspaceRecord | null>

export class SyncClient {
  private readonly workspace: Workspace
  private readonly options: Required<Omit<SyncOptions, 'baseUrl'>> & { baseUrl: string }
  private rev: number
  private socket: WebSocket | null = null
  private open = false
  private everOpened = false
  private outbox: Outbox = new Map()
  private readonly inflight = new Map<number, Outbox>()
  private seq = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 500
  private disposed = false
  // トランザクションの途中に届いた、まだ当てていない変更
  private deferred: { records: WorkspaceRecord[]; deleted: string[]; done?: () => void }[] = []
  private status: SyncStatus = 'saved'
  private readonly unlisten: () => void
  // 見ている所（最後に知らされたもの）と、最後に送ったもの（同じなら送らない）
  private presence: { canvasId: string; viewport: Viewport } | null = null
  private presenceSent: string | null = null
  private presenceTimer: ReturnType<typeof setTimeout> | null = null
  // 読んだ Canvas（all はすべて）と、読んでいる途中の Canvas
  private loaded: Set<string> | 'all'
  private readonly loading = new Map<string, { promise: Promise<void>; resolve: () => void; sent: boolean }>()

  constructor(workspace: Workspace, initial: InitialRecords, options: SyncOptions = {}) {
    this.workspace = workspace
    this.options = {
      baseUrl: options.baseUrl ?? '',
      onStatus: options.onStatus ?? (() => {}),
      notify: options.notify ?? ((message) => console.warn(message)),
      delayMs: options.delayMs ?? SEND_DELAY_MS,
      onImported: options.onImported ?? (() => {}),
      onAgentChange: options.onAgentChange ?? (() => {}),
      onAssets: options.onAssets ?? (() => {}),
      presenceDelayMs: options.presenceDelayMs ?? PRESENCE_DELAY_MS,
    }
    this.rev = initial.rev
    this.loaded = initial.canvases ? new Set(initial.canvases) : 'all'
    this.applyRemote(initial.records, [])
    if (initial.citations) workspace.setCitationLinks(initial.citations)
    this.unlisten = workspace.store.listen((event) => {
      if (event.phase === 'commit') {
        // サーバー・ほかのタブから届いた変更（File の情報を含む）は送り返さない
        if (event.options.source !== 'remote') {
          for (const [id, change] of event.patch) {
            this.outbox.set(id, change.after ?? null)
            // 手元で作った Canvas は、読んだ Canvas に入れる（中身は空。ほかのタブで足したものも届くように、サーバーにも伝える）
            if (!change.before && change.after?.typeName === 'canvas') this.markLoaded(id)
          }
          this.schedule()
        }
        // ほかの購読者がこの知らせを受け取り終えてから当てる（知らせの順番が入れ替わらないように）
        if (this.deferred.length > 0) queueMicrotask(() => this.applyDeferred())
      }
    })
    this.connect()
  }

  // あとから知らせる先を決める（画面を作る前に同期を始めるため）
  setHandlers(handlers: Pick<SyncOptions, 'notify' | 'onImported' | 'onAgentChange' | 'onAssets'>): void {
    if (handlers.notify) this.options.notify = handlers.notify
    if (handlers.onImported) this.options.onImported = handlers.onImported
    if (handlers.onAgentChange) this.options.onAgentChange = handlers.onAgentChange
    if (handlers.onAssets) this.options.onAssets = handlers.onAssets
  }

  // つながっていたのに、切れているか（読んでいない Canvas を、つながるまで待たずに断るとき。最初につながる前は false）
  get disconnected(): boolean {
    return this.everOpened && !this.open
  }

  // この Canvas のノードを読んであるか
  isLoaded(canvasId: string): boolean {
    return this.loaded === 'all' || this.loaded.has(canvasId)
  }

  // Canvas のノードを読む（読んであれば何もしない）。同じ Canvas への呼び出しは 1 つにまとめる。
  // つながっていなければ、つながって読み終えるまで待つ
  ensureCanvas(canvasId: string): Promise<void> {
    if (this.isLoaded(canvasId)) return Promise.resolve()
    const pending = this.loading.get(canvasId)
    if (pending) return pending.promise
    let resolve!: () => void
    const promise = new Promise<void>((done) => (resolve = done))
    const entry = { promise, resolve, sent: false }
    this.loading.set(canvasId, entry)
    this.sendLoad(canvasId)
    return promise
  }

  private markLoaded(canvasId: string): void {
    if (this.isLoaded(canvasId) || this.loaded === 'all') return
    this.loaded.add(canvasId)
    if (this.open && this.socket) this.socket.send(JSON.stringify({ type: 'load', req: null, canvasId }))
  }

  private sendLoad(canvasId: string): void {
    const entry = this.loading.get(canvasId)
    if (!entry || !this.open || !this.socket) return
    entry.sent = true
    this.socket.send(JSON.stringify({ type: 'load', req: canvasId, canvasId }))
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

  // いま見ている Canvas と範囲を知らせる。Canvas を移ったときはすぐ、カメラが動いている間は止まってから送る。
  // 変わっていなければ送らない。つなぎ直したら送り直す
  reportPresence(canvasId: string, viewport: Viewport): void {
    const moved = this.presence?.canvasId !== canvasId
    const round = (value: number) => Math.round(value)
    this.presence = { canvasId, viewport: { x: round(viewport.x), y: round(viewport.y), w: round(viewport.w), h: round(viewport.h) } }
    if (this.presenceTimer !== null) clearTimeout(this.presenceTimer)
    this.presenceTimer = null
    if (moved) return this.sendPresence()
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null
      this.sendPresence()
    }, this.options.presenceDelayMs)
  }

  private sendPresence(): void {
    if (!this.presence || !this.open || !this.socket) return
    const text = JSON.stringify({ type: 'presence', ...this.presence })
    if (text === this.presenceSent) return
    this.presenceSent = text
    this.socket.send(text)
  }

  dispose(): void {
    this.disposed = true
    if (this.presenceTimer !== null) clearTimeout(this.presenceTimer)
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
      this.everOpened = true
      this.reconnectDelay = 500
      // 切れている間の変更をもらってから、手元の変更を送る。読んだ Canvas も伝える（その分の変更だけが届く）
      socket.send(JSON.stringify({ type: 'hello', since: this.rev, ...(this.loaded === 'all' ? {} : { canvases: [...this.loaded] }) }))
      // 読んでいる途中だった Canvas を、頼み直す
      for (const canvasId of this.loading.keys()) this.sendLoad(canvasId)
      this.presenceSent = null
      this.sendPresence()
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
    let message: {
      type: string
      seq?: number
      rev?: number
      records?: WorkspaceRecord[]
      deleted?: string[]
      evicted?: string[]
      citations?: CitationLink[]
      canvasId?: string
      message?: string
      imported?: unknown
      assets?: RemoteAsset[]
      origin?: { kind?: unknown; batchId?: unknown; label?: unknown; canvasId?: unknown; count?: unknown }
    }
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (message.type === 'changes') {
      this.rev = Math.max(this.rev, message.rev ?? 0)
      if (Array.isArray(message.assets) && message.assets.length > 0) this.options.onAssets(message.assets)
      const deleted = message.deleted ?? []
      const citations = message.citations ?? []
      // レコードを当てたあとで（トランザクションの途中なら、終わって当ててから）、消えたノートのつながりを外し、変わったつながりを当てる。
      // 手元から外したノートのつながりは、外したときに消えるので、先に当てると消えてしまう（読んだ Canvas から出ていったノート）
      this.applyRemote(message.records ?? [], [...deleted, ...(message.evicted ?? [])], () => {
        this.workspace.forgetCitationLinks(deleted)
        if (citations.length) this.workspace.setCitationLinks(citations)
      })
      if (message.imported) this.options.onImported(message.imported)
      const origin = message.origin
      if (origin?.kind === 'ai' && typeof origin.batchId === 'string') {
        this.options.onAgentChange({
          batchId: origin.batchId,
          label: typeof origin.label === 'string' ? origin.label : '',
          canvasId: typeof origin.canvasId === 'string' ? origin.canvasId : '',
          count: typeof origin.count === 'number' ? origin.count : 0,
        })
      }
      // hello への応答のあとで、手元の変更を送る
      this.send()
    } else if (message.type === 'canvas' && typeof message.canvasId === 'string') {
      // 読んだ Canvas の中身。読む前に届いた変更は、この中に入っている
      const canvasId = message.canvasId
      this.rev = Math.max(this.rev, message.rev ?? 0)
      // 当て終えてから（トランザクションの途中なら、終わって当ててから）、読んだことにして知らせる
      this.applyRemote(message.records ?? [], [], () => {
        if (this.loaded !== 'all') this.loaded.add(canvasId)
        const entry = this.loading.get(canvasId)
        this.loading.delete(canvasId)
        entry?.resolve()
      })
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

  // done は当て終えたら呼ぶ
  private applyRemote(records: WorkspaceRecord[], deleted: string[], done?: () => void): void {
    // 前に後回しにした変更があれば、その後ろに並べる（届いた順に当てる）
    if (this.workspace.store.activeTransaction || this.deferred.length > 0) {
      this.deferred.push({ records, deleted, done })
      // トランザクションがなければ、並べた順にすぐ当てる。取り消し（Esc）で終わったトランザクションは知らせが来ないので、少し待って確かめ直す
      if (this.workspace.store.activeTransaction) this.retryDeferred()
      else this.applyDeferred()
      return
    }
    if (records.length === 0 && deleted.length === 0) return done?.()
    const mine = new Set<string>(this.outbox.keys())
    for (const batch of this.inflight.values()) for (const id of batch.keys()) mine.add(id)
    this.workspace.store.transact(
      'remote',
      (tx) => {
        // 古い版のノード（版を上げる前に保存したもの）は、今の形にしてから入れる（MAI-74）。保存し直すのは、次に変えたとき。
        // 知らない型のノードは入れない（Workspace.accepts）
        for (const record of records) if (!mine.has(record.id) && this.workspace.accepts(record)) tx.put(this.workspace.upgrade(record))
        for (const id of deleted) if (!mine.has(id)) tx.remove(id)
      },
      { history: 'ignore', source: 'remote' },
    )
    done?.()
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
    for (const { records, deleted, done } of deferred) this.applyRemote(records, deleted, done)
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
