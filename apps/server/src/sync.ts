import type { IncomingMessage, ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { LIST_RECORD_TYPES, type RecordStore, type StoredRecord } from './records.ts'

// レコードの同期（MAI-11、MAI-15）。/api/sync の WebSocket で、ブラウザと差分をやりとりする。
// - ブラウザ → サーバー：{ type: 'hello', since, canvases? }（最後に受け取った変更番号。それより後の変更を返す。canvases は読んだ Canvas）
//                        { type: 'load', req, canvasId }（Canvas を読む。購読に足し、{ type: 'canvas', req, canvasId, rev, records } を返す）
//                        { type: 'push', seq, puts, deletes }（保存して ack を返し、ほかのタブに中継する）
//                        { type: 'presence', canvasId, viewport: { x, y, w, h } }（いま見ている Canvas と範囲。ワールド座標）
// - サーバー → ブラウザ：{ type: 'changes', rev, records, deleted, evicted?, citations?, origin? } / { type: 'ack', seq, rev } / { type: 'error', seq, message }
//   origin はサーバーの中で作った変更の出どころ（AI の編集なら { kind: 'ai', batchId, label, canvasId, count }）
// 保存した変更は onChange の購読者（AI の編集に使うサーバーの中のワークスペース。agent/host.ts）にも知らせる
// 同じレコードへの同時の変更は、後から届いたものを採用する（MAI-15）
//
// 開いた Canvas の分だけ読む（docs/lazy-canvas-loading-plan.md）：
// - タブごとに、読んだ Canvas を持つ。hello に canvases がなければ（古いタブ）、すべての Canvas を読んだものとして扱う
// - 中継する変更は、そのタブの分に絞る。一覧のレコード（Canvas・File・SourceAnchor）は全部、ノードと Binding は読んだ Canvas に
//   所属するものだけを records に入れる。ほかは id を evicted に入れる（読んだ Canvas から出ていったものを、手元から外すため）
// - 中継する変更は、保存したあとの changesSince から作る。子孫の所属の付け直しや、消した Canvas の中身も一緒に届く
// - 引用ノートのつながり（citations）は、読んだ Canvas によらず全部のタブに配る
// WebSocket は送った順に届き、ここは 1 本のスレッドで動くので、load の応答より前の変更は応答に入り、後の変更は changes で届く

// 保存した変更（records は保存したレコード、deleted は消した id）
export type ChangeListener = (records: unknown[], deleted: string[]) => void

// ユーザーがいま見ている所（タブごと。メモリにだけ持ち、タブを閉じたら捨てる）。AI のツールの既定に使う
export interface Presence {
  canvasId: string
  viewport: { x: number; y: number; w: number; h: number }
  // 最後に知らせてきた時刻
  at: number
}

// 引用ノートのつながり。anchorId が null なら、そのノートは引用していない（つながりを外す）
export interface CitationLink {
  noteId: string
  anchorId: string | null
  canvasId: string | null
  // 一覧に出す文字（メモか引用の 1 行目。先頭 CITATION_HEAD_LENGTH 文字）
  head: string
}

export const CITATION_HEAD_LENGTH = 64

type ClientMessage =
  | { type: 'hello'; since: number; canvases?: unknown }
  | { type: 'load'; req: unknown; canvasId: unknown }
  | { type: 'push'; seq: number; puts: unknown[]; deletes: unknown[] }
  | { type: 'presence'; canvasId: unknown; viewport: unknown }

// タブの読んだ Canvas（all はすべて）
type Scope = Set<string> | 'all'

// 1 回に受け取る差分の上限（1 万ノードをまとめて貼り付けても足りる大きさ）
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024

const LIST_TYPES = new Set<string>(LIST_RECORD_TYPES)

// 中継する変更（所属の付いたレコード）
interface Outgoing {
  rev: number
  records: StoredRecord[]
  canvasIds: (string | null)[]
  deleted: string[]
}

export class SyncHub {
  private readonly store: RecordStore
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
  private readonly clients = new Map<WebSocket, Scope>()
  private readonly listeners = new Set<ChangeListener>()
  private readonly presences = new Map<WebSocket, Presence>()

  constructor(store: RecordStore) {
    this.store = store
    this.sockets.on('connection', (socket) => {
      this.clients.set(socket, 'all')
      socket.on('close', () => {
        this.clients.delete(socket)
        this.presences.delete(socket)
      })
      socket.on('message', (data) => this.receive(socket, String(data)))
    })
  }

  get server(): WebSocketServer {
    return this.sockets
  }

  // GET /api/records：すべてのレコード。?canvas=<id>（いくつでも）なら、一覧のレコードとその Canvas の分と、引用のつながり。
  // ?file=<id> なら、その File の持ち主の Canvas も、?root ならルートも読む。見つからない・ゴミ箱の中の Canvas は、ルートに替える。
  // 読んだ Canvas を canvases で返す（最初のものが開く Canvas）
  // GET /api/records/<id>/canvas：レコードの所属する Canvas（{ canvasId }。所属がなければ null）
  handle(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    const owner = /^\/api\/records\/([^/]+)\/canvas$/.exec(path)
    if (path !== '/api/records' && !owner) return false
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    if (owner) {
      let id = ''
      try {
        id = decodeURIComponent(owner[1])
      } catch {
        // 読めない id は、ないものとして扱う
      }
      sendJson(res, 200, { canvasId: this.store.canvasOf(id) })
      return true
    }
    const params = new URL(req.url ?? '/', 'http://localhost').searchParams
    const requested = params.getAll('canvas')
    const fileId = params.get('file')
    if (requested.length === 0 && !fileId && !params.has('root')) {
      sendJson(res, 200, this.store.load())
      return true
    }
    const usable = (id: string | null) => {
      const canvas = id ? this.store.get(id) : undefined
      return canvas?.typeName === 'canvas' && canvas.deletedAt === null ? canvas.id : this.store.rootCanvasId
    }
    const canvases = new Set(requested.map(usable))
    if (fileId) {
      const file = this.store.get(fileId)
      canvases.add(usable(typeof file?.parentCanvasId === 'string' ? file.parentCanvasId : null))
    }
    if (params.has('root')) canvases.add(this.store.rootCanvasId)
    const loaded = this.store.loadScoped([...canvases])
    sendJson(res, 200, { ...loaded, canvases: [...canvases], citations: this.citations() })
    return true
  }

  // 保存した変更を受け取る（購読をやめる関数を返す）
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // いちばん最近に見ている所を知らせてきたタブのもの（つながっているタブだけ）
  latestPresence(): Presence | null {
    // 知らせてきた順に並べている（最後のものがいちばん新しい）
    let latest: Presence | null = null
    for (const presence of this.presences.values()) latest = presence
    return latest
  }

  // サーバーの中で保存した変更（旧データの取り込み・AI の編集）を、開いているすべてのタブに知らせる。
  // rev は保存した変更番号。その変更で一緒に変わったもの（子孫の所属の付け直し、消した Canvas の中身）も足して送る。
  // options.except の購読者（変更を作った本人）には知らせない
  broadcast(
    rev: number,
    records: unknown[],
    extra: Record<string, unknown> = {},
    options: { deleted?: string[]; except?: ChangeListener } = {},
  ): void {
    const outgoing = this.withCascade(rev, records as StoredRecord[], options.deleted ?? [])
    this.relay(outgoing, extra, null)
    this.emit(outgoing.records, outgoing.deleted, options.except)
  }

  // 引用ノートのつながり（すべて）
  citations(): CitationLink[] {
    return this.store.quoteCards().map(({ record, canvasId }) => citationLink(record, canvasId))
  }

  private emit(records: unknown[], deleted: string[], except?: ChangeListener): void {
    for (const listener of this.listeners) {
      if (listener === except) continue
      try {
        listener(records, deleted)
      } catch (error) {
        console.error('a change listener failed', error)
      }
    }
  }

  // 渡された変更に、同じ変更番号で保存された、渡されていないもの（一緒に変わったもの）を足す。所属は保存してあるものを使う
  private withCascade(rev: number, records: StoredRecord[], deleted: string[]): Outgoing {
    const saved = this.store.changesSince(rev - 1)
    const canvasOf = new Map<string, string | null>()
    for (const [i, record] of saved.records.entries()) canvasOf.set(record.id, saved.canvasIds[i])
    const gone = new Set([...deleted, ...saved.deleted])
    const out: Outgoing = { rev, records: [], canvasIds: [], deleted: [...gone] }
    const seen = new Set<string>()
    for (const record of [...records, ...saved.records]) {
      if (!record || typeof record.id !== 'string' || seen.has(record.id) || gone.has(record.id)) continue
      seen.add(record.id)
      out.records.push(record)
      out.canvasIds.push(canvasOf.has(record.id) ? canvasOf.get(record.id)! : this.store.canvasOf(record.id))
    }
    return out
  }

  // 変更を、タブごとに絞って送る（except のタブには送らない）
  private relay(outgoing: Outgoing, extra: Record<string, unknown>, except: WebSocket | null): void {
    const citations = citationsOf(outgoing)
    for (const [client, scope] of this.clients) {
      if (client === except || client.readyState !== client.OPEN) continue
      client.send(JSON.stringify({ type: 'changes', ...scoped(outgoing, scope), ...(citations.length ? { citations } : {}), ...extra }))
    }
  }

  private receive(socket: WebSocket, text: string): void {
    let message: ClientMessage
    try {
      message = JSON.parse(text) as ClientMessage
    } catch {
      return
    }
    if (message.type === 'hello') {
      const since = Number.isFinite(message.since) ? message.since : 0
      const scope: Scope = Array.isArray(message.canvases) ? new Set(message.canvases.filter((id): id is string => typeof id === 'string')) : 'all'
      this.clients.set(socket, scope)
      const changes = this.store.changesSince(since)
      const citations = citationsOf(changes)
      socket.send(JSON.stringify({ type: 'changes', ...scoped(changes, scope), ...(citations.length ? { citations } : {}) }))
      return
    }
    if (message.type === 'load') {
      if (typeof message.canvasId !== 'string') return
      const scope = this.clients.get(socket)
      if (scope && scope !== 'all') scope.add(message.canvasId)
      socket.send(JSON.stringify({ type: 'canvas', req: message.req, canvasId: message.canvasId, rev: this.store.rev, records: this.store.recordsOfCanvas(message.canvasId) }))
      return
    }
    if (message.type === 'presence') {
      const v = message.viewport as Record<string, unknown> | null
      const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
      if (typeof message.canvasId !== 'string' || !v || ![v.x, v.y, v.w, v.h].every(finite)) return
      const viewport = { x: v.x as number, y: v.y as number, w: Math.max(0, v.w as number), h: Math.max(0, v.h as number) }
      this.presences.delete(socket)
      this.presences.set(socket, { canvasId: message.canvasId, viewport, at: Date.now() })
      return
    }
    if (message.type !== 'push') return
    const puts = Array.isArray(message.puts) ? message.puts : []
    const deletes = Array.isArray(message.deletes) ? message.deletes : []
    let rev: number
    try {
      rev = this.store.apply(puts, deletes)
    } catch (error) {
      console.error('failed to save changes', error)
      socket.send(JSON.stringify({ type: 'error', seq: message.seq, message: error instanceof Error ? error.message : String(error) }))
      return
    }
    const outgoing = this.withCascade(rev, puts as StoredRecord[], deletes.filter((id): id is string => typeof id === 'string'))
    // 先に中継してから応答する（送ったタブにとって、ack の変更番号より前の変更はすべて届いていることになる）。
    // 送ったタブにも、送っていない分（一緒に変わったもの）は届ける
    this.relay(outgoing, {}, socket)
    const sent = new Set(puts.map((record) => (record as StoredRecord | null)?.id))
    const sentDeleted = new Set(deletes)
    const own: Outgoing = { rev, records: [], canvasIds: [], deleted: outgoing.deleted.filter((id) => !sentDeleted.has(id)) }
    for (const [i, record] of outgoing.records.entries()) {
      if (sent.has(record.id)) continue
      own.records.push(record)
      own.canvasIds.push(outgoing.canvasIds[i])
    }
    if (own.records.length > 0 || own.deleted.length > 0) {
      const scope = this.clients.get(socket) ?? 'all'
      socket.send(JSON.stringify({ type: 'changes', ...scoped(own, scope) }))
    }
    socket.send(JSON.stringify({ type: 'ack', seq: message.seq, rev }))
    this.emit(outgoing.records, outgoing.deleted)
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

// タブの分に絞る。読んでいない Canvas のノードと Binding（と、所属のわからないもの）は evicted に入れる
function scoped(changes: Outgoing, scope: Scope): { rev: number; records: StoredRecord[]; deleted: string[]; evicted?: string[] } {
  if (scope === 'all') return { rev: changes.rev, records: changes.records, deleted: changes.deleted }
  const records: StoredRecord[] = []
  const evicted: string[] = []
  for (const [i, record] of changes.records.entries()) {
    const canvasId = changes.canvasIds[i]
    if (LIST_TYPES.has(record.typeName) || (canvasId !== null && scope.has(canvasId))) records.push(record)
    else evicted.push(record.id)
  }
  return { rev: changes.rev, records, deleted: changes.deleted, ...(evicted.length ? { evicted } : {}) }
}

// 変わった引用ノートのつながり（消したものは deleted で伝わる）
function citationsOf(changes: Outgoing): CitationLink[] {
  const links: CitationLink[] = []
  for (const [i, record] of changes.records.entries()) {
    if (record.typeName === 'node' && record.type === 'quote-card') links.push(citationLink(record, changes.canvasIds[i]))
  }
  return links
}

export function citationLink(record: StoredRecord, canvasId: string | null): CitationLink {
  const props = (record.props ?? {}) as { anchorId?: unknown; memo?: unknown; quote?: unknown }
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  const head = (text(props.memo) || text(props.quote) || '（図）').split('\n')[0].slice(0, CITATION_HEAD_LENGTH)
  return { noteId: record.id, anchorId: typeof props.anchorId === 'string' && props.anchorId ? props.anchorId : null, canvasId, head }
}
