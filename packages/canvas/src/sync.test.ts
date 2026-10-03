import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NodeRecord, WorkspaceRecord } from '@canvcode/core'
import { richTextFromPlain, type TextProps } from '@canvcode/nodes'
import { SyncClient } from './sync.ts'
import { Workspace } from './workspace.ts'

// サーバーから読んだレコード（WebSocket を外して、つながずに最初の読み込みだけを確かめる）

describe('sync', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('upgrades text and notes saved as plain text (version 1) when loading them (MAI-74)', () => {
    vi.stubGlobal('WebSocket', undefined)
    const workspace = new Workspace({ rootCanvasId: 'canvas:root' })
    const base = { typeName: 'node' as const, parentId: 'canvas:root', x: 0, y: 0, rotation: 0, index: 'a0', opacity: 1, locked: false, meta: {} }
    const records: WorkspaceRecord[] = [
      { ...base, id: 'node:text', type: 'text', props: { text: 'a\nb', fontSize: 16, color: '#000000', align: 'left', w: 200, autoWidth: true } },
      { ...base, id: 'node:note', type: 'note', props: { text: 'memo', w: 220, h: 200, color: '#fff3bf', fontSize: 12, align: 'left' } },
    ]
    const sync = new SyncClient(workspace, { rootCanvasId: 'canvas:root', rev: 0, records })
    const text = workspace.store.get('node:text') as NodeRecord<TextProps>
    expect(text.version).toBe(2)
    expect(text.props).toEqual({ paragraphs: richTextFromPlain('a\nb'), fontSize: 16, color: '#000000', align: 'left', w: 200, autoWidth: true })
    expect((workspace.store.get('node:note') as NodeRecord<TextProps>).props.paragraphs).toEqual(richTextFromPlain('memo'))
    // 読み込んだだけでは送り返さない（次に変えたときに新しい版で保存される）
    expect(sync.pending).toBe(false)
    sync.dispose()
  })

  it('applies changes from the AI and reports them with their batch (edit_canvas)', () => {
    // つないだ WebSocket の代わり。サーバーからのメッセージは onmessage に渡す
    const sockets: { onmessage?: (event: { data: string }) => void; onopen?: () => void; send(text: string): void }[] = []
    class FakeWebSocket {
      onmessage?: (event: { data: string }) => void
      onopen?: () => void
      constructor() {
        sockets.push(this)
      }
      send(): void {}
      close(): void {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const workspace = new Workspace({ rootCanvasId: 'canvas:root' })
    const changes: unknown[] = []
    const sync = new SyncClient(workspace, { rootCanvasId: 'canvas:root', rev: 0, records: [] }, { baseUrl: 'http://127.0.0.1', onAgentChange: (change) => changes.push(change) })
    const base = { typeName: 'node' as const, parentId: 'canvas:root', x: 0, y: 0, rotation: 0, index: 'a0', opacity: 1, locked: false, meta: {} }
    const note = { ...base, id: 'node:n', type: 'note', version: 2, props: { paragraphs: richTextFromPlain('AI'), w: 100, h: 100, color: '#fff3bf', fontSize: 12, align: 'left' } }
    const receive = (message: unknown) => sockets[0]!.onmessage!({ data: JSON.stringify(message) })
    receive({ type: 'changes', rev: 1, records: [note], deleted: [], origin: { kind: 'ai', batchId: 'ai-1', label: '付箋', canvasId: 'canvas:root', count: 1 } })
    expect(workspace.getNode('node:n')).toBeDefined()
    expect(changes).toEqual([{ batchId: 'ai-1', label: '付箋', canvasId: 'canvas:root', count: 1 }])
    // 取り消し（ai-undo）とほかのタブの変更では呼ばない。消したノードは消える
    receive({ type: 'changes', rev: 2, records: [], deleted: ['node:n'], origin: { kind: 'ai-undo', batchId: 'ai-1' } })
    receive({ type: 'changes', rev: 3, records: [], deleted: [] })
    expect(workspace.getNode('node:n')).toBeUndefined()
    expect(changes).toHaveLength(1)
    // AI の変更は送り返さない
    expect(sync.pending).toBe(false)
    sync.dispose()
  })

  it('reports the view after the camera stops, at once on a canvas switch, and again after reconnecting', () => {
    vi.useFakeTimers()
    const sockets: { sent: Record<string, unknown>[]; onopen?: () => void; onclose?: () => void }[] = []
    class FakeWebSocket {
      sent: Record<string, unknown>[] = []
      onopen?: () => void
      onclose?: () => void
      constructor() {
        sockets.push(this)
      }
      send(text: string): void {
        this.sent.push(JSON.parse(text))
      }
      close(): void {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const workspace = new Workspace({ rootCanvasId: 'canvas:root' })
    const sync = new SyncClient(workspace, { rootCanvasId: 'canvas:root', rev: 0, records: [] }, { baseUrl: 'http://127.0.0.1', presenceDelayMs: 500 })
    const presences = (i = 0) => sockets[i]!.sent.filter((m) => m.type === 'presence')
    // つながる前のものは、つながったときに送る
    sync.reportPresence('canvas:root', { x: 0.4, y: 0, w: 800, h: 600 })
    sockets[0]!.onopen!()
    expect(presences()).toEqual([{ type: 'presence', canvasId: 'canvas:root', viewport: { x: 0, y: 0, w: 800, h: 600 } }])
    // カメラが動いている間は送らず、止まってから最後のものだけを送る
    sync.reportPresence('canvas:root', { x: 10, y: 0, w: 800, h: 600 })
    vi.advanceTimersByTime(300)
    sync.reportPresence('canvas:root', { x: 20, y: 0, w: 800, h: 600 })
    vi.advanceTimersByTime(300)
    expect(presences()).toHaveLength(1)
    vi.advanceTimersByTime(300)
    expect(presences().at(-1)).toMatchObject({ viewport: { x: 20 } })
    // 変わっていなければ送らない
    sync.reportPresence('canvas:root', { x: 20, y: 0, w: 800, h: 600 })
    vi.advanceTimersByTime(600)
    expect(presences()).toHaveLength(2)
    // Canvas を移ったらすぐ送る
    sync.reportPresence('canvas:b', { x: 0, y: 0, w: 800, h: 600 })
    expect(presences().at(-1)).toMatchObject({ canvasId: 'canvas:b' })
    // つなぎ直したら送り直す
    sockets[0]!.onclose!()
    vi.advanceTimersByTime(1000)
    sockets[1]!.onopen!()
    expect(presences(1)).toEqual([{ type: 'presence', canvasId: 'canvas:b', viewport: { x: 0, y: 0, w: 800, h: 600 } }])
    sync.dispose()
    vi.useRealTimers()
  })
})
