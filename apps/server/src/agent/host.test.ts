import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RecordStore } from '../records.ts'
import { SyncHub } from '../sync.ts'
import { AgentHost } from './host.ts'

// サーバーの中のワークスペース（AI の編集用）と、SyncHub の知らせ

const cleanups: (() => void)[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-host-'))
  const records = new RecordStore(dir)
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.push(() => records.close())
  return { records, sync: new SyncHub(records) }
}

const note = (id: string, parentId: string, x = 0) => ({
  typeName: 'node',
  id,
  type: 'note',
  parentId,
  x,
  y: 0,
  rotation: 0,
  index: 'a1',
  opacity: 1,
  locked: false,
  // 版 1（文字を text で持つ）。読み込むときに今の版にする
  props: { text: 'memo', w: 100, h: 100, color: '#fff3bf', fontSize: 12, align: 'left' },
  meta: {},
})

describe('AgentHost', () => {
  it('loads the records lazily, upgrades old nodes, follows changes and is dropped when idle', () => {
    vi.useFakeTimers()
    const { records, sync } = setup()
    records.apply([note('node:a', records.rootCanvasId)], [])
    const host = new AgentHost({ records, sync, idleMs: 1000 })
    cleanups.push(() => host.dispose())
    expect(host.alive).toBe(false)
    const workspace = host.workspace()
    expect(host.alive).toBe(true)
    expect(workspace.rootCanvasId).toBe(records.rootCanvasId)
    expect(workspace.getNode('node:a')).toMatchObject({ version: 2 })
    // 保存された変更（ブラウザからの push・サーバーの broadcast）を当てる。自分の変更（except）は当てない
    sync.broadcast(records.rev, [note('node:b', records.rootCanvasId, 50)], {}, { deleted: ['node:a'] })
    expect(workspace.getNode('node:a')).toBeUndefined()
    expect(workspace.getNode('node:b')).toMatchObject({ x: 50 })
    sync.broadcast(records.rev, [note('node:c', records.rootCanvasId)], {}, { except: host.listener })
    expect(workspace.getNode('node:c')).toBeUndefined()
    const editor = host.editor(records.rootCanvasId)
    expect(editor.index.get('node:b')).toBeDefined()
    vi.advanceTimersByTime(1001)
    expect(host.alive).toBe(false)
    // 捨てたあとは購読もやめている（次に作るときに db から読む）
    sync.broadcast(records.rev, [note('node:d', records.rootCanvasId)])
    expect(host.workspace().getNode('node:d')).toBeUndefined()
  })
})

describe('SyncHub.broadcast', () => {
  it('sends deleted ids and extra fields to every open tab', () => {
    const { sync } = setup()
    const sent: unknown[] = []
    const tab = { readyState: 1, OPEN: 1, send: (text: string) => sent.push(JSON.parse(text)) }
    ;(sync as unknown as { clients: Map<unknown, 'all'> }).clients.set(tab, 'all')
    sync.broadcast(7, [{ id: 'node:x' }], { origin: { kind: 'ai', batchId: 'ai-1' } }, { deleted: ['node:y'] })
    expect(sent).toEqual([{ type: 'changes', rev: 7, records: [{ id: 'node:x' }], deleted: ['node:y'], origin: { kind: 'ai', batchId: 'ai-1' } }])
  })
})

describe('SyncHub presence', () => {
  // つないだタブの代わり（ws の WebSocket と同じく、message・close を知らせる）
  const connect = (sync: SyncHub) => {
    const socket = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1, send: () => {} })
    sync.server.emit('connection', socket)
    return {
      send: (message: unknown) => socket.emit('message', JSON.stringify(message)),
      close: () => socket.emit('close'),
    }
  }

  it('keeps the latest view of the connected tabs and drops it when a tab closes', () => {
    const { sync } = setup()
    expect(sync.latestPresence()).toBeNull()
    const a = connect(sync)
    const b = connect(sync)
    a.send({ type: 'presence', canvasId: 'canvas:a', viewport: { x: 0, y: 0, w: 800, h: 600 } })
    b.send({ type: 'presence', canvasId: 'canvas:b', viewport: { x: 10, y: 20, w: 400, h: 300 } })
    expect(sync.latestPresence()).toMatchObject({ canvasId: 'canvas:b', viewport: { x: 10, y: 20, w: 400, h: 300 } })
    a.send({ type: 'presence', canvasId: 'canvas:a', viewport: { x: 5, y: 0, w: 800, h: 600 } })
    expect(sync.latestPresence()).toMatchObject({ canvasId: 'canvas:a', viewport: { x: 5 } })
    // 形のおかしいものは無視する
    b.send({ type: 'presence', canvasId: 'canvas:b', viewport: { x: 'a', y: 0, w: 1, h: 1 } })
    expect(sync.latestPresence()?.canvasId).toBe('canvas:a')
    a.close()
    expect(sync.latestPresence()?.canvasId).toBe('canvas:b')
    b.close()
    expect(sync.latestPresence()).toBeNull()
  })
})
