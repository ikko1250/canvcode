import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NodeRecord, WorkspaceRecord } from '@canvcode/core'
import { richTextFromPlain, type TextProps } from '@canvcode/nodes'
import { Editor } from './editor.ts'
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

  it('skips nodes of types it does not know (removed types, such as the v1 slides), and still builds the index', () => {
    vi.stubGlobal('WebSocket', undefined)
    const workspace = new Workspace({ rootCanvasId: 'canvas:root' })
    const base = { typeName: 'node' as const, parentId: 'canvas:root', x: 0, y: 0, rotation: 0, index: 'a0', opacity: 1, locked: false, meta: {} }
    const records: WorkspaceRecord[] = [
      { ...base, id: 'node:old', type: 'slide-page', props: { fileId: 'file:deck', w: 640, h: 360 } },
      { ...base, id: 'node:note', type: 'note', index: 'a1', version: 2, props: { paragraphs: richTextFromPlain('memo'), w: 220, h: 200, color: '#fff3bf', fontSize: 12, align: 'left' } },
    ]
    const sync = new SyncClient(workspace, { rootCanvasId: 'canvas:root', rev: 0, records })
    expect(workspace.getNode('node:old')).toBeUndefined()
    expect(workspace.getNode('node:note')).toBeDefined()
    expect(new Editor({ workspace, canvasId: 'canvas:root' }).index.allIds()).toEqual(['node:note'])
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

  it('hands over the assets that come with a change before applying its records (a PDF the AI imported)', () => {
    const sockets: { onmessage?: (event: { data: string }) => void; send(text: string): void }[] = []
    class FakeWebSocket {
      onmessage?: (event: { data: string }) => void
      constructor() {
        sockets.push(this)
      }
      send(): void {}
      close(): void {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const workspace = new Workspace({ rootCanvasId: 'canvas:root' })
    const seen: { assets: unknown[]; nodeThen: boolean }[] = []
    const sync = new SyncClient(workspace, { rootCanvasId: 'canvas:root', rev: 0, records: [] }, {
      baseUrl: 'http://127.0.0.1',
      onAssets: (assets) => seen.push({ assets, nodeThen: workspace.getNode('node:n') !== undefined }),
    })
    const note = { typeName: 'node', id: 'node:n', type: 'note', parentId: 'canvas:root', x: 0, y: 0, rotation: 0, index: 'a0', opacity: 1, locked: false, meta: {}, version: 2, props: { paragraphs: richTextFromPlain('AI'), w: 100, h: 100, color: '#fff3bf', fontSize: 12, align: 'left' } }
    const asset = { hash: 'a'.repeat(64), mime: 'application/pdf', size: 10, width: 0, height: 0, variants: [] }
    const receive = (message: unknown) => sockets[0]!.onmessage!({ data: JSON.stringify(message) })
    receive({ type: 'changes', rev: 1, records: [note], deleted: [], assets: [asset], origin: { kind: 'ai', batchId: 'ai-1', label: 'PDF', canvasId: 'canvas:root', count: 1 } })
    receive({ type: 'changes', rev: 2, records: [], deleted: [] })
    expect(seen).toEqual([{ assets: [asset], nodeThen: false }])
    expect(workspace.getNode('node:n')).toBeDefined()
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

// 開いた Canvas の分だけ読む（docs/lazy-canvas-loading-plan.md）
describe('sync of loaded canvases', () => {
  afterEach(() => vi.unstubAllGlobals())

  // つないだ WebSocket の代わり。送ったメッセージを sent に残し、サーバーからのメッセージは receive で渡す
  function fakeServer() {
    const sockets: FakeWebSocket[] = []
    class FakeWebSocket {
      onmessage?: (event: { data: string }) => void
      onopen?: () => void
      onclose?: () => void
      readonly sent: Record<string, any>[] = []
      constructor() {
        sockets.push(this)
      }
      send(text: string): void {
        this.sent.push(JSON.parse(text))
      }
      close(): void {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    return {
      get socket() {
        return sockets.at(-1)!
      },
      open: () => sockets.at(-1)!.onopen!(),
      receive: (message: unknown) => sockets.at(-1)!.onmessage!({ data: JSON.stringify(message) }),
    }
  }

  const base = { typeName: 'node' as const, x: 0, y: 0, rotation: 0, index: 'a0', opacity: 1, locked: false, meta: {} }
  const geo = (id: string, parentId: string) => ({ ...base, id, parentId, type: 'geo', props: {} }) as unknown as WorkspaceRecord
  const canvas = (id: string) => ({ typeName: 'canvas', id, title: id, parentCanvasId: null, ownerNodeId: null, createdAt: 0, updatedAt: 0, deletedAt: null, trash: null }) as WorkspaceRecord

  it('loads a canvas once, after connecting, and tells the server the loaded canvases', async () => {
    const server = fakeServer()
    const workspace = new Workspace({ rootCanvasId: 'canvas:root' })
    const sync = new SyncClient(workspace, { rootCanvasId: 'canvas:root', rev: 3, records: [canvas('canvas:a')], canvases: ['canvas:root'], citations: [] }, { baseUrl: 'http://127.0.0.1' })
    expect(sync.isLoaded('canvas:root')).toBe(true)
    expect(sync.isLoaded('canvas:a')).toBe(false)
    // つながる前に頼んだら、つながってから送る
    let done = false
    const first = sync.ensureCanvas('canvas:a').then(() => (done = true))
    expect(sync.ensureCanvas('canvas:a')).toBe(sync.ensureCanvas('canvas:a'))
    expect(server.socket.sent).toEqual([])
    server.open()
    expect(server.socket.sent).toEqual([
      { type: 'hello', since: 3, canvases: ['canvas:root'] },
      { type: 'load', req: 'canvas:a', canvasId: 'canvas:a' },
    ])
    await Promise.resolve()
    expect(done).toBe(false)
    server.receive({ type: 'canvas', req: 'canvas:a', canvasId: 'canvas:a', rev: 5, records: [geo('node:a', 'canvas:a')] })
    await first
    expect(sync.isLoaded('canvas:a')).toBe(true)
    expect(workspace.getNode('node:a')).toBeDefined()
    await sync.ensureCanvas('canvas:a')
    expect(server.socket.sent.filter((m) => m.type === 'load')).toHaveLength(1)
    sync.dispose()
  })

  it('removes evicted records, keeps the citation links of notes elsewhere, and loads canvases created here', () => {
    const server = fakeServer()
    const workspace = new Workspace({ rootCanvasId: 'canvas:root' })
    const link = { noteId: 'node:q', anchorId: 'anchor:1', canvasId: 'canvas:root', head: 'メモ' }
    const sync = new SyncClient(workspace, { rootCanvasId: 'canvas:root', rev: 0, records: [geo('node:a', 'canvas:root'), canvas('canvas:b')], canvases: ['canvas:root'], citations: [link] }, { baseUrl: 'http://127.0.0.1' })
    server.open()
    expect(workspace.notesOfAnchor('anchor:1')).toEqual([{ id: 'node:q', canvasId: 'canvas:root', head: 'メモ' }])
    // node:a は読んでいない Canvas へ移った。node:q は消えた
    server.receive({ type: 'changes', rev: 1, records: [], deleted: ['node:q'], evicted: ['node:a'] })
    expect(workspace.getNode('node:a')).toBeUndefined()
    expect(workspace.notesOfAnchor('anchor:1')).toEqual([])
    server.receive({ type: 'changes', rev: 2, records: [], deleted: [], citations: [{ ...link, noteId: 'node:r', canvasId: 'canvas:b' }] })
    expect(workspace.notesOfAnchor('anchor:1').map((n) => n.id)).toEqual(['node:r'])

    const editor = new Editor({ workspace, canvasId: 'canvas:root' })
    const { canvasId } = editor.createPortal({ x: 0, y: 0 })
    expect(sync.isLoaded(canvasId)).toBe(true)
    expect(server.socket.sent.at(-1)).toEqual({ type: 'load', req: null, canvasId })
    sync.dispose()
  })

  it('keeps the citation link of a note evicted during a drag, and so keeps its anchor (review)', async () => {
    const server = fakeServer()
    const workspace = new Workspace({ rootCanvasId: 'canvas:root' })
    const quote = (id: string) => ({ ...base, id, parentId: 'canvas:root', type: 'quote-card', props: { anchorId: 'anchor:1', fileId: 'file:1', quote: '引用', figure: null, memo: '', w: 280 } }) as unknown as WorkspaceRecord
    const anchor = { typeName: 'anchor', id: 'anchor:1', fileId: 'file:1', locator: { kind: 'pdf', pageIndex: 0, rect: { x: 0, y: 0, w: 1, h: 1 } }, quote: '引用', createdAt: 0 } as WorkspaceRecord
    const sync = new SyncClient(workspace, { rootCanvasId: 'canvas:root', rev: 0, records: [canvas('canvas:b'), anchor, quote('node:q'), quote('node:q2'), geo('node:drag', 'canvas:root')], canvases: ['canvas:root'], citations: [] }, { baseUrl: 'http://127.0.0.1' })
    server.open()
    const tx = workspace.store.begin('drag')
    tx.put({ ...workspace.getNode('node:drag')!, x: 50 })
    server.receive({ type: 'changes', rev: 1, records: [], deleted: [], evicted: ['node:q'], citations: [{ noteId: 'node:q', anchorId: 'anchor:1', canvasId: 'canvas:b', head: '引用' }] })
    tx.commit()
    // 後回しにした変更は、確定の知らせのあとで当てる
    await Promise.resolve()
    expect(workspace.getNode('node:q')).toBeUndefined()
    expect(workspace.notesOfAnchor('anchor:1').map((n) => n.id).sort()).toEqual(['node:q', 'node:q2'])
    new Editor({ workspace, canvasId: 'canvas:root' }).deleteNodes(['node:q2'])
    expect(workspace.getAnchor('anchor:1')).toBeDefined()
    sync.dispose()
  })

  it('applies a canvas reply held back by a cancelled drag before a later change, and is loaded only once applied (review)', async () => {
    const server = fakeServer()
    const workspace = new Workspace({ rootCanvasId: 'canvas:root' })
    const sync = new SyncClient(workspace, { rootCanvasId: 'canvas:root', rev: 0, records: [canvas('canvas:b')], canvases: ['canvas:root'], citations: [] }, { baseUrl: 'http://127.0.0.1' })
    server.open()
    const loading = sync.ensureCanvas('canvas:b')
    const tx = workspace.store.begin('drag')
    server.receive({ type: 'canvas', req: 'canvas:b', canvasId: 'canvas:b', rev: 1, records: [geo('node:m', 'canvas:b')] })
    // 当てるまでは読んだことにしない
    expect(sync.isLoaded('canvas:b')).toBe(false)
    tx.cancel()
    // ほかのタブが node:m を読んでいない Canvas へ移した
    server.receive({ type: 'changes', rev: 2, records: [], deleted: [], evicted: ['node:m'] })
    await loading
    expect(sync.isLoaded('canvas:b')).toBe(true)
    expect(workspace.getNode('node:m')).toBeUndefined()
    sync.dispose()
  })

  it('is disconnected only after having been connected (review)', () => {
    const server = fakeServer()
    const workspace = new Workspace({ rootCanvasId: 'canvas:root' })
    const sync = new SyncClient(workspace, { rootCanvasId: 'canvas:root', rev: 0, records: [], canvases: ['canvas:root'], citations: [] }, { baseUrl: 'http://127.0.0.1' })
    // 最初につながる前は、断らずに待つ
    expect(sync.disconnected).toBe(false)
    server.open()
    expect(sync.disconnected).toBe(false)
    server.socket.onclose!()
    expect(sync.disconnected).toBe(true)
    sync.dispose()
  })

  it('treats everything as loaded when the server sends all records (no canvases)', () => {
    vi.stubGlobal('WebSocket', undefined)
    const workspace = new Workspace({ rootCanvasId: 'canvas:root' })
    const sync = new SyncClient(workspace, { rootCanvasId: 'canvas:root', rev: 0, records: [] })
    expect(sync.isLoaded('canvas:any')).toBe(true)
    sync.dispose()
  })
})
