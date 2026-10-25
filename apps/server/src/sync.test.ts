import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { RecordStore } from './records.ts'
import { SyncHub } from './sync.ts'

// レコードの同期：タブごとの読んだ Canvas と、絞った中継（docs/lazy-canvas-loading-plan.md）

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-sync-'))
  const records = new RecordStore(dir)
  const hub = new SyncHub(records)
  const server: Server = createServer((req, res) => {
    if (!hub.handle(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) {
      res.writeHead(404)
      res.end()
    }
  })
  server.on('upgrade', (req, socket, head) => hub.server.handleUpgrade(req, socket, head, (ws) => hub.server.emit('connection', ws, req)))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `127.0.0.1:${(server.address() as AddressInfo).port}`
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.push(() => records.close())
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  cleanups.push(() => {
    for (const client of hub.server.clients) client.terminate()
  })
  return { records, hub, base }
}

// メッセージを順に受け取るタブ
async function connect(base: string) {
  const socket = new WebSocket(`ws://${base}/api/sync`)
  const inbox: Record<string, any>[] = []
  const waiters: (() => void)[] = []
  socket.on('message', (data) => {
    inbox.push(JSON.parse(String(data)))
    for (const waiter of waiters.splice(0)) waiter()
  })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return {
    send: (message: unknown) => socket.send(JSON.stringify(message)),
    // 次のメッセージ（type が合うもの）を待つ。合わないものは捨てる
    async next(type: string): Promise<Record<string, any>> {
      for (;;) {
        const index = inbox.findIndex((m) => m.type === type)
        if (index >= 0) return inbox.splice(0, index + 1).pop()!
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 2000)
          waiters.push(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
    },
    // ここまでに届いたメッセージ（往復を 1 回待ってから）
    async drain(): Promise<Record<string, any>[]> {
      socket.send(JSON.stringify({ type: 'load', req: 'drain', canvasId: 'canvas:none' }))
      await this.next('canvas')
      return inbox.splice(0)
    },
  }
}

const canvas = (id: string) => ({ typeName: 'canvas', id, title: id, parentCanvasId: null, ownerNodeId: null, createdAt: 0, updatedAt: 0, deletedAt: null, trash: null })
const node = (id: string, parentId: string, props: Record<string, unknown> = {}, type = 'geo') => ({ typeName: 'node', id, type, parentId, x: 0, y: 0, props })
const quote = (id: string, parentId: string, anchorId: string, memo = '') => node(id, parentId, { anchorId, memo, quote: '引用した文\n2 行目' }, 'quote-card')

describe('SyncHub', () => {
  it('reads the list records and the requested canvases over HTTP, with citations and the canvas of a record', async () => {
    const { records, base } = await setup()
    const root = records.rootCanvasId
    records.apply(
      [canvas('canvas:a'), canvas('canvas:b'), node('node:a', 'canvas:a'), node('node:b', 'canvas:b'), node('node:root', root), quote('node:q', 'canvas:b', 'anchor:1'),
        { typeName: 'file', id: 'file:1', parentCanvasId: 'canvas:b' }, { typeName: 'anchor', id: 'anchor:1', fileId: 'file:1' }],
      [],
    )
    const get = async (query: string) => (await fetch(`http://${base}/api/records${query}`)).json() as Promise<Record<string, any>>
    const ids = (body: Record<string, any>) => (body.records as { id: string }[]).map((r) => r.id).sort()

    const full = await get('')
    expect(ids(full)).toContain('node:b')
    expect(full.canvases).toBeUndefined()

    const scoped = await get('?canvas=canvas:a')
    expect(ids(scoped)).toEqual(['anchor:1', 'canvas:a', 'canvas:b', root, 'file:1', 'node:a'].sort())
    expect(scoped).toMatchObject({ rootCanvasId: root, rev: records.rev, canvases: ['canvas:a'] })
    expect(scoped.citations).toEqual([{ noteId: 'node:q', anchorId: 'anchor:1', canvasId: 'canvas:b', head: '引用した文' }])

    // File の持ち主の Canvas も読む
    expect((await get('?canvas=canvas:a&file=file:1')).canvases).toEqual(['canvas:a', 'canvas:b'])
    // ルート。見つからない・ゴミ箱の中の Canvas はルートに替える
    expect((await get('?root')).canvases).toEqual([root])
    records.apply([{ ...canvas('canvas:a'), deletedAt: 1 }], [])
    expect((await get('?canvas=canvas:a&canvas=canvas:none')).canvases).toEqual([root])

    expect(await (await fetch(`http://${base}/api/records/node:q/canvas`)).json()).toEqual({ canvasId: 'canvas:b' })
    expect(await (await fetch(`http://${base}/api/records/canvas:a/canvas`)).json()).toEqual({ canvasId: null })
  })

  it('relays to each tab only the changes of the canvases it has read, and evicts nodes that move out of them', async () => {
    const { records, base } = await setup()
    records.apply([canvas('canvas:a'), canvas('canvas:b'), node('node:group', 'canvas:a'), node('node:child', 'node:group')], [])
    const writer = await connect(base)
    writer.send({ type: 'hello', since: records.rev, canvases: ['canvas:a', 'canvas:b'] })
    await writer.next('changes')
    const reader = await connect(base)
    reader.send({ type: 'hello', since: records.rev, canvases: ['canvas:a'] })
    await reader.next('changes')
    // 古いタブ（canvases なし）は全部
    const legacy = await connect(base)
    legacy.send({ type: 'hello', since: records.rev })
    await legacy.next('changes')

    writer.send({ type: 'push', seq: 1, puts: [node('node:b', 'canvas:b'), node('node:a', 'canvas:a'), { ...canvas('canvas:a'), title: 'A' }], deletes: [] })
    await writer.next('ack')
    let changes = await reader.next('changes')
    expect(changes.records.map((r: { id: string }) => r.id).sort()).toEqual(['canvas:a', 'node:a'])
    expect(changes.evicted).toEqual(['node:b'])
    expect((await legacy.next('changes')).records).toHaveLength(3)

    // group を読んでいない Canvas へ移すと、子も一緒に外れる
    writer.send({ type: 'push', seq: 2, puts: [node('node:group', 'canvas:b')], deletes: [] })
    await writer.next('ack')
    changes = await reader.next('changes')
    expect(changes.records).toEqual([])
    expect(changes.evicted.sort()).toEqual(['node:child', 'node:group'])

    // load で読むと、その Canvas の今の中身が届き、そのあとの変更も届く
    reader.send({ type: 'load', req: 7, canvasId: 'canvas:b' })
    const loaded = await reader.next('canvas')
    expect(loaded).toMatchObject({ req: 7, canvasId: 'canvas:b', rev: records.rev })
    expect(loaded.records.map((r: { id: string }) => r.id).sort()).toEqual(['node:b', 'node:child', 'node:group'])
    writer.send({ type: 'push', seq: 3, puts: [{ ...node('node:child', 'node:group'), x: 5 }], deletes: [] })
    await writer.next('ack')
    expect((await reader.next('changes')).records).toEqual([expect.objectContaining({ id: 'node:child', x: 5 })])
  })

  it('sends the sender the records changed along with its push (moved descendants, contents of a deleted canvas)', async () => {
    const { records, base } = await setup()
    records.apply([canvas('canvas:a'), canvas('canvas:b'), node('node:group', 'canvas:a'), node('node:child', 'node:group'), node('node:gone', 'canvas:b')], [])
    const writer = await connect(base)
    writer.send({ type: 'hello', since: records.rev, canvases: ['canvas:a'] })
    await writer.next('changes')
    writer.send({ type: 'push', seq: 1, puts: [node('node:group', 'canvas:b')], deletes: ['canvas:b'] })
    const own = await writer.next('changes')
    expect(own.deleted.sort()).toEqual(['node:child', 'node:gone', 'node:group'])
    expect((await writer.next('ack')).seq).toBe(1)
  })

  it('reconnects with the changes after a revision, limited to the canvases read', async () => {
    const { records, base } = await setup()
    records.apply([canvas('canvas:a'), canvas('canvas:b')], [])
    const since = records.rev
    records.apply([node('node:a', 'canvas:a'), node('node:b', 'canvas:b'), quote('node:q', 'canvas:b', 'anchor:1', 'メモ')], ['node:old'])
    const tab = await connect(base)
    tab.send({ type: 'hello', since, canvases: ['canvas:a'] })
    const changes = await tab.next('changes')
    expect(changes.records.map((r: { id: string }) => r.id)).toEqual(['node:a'])
    expect(changes.evicted.sort()).toEqual(['node:b', 'node:q'])
    expect(changes.deleted).toEqual(['node:old'])
    // 引用のつながりは、読んでいない Canvas の分も届く
    expect(changes.citations).toEqual([{ noteId: 'node:q', anchorId: 'anchor:1', canvasId: 'canvas:b', head: 'メモ' }])
  })

  it('adds the records changed along with a server-side change to a broadcast, and tells the listeners', async () => {
    const { records, hub, base } = await setup()
    records.apply([canvas('canvas:a'), node('node:a', 'canvas:a'), node('node:b', 'node:a')], [])
    const tab = await connect(base)
    tab.send({ type: 'hello', since: records.rev, canvases: [] })
    await tab.next('changes')
    const heard: { records: unknown[]; deleted: string[] }[] = []
    hub.onChange((records, deleted) => heard.push({ records, deleted }))
    const rev = records.apply([], ['canvas:a'])
    hub.broadcast(rev, [], { origin: { kind: 'ai' } }, { deleted: ['canvas:a'] })
    const changes = await tab.next('changes')
    expect(changes.deleted.sort()).toEqual(['canvas:a', 'node:a', 'node:b'])
    expect(changes.origin).toEqual({ kind: 'ai' })
    expect(heard[0].deleted.sort()).toEqual(['canvas:a', 'node:a', 'node:b'])
  })
})
