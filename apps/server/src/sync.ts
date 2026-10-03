import type { IncomingMessage, ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { RecordStore } from './records.ts'

// レコードの同期（MAI-11、MAI-15）。/api/sync の WebSocket で、ブラウザと差分をやりとりする。
// - ブラウザ → サーバー：{ type: 'hello', since }（最後に受け取った変更番号。それより後の変更を返す）
//                        { type: 'push', seq, puts, deletes }（保存して ack を返し、ほかのタブに中継する）
//                        { type: 'presence', canvasId, viewport: { x, y, w, h } }（いま見ている Canvas と範囲。ワールド座標）
// - サーバー → ブラウザ：{ type: 'changes', rev, records, deleted, origin? } / { type: 'ack', seq, rev } / { type: 'error', seq, message }
//   origin はサーバーの中で作った変更の出どころ（AI の編集なら { kind: 'ai', batchId, label, canvasId, count }）
// 保存した変更は onChange の購読者（AI の編集に使うサーバーの中のワークスペース。agent/host.ts）にも知らせる
// 同じレコードへの同時の変更は、後から届いたものを採用する（MAI-15）

// 保存した変更（records は保存したレコード、deleted は消した id）
export type ChangeListener = (records: unknown[], deleted: string[]) => void

// ユーザーがいま見ている所（タブごと。メモリにだけ持ち、タブを閉じたら捨てる）。AI のツールの既定に使う
export interface Presence {
  canvasId: string
  viewport: { x: number; y: number; w: number; h: number }
  // 最後に知らせてきた時刻
  at: number
}

type ClientMessage =
  | { type: 'hello'; since: number }
  | { type: 'push'; seq: number; puts: unknown[]; deletes: unknown[] }
  | { type: 'presence'; canvasId: unknown; viewport: unknown }

// 1 回に受け取る差分の上限（1 万ノードをまとめて貼り付けても足りる大きさ）
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024

export class SyncHub {
  private readonly store: RecordStore
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
  private readonly clients = new Set<WebSocket>()
  private readonly listeners = new Set<ChangeListener>()
  private readonly presences = new Map<WebSocket, Presence>()

  constructor(store: RecordStore) {
    this.store = store
    this.sockets.on('connection', (socket) => {
      this.clients.add(socket)
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

  // GET /api/records：すべてのレコード（画面を開いたとき）
  handle(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    if (path !== '/api/records') return false
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return true
    }
    const body = JSON.stringify(this.store.load())
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
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
  // options.except の購読者（変更を作った本人）には知らせない
  broadcast(
    rev: number,
    records: unknown[],
    extra: Record<string, unknown> = {},
    options: { deleted?: string[]; except?: ChangeListener } = {},
  ): void {
    const deleted = options.deleted ?? []
    const message = JSON.stringify({ type: 'changes', rev, records, deleted, ...extra })
    for (const client of this.clients) if (client.readyState === client.OPEN) client.send(message)
    this.emit(records, deleted, options.except)
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

  private receive(socket: WebSocket, text: string): void {
    let message: ClientMessage
    try {
      message = JSON.parse(text) as ClientMessage
    } catch {
      return
    }
    if (message.type === 'hello') {
      const since = Number.isFinite(message.since) ? message.since : 0
      socket.send(JSON.stringify({ type: 'changes', ...this.store.changesSince(since) }))
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
    // 先に中継してから応答する（送ったタブにとって、ack の変更番号より前の変更はすべて届いていることになる）
    const relay = JSON.stringify({ type: 'changes', rev, records: puts, deleted: deletes })
    for (const client of this.clients) if (client !== socket && client.readyState === client.OPEN) client.send(relay)
    socket.send(JSON.stringify({ type: 'ack', seq: message.seq, rev }))
    this.emit(puts, deletes.filter((id): id is string => typeof id === 'string'))
  }
}
