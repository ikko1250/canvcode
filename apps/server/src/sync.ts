import type { IncomingMessage, ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { RecordStore } from './records.ts'

// レコードの同期（MAI-11、MAI-15）。/api/sync の WebSocket で、ブラウザと差分をやりとりする。
// - ブラウザ → サーバー：{ type: 'hello', since }（最後に受け取った変更番号。それより後の変更を返す）
//                        { type: 'push', seq, puts, deletes }（保存して ack を返し、ほかのタブに中継する）
// - サーバー → ブラウザ：{ type: 'changes', rev, records, deleted } / { type: 'ack', seq, rev } / { type: 'error', seq, message }
// 同じレコードへの同時の変更は、後から届いたものを採用する（MAI-15）

type ClientMessage =
  | { type: 'hello'; since: number }
  | { type: 'push'; seq: number; puts: unknown[]; deletes: unknown[] }

// 1 回に受け取る差分の上限（1 万ノードをまとめて貼り付けても足りる大きさ）
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024

export class SyncHub {
  private readonly store: RecordStore
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
  private readonly clients = new Set<WebSocket>()

  constructor(store: RecordStore) {
    this.store = store
    this.sockets.on('connection', (socket) => {
      this.clients.add(socket)
      socket.on('close', () => this.clients.delete(socket))
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
  }
}
