import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { canvasSlideLayout } from '@canvcode/slides'
import { AgentHost } from './agent/host.ts'
import { FileStore, type FileEvent } from './files.ts'
import { handleMcp, MCP_PATH } from './mcp.ts'
import { RecordStore } from './records.ts'
import type { Presence } from './sync.ts'
import { RefImageStore } from './refImages.ts'

// AI から使う MCP サーバー（MAI-59）

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(): Promise<{
  client: Client
  files: FileStore
  records: RecordStore
  refImages: RefImageStore
  dataDir: string
  events: FileEvent[]
  url: URL
  workspace: string
  // ユーザーが見ている所（ブラウザが知らせるものの代わり）
  view: { current: Presence | null }
}> {
  const workspace = mkdtempSync(join(tmpdir(), 'canvcode-mcp-'))
  cleanups.push(() => rmSync(workspace, { recursive: true, force: true }))
  const events: FileEvent[] = []
  const files = new FileStore(workspace, join(workspace, '.canvcode'), (event) => events.push(event))
  await files.init()
  cleanups.push(() => files.close())
  const dataDir = join(workspace, '.canvcode')
  const records = new RecordStore(dataDir)
  cleanups.push(() => records.close())
  const refImages = new RefImageStore(dataDir)
  const agent = new AgentHost({ records, files })
  cleanups.push(() => agent.dispose())
  const view: { current: Presence | null } = { current: null }
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    void (async () => {
      if (!(await handleMcp(req, res, url.pathname, { files, records, dataDir, refImages, agent, presence: () => view.current }))) res.writeHead(404).end()
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}${MCP_PATH}`)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(url))
  cleanups.push(() => client.close())
  return { client, files, records, refImages, dataDir, events, url, workspace, view }
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ data: any; isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as { type: string; text: string }[])[0]!.text
  const isError = result.isError === true
  return { data: isError ? undefined : JSON.parse(text), isError, text }
}

describe('MCP server', () => {
  it('lists the document tools', async () => {
    const { client } = await setup()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'create_document',
      'edit_canvas',
      'edit_document',
      'get_canvas_format',
      'list_canvases',
      'list_documents',
      'read_canvas',
      'read_document',
      'read_nodes',
      'resolve_reference',
      'undo_canvas_edit',
      'update_document',
    ])
  })

  it('points to slides on a canvas, and no longer to slide deck files (v1)', async () => {
    const { client } = await setup()
    const instructions = client.getInstructions() ?? ''
    expect(instructions).toContain('put slides on a canvas')
    expect(instructions).not.toMatch(/slide deck|\.slide\.md|create_slide_deck/)
  })

  it('creates, lists and reads a document, and tells open tabs', async () => {
    const { client, events } = await setup()
    const created = await call(client, 'create_document', { kind: 'markdown', title: 'メモ', content: '# 見出し\n' })
    expect(created.data.document).toMatchObject({ kind: 'markdown', title: 'メモ', path: 'メモ.md' })
    expect(events).toContainEqual(expect.objectContaining({ type: 'file-added' }))

    const listed = await call(client, 'list_documents', { query: 'メ' })
    expect(listed.data.documents).toEqual([created.data.document])
    expect((await call(client, 'list_documents', { kind: 'code' })).data.documents).toEqual([])

    const read = await call(client, 'read_document', { id: created.data.document.id })
    expect(read.data).toMatchObject({ text: '# 見出し\n', hash: created.data.hash })
  })

  it('creates, lists and reads a table (CSV) document', async () => {
    const { client } = await setup()
    const created = await call(client, 'create_document', { kind: 'table', title: '売上', content: '月,売上\n1,120\n' })
    expect(created.data.document).toMatchObject({ kind: 'table', title: '売上', path: '売上.csv' })
    expect((await call(client, 'list_documents', { kind: 'table' })).data.documents).toEqual([created.data.document])
    const read = await call(client, 'read_document', { id: created.data.document.id })
    expect(read.data).toMatchObject({ text: '月,売上\n1,120\n' })
  })

  it('edits part of a document and keeps CRLF line endings', async () => {
    const { client, files, events } = await setup()
    const target = await files.create('markdown', 'crlf', 'one\r\ntwo\r\ntwo\r\n')
    const ambiguous = await call(client, 'edit_document', { id: target.id, old_string: 'two', new_string: '2' })
    expect(ambiguous.isError).toBe(true)
    expect(ambiguous.text).toContain('2 times')

    const missing = await call(client, 'edit_document', { id: target.id, old_string: 'three', new_string: '3' })
    expect(missing.isError).toBe(true)

    const edited = await call(client, 'edit_document', { id: target.id, old_string: 'one\ntwo', new_string: 'ONE\nTWO' })
    expect(edited.data.replaced).toBe(1)
    expect((await files.read(target.id)).text).toBe('ONE\r\nTWO\r\ntwo\r\n')
    expect(events.at(-1)).toMatchObject({ type: 'file-changed', file: { id: target.id, hash: edited.data.hash } })

    const all = await call(client, 'edit_document', { id: target.id, old_string: 'T', new_string: 't', replace_all: true })
    expect(all.data.replaced).toBe(1)
  })

  it('refuses a full replace when the document changed since it was read', async () => {
    const { client, files } = await setup()
    const file = await files.create('code', 'script', 'print(1)\n')
    const { hash } = await files.read(file.id)
    await files.write(file.id, 'print(2)\n', '')

    const stale = await call(client, 'update_document', { id: file.id, content: 'print(3)\n', expected_hash: hash })
    expect(stale.isError).toBe(true)
    expect(stale.text).toContain('changed since you read it')
    expect((await files.read(file.id)).text).toBe('print(2)\n')

    const fresh = await call(client, 'update_document', { id: file.id, content: 'print(3)\n' })
    expect(fresh.isError).toBe(false)
    expect((await files.read(file.id)).text).toBe('print(3)\n')
  })

  it('reads canvases as compact text through the canvas tools', async () => {
    const { client, records } = await setup()
    const root = records.rootCanvasId
    records.apply([{ typeName: 'node', id: 'node:n', type: 'note', parentId: root, x: 10, y: 20, rotation: 0, index: 'a1', locked: false, props: { text: 'メモ', w: 100, h: 50 } }], [])
    const { tools } = await client.listTools()
    // ツールの説明は短く保つ（毎回 AI に渡る）
    const canvasTools = tools.filter((t) => ['get_canvas_format', 'list_canvases', 'read_canvas', 'read_nodes', 'edit_canvas', 'undo_canvas_edit'].includes(t.name))
    expect(canvasTools.map((t) => t.description ?? '').join('').length).toBeLessThan(900)
    // edit_canvas の入力のスキーマも小さく保つ（操作ごとの形は get_canvas_format に書く）
    expect(JSON.stringify(tools.find((t) => t.name === 'edit_canvas')!.inputSchema).length).toBeLessThan(800)

    expect((await client.callTool({ name: 'list_canvases', arguments: {} })).content).toEqual([{ type: 'text', text: `rev=${records.rev} canvases=1\n${root} "ホーム" nodes=1` }])
    const outline = (await client.callTool({ name: 'read_canvas', arguments: {} })).content as { text: string }[]
    expect(outline[0]!.text.split('\n')[1]).toBe('node:n note 10,20 100x50 "メモ"')
    const nodes = (await client.callTool({ name: 'read_nodes', arguments: { ids: ['node:n'] } })).content as { text: string }[]
    expect(nodes[0]!.text).not.toContain('\n')
    expect(JSON.parse(nodes[0]!.text).nodes[0]).toMatchObject({ id: 'node:n', x: 10, y: 20, text: 'メモ' })
    const unknown = await call(client, 'read_canvas', { canvas_id: 'canvas:nope' })
    expect(unknown.isError).toBe(true)
    const guide = (await client.callTool({ name: 'get_canvas_format', arguments: {} })).content as { text: string }[]
    expect(guide[0]!.text).toContain('read_canvas outline')
    expect(guide[0]!.text).toContain('## Editing (edit_canvas)')
  })

  it('edits a canvas and undoes the edit through the canvas tools', async () => {
    const { client, records, files } = await setup()
    const doc = await files.create('markdown', 'メモ', '# メモ\n')
    const edited = await call(client, 'edit_canvas', {
      canvas_id: records.rootCanvasId,
      label: '付箋とカード',
      ops: [
        { op: 'create', type: 'note', as: 'n', text: 'こんにちは', x: 10, y: 20 },
        { op: 'create', type: 'card', as: 'c', file: doc.id, place: { rightOf: '$n' } },
      ],
    })
    expect(edited.isError).toBe(false)
    expect(edited.text).not.toContain('\n')
    expect(edited.data).toMatchObject({ rev: records.rev, counts: { created: 2, updated: 0, deleted: 0 } })
    // 外で作った File も、カードにすると持ち主が付く
    expect(records.get(doc.id)).toMatchObject({ ownerNodeId: edited.data.created.c })
    const outline = (await client.callTool({ name: 'read_canvas', arguments: {} })).content as { text: string }[]
    expect(outline[0]!.text).toContain(`${edited.data.created.n} note 10,20`)
    const failed = await call(client, 'edit_canvas', { canvas_id: records.rootCanvasId, ops: [{ op: 'move', ids: ['node:nope'], dx: 1 }] })
    expect(failed).toMatchObject({ isError: true })
    expect(failed.text).toMatch(/^ops\[0\] \(move\): unknown node node:nope/)
    const undone = await call(client, 'undo_canvas_edit', { batch_id: edited.data.batch })
    expect(undone.data).toMatchObject({ restored: 3 })
    expect(records.get(edited.data.created.n)).toBeUndefined()
  })

  // スライド（スライド v2）を edit_canvas で置き、テンプレートと行を足すと並べ直される。read_canvas に番号が出て、Undo で消える
  it('makes slides on a canvas through the canvas tools', async () => {
    const { client, records } = await setup()
    const guide = ((await client.callTool({ name: 'get_canvas_format', arguments: {} })).content as { text: string }[])[0]!.text
    expect(guide).toContain('- slide-layout:')
    expect(guide).toContain('- add_row:')
    const edited = await call(client, 'edit_canvas', {
      canvas_id: records.rootCanvasId,
      ops: [
        { op: 'create', type: 'slide', as: 's', x: 0, y: 0, name: '要点', template: 'bullets' },
        { op: 'add_row', slide: '$s', text: '四つ目', as: 'r' },
      ],
    })
    expect(edited.isError).toBe(false)
    const slideId = edited.data.created.s
    const outline = ((await client.callTool({ name: 'read_canvas', arguments: { canvas_id: records.rootCanvasId, depth: 2 } })).content as { text: string }[])[0]!.text
    expect(outline).toContain(`${slideId} slide 0,0 1920x1080 n=1 "要点"`)
    // 4 行目の本文は、4 行の幾何どおりの位置にある
    const row = canvasSlideLayout('bullets', 4, '16:9').rows[3]!.body
    expect(outline).toContain(`${edited.data.created.r} geo/rect ${row.x},${row.y} ${row.w}x${row.h}`)
    const nodes = await call(client, 'read_nodes', { ids: [slideId] })
    expect(nodes.data.nodes[0]).toMatchObject({ id: slideId, number: 1, name: '要点' })
    const undone = await call(client, 'undo_canvas_edit', { batch_id: edited.data.batch })
    expect(undone.isError).toBe(false)
    expect(records.get(slideId)).toBeUndefined()
  })

  it('defaults the canvas tools to where the user is looking', async () => {
    const { client, records, view } = await setup()
    const root = records.rootCanvasId
    const note = (id: string, x: number, y: number) => ({ typeName: 'node', id, type: 'note', parentId: root, x, y, rotation: 0, index: `a${id.at(-1)}`, locked: false, props: { text: id, w: 100, h: 50, fontSize: 12, color: '#fff3bf', align: 'left' } })
    records.apply([note('node:1', 10, 20), note('node:2', 1100, 1100)], [])
    // 見ている所がなければ、edit_canvas は canvas_id が要る。read_canvas はルート
    const missing = await call(client, 'edit_canvas', { ops: [{ op: 'create', type: 'note' }] })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('Pass canvas_id')
    expect((await call(client, 'read_canvas', { view: true })).isError).toBe(true)

    view.current = { canvasId: root, viewport: { x: 1000, y: 1000, w: 800, h: 600 }, at: Date.now() }
    const listed = (await client.callTool({ name: 'list_canvases', arguments: {} })).content as { text: string }[]
    expect(listed[0]!.text).toContain(`${root} "ホーム" nodes=2 viewing`)
    const all = ((await client.callTool({ name: 'read_canvas', arguments: {} })).content as { text: string }[])[0]!.text
    expect(all.split('\n')[0]).toContain(`${root} "ホーム" viewing=1000,1000,800x600 rev=`)
    expect(all).toContain('node:1 note')
    // view=true は画面に見えているものだけ
    const shown = ((await client.callTool({ name: 'read_canvas', arguments: { view: true } })).content as { text: string }[])[0]!.text
    expect(shown).toContain('node:2 note')
    expect(shown).not.toContain('node:1 note')
    // 位置を決めずに作ると、見ている範囲の中心の近くの空いた所に置く
    const edited = await call(client, 'edit_canvas', { ops: [{ op: 'create', type: 'note', as: 'n', text: 'ここ', w: 100, h: 100 }] })
    expect(edited.isError).toBe(false)
    expect(edited.data.canvas).toBe(root)
    const created = records.get(edited.data.created.n)!
    expect(Math.hypot(Number(created.x) + 50 - 1400, Number(created.y) + 50 - 1300)).toBeLessThan(200)
  })

  it('reports an unknown id as a tool error', async () => {
    const { client } = await setup()
    const result = await call(client, 'read_document', { id: 'file:nope' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('list_documents')
  })

  it('refuses GET because the server keeps no sessions', async () => {
    const { url } = await setup()
    const response = await fetch(url)
    expect(response.status).toBe(405)
  })

  describe('resolve_reference', () => {
    const ref = (fields: Record<string, unknown>) => ({ typeName: 'ref', id: 'ref:Ab12Cd34Ef', createdAt: Date.UTC(2026, 8, 24), ...fields }) as any
    const PNG = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
      Buffer.from('IHDR', 'ascii'),
      Buffer.from([0, 0, 3, 32, 0, 0, 1, 144, 8, 6, 0, 0, 0, 0, 0, 0, 0]),
    ])

    it('returns the current lines, and follows them when they move', async () => {
      const { client, files, records, workspace } = await setup()
      const file = await files.create('code', 'main', 'import os\ndef f():\n    return 1\n')
      records.putRef(ref({ kind: 'lines', fileId: file.id, startLine: 2, endLine: 3, snapshot: 'def f():\n    return 1' }))

      const same = await call(client, 'resolve_reference', { id: 'ref:Ab12Cd34Ef' })
      expect(same.data).toMatchObject({
        id: 'ref:Ab12Cd34Ef',
        kind: 'lines',
        openPath: '/r/ref%3AAb12Cd34Ef',
        location: { fileId: file.id, path: 'main.py', absPath: join(workspace, 'main.py'), fileKind: 'code', startLine: 2, endLine: 3, status: 'unchanged' },
        content: { text: 'def f():\n    return 1' },
      })
      expect(same.data.content.snapshot).toBeUndefined()

      await files.write(file.id, '# header\n\nimport os\ndef f():\n    return 1\n', '')
      const moved = await call(client, 'resolve_reference', { id: ' `Ab12Cd34Ef` ' })
      expect(moved.data.location).toMatchObject({ startLine: 4, endLine: 5, originalStartLine: 2, status: 'moved' })
      expect(moved.data.warnings.join()).toContain('moved')

      await files.write(file.id, 'import os\nprint(2)\n', '')
      const lost = await call(client, 'resolve_reference', { id: 'ref:Ab12Cd34Ef' })
      expect(lost.data.location.status).toBe('lost')
      expect(lost.data.content).toEqual({ text: 'print(2)\n', snapshot: 'def f():\n    return 1' })
    })

    it('describes the nodes in a canvas region, including the contents of frames', async () => {
      const { client, files, records, workspace } = await setup()
      const root = records.rootCanvasId
      const doc = await files.create('markdown', 'メモ', '# hi\n')
      const node = (id: string, type: string, parentId: string, props: Record<string, unknown>) => ({ typeName: 'node', id, type, parentId, x: 0, y: 0, props })
      records.apply(
        [
          node('node:frame', 'frame', root, { name: '設計', w: 300, h: 200 }),
          node('node:note', 'note', 'node:frame', { text: 'ここを直す' }),
          node('node:card', 'markdown-card', root, { fileId: doc.id }),
          // 範囲ごとに書式を持つテキスト（版 2。MAI-74）も、プレーンテキストで渡す
          {
            ...node('node:rich', 'text', root, {
              paragraphs: [{ runs: [{ text: '赤い', format: { color: '#ff0000' } }, { text: '文字' }] }, { runs: [{ text: '二行目' }] }],
            }),
            version: 2,
          },
          node('node:gone', 'geo', root, { label: 'x' }),
          // 画像の塗りの図形（MAI-83）は、画像ノードと同じく Asset の id を渡す
          node('node:photo', 'geo', root, { label: '写真', fill: { type: 'image', assetId: 'asset:abc', scaleMode: 'fill', crop: { x: 0, y: 0, w: 1, h: 1 }, tileScale: 1, opacity: 1 } }),
          // グラフ（MAI-88）は、行のラベル・値と割合を渡す
          node('node:chart', 'chart', root, {
            kind: 'pie', w: 240, h: 240, innerRadius: 0.5, startAngle: 0, showLabels: true, showPercent: true,
            rows: [{ label: '東', value: 3 }, { label: '西', value: 1, color: '#ff0000' }, { label: '空', value: 0 }],
          }),
        ],
        [],
      )
      records.apply([], ['node:gone'])
      const bounds = { x: 0, y: 0, w: 10, h: 10 }
      records.putRef(
        ref({
          kind: 'canvas',
          canvasId: root,
          rect: { x: -5, y: -5, w: 400, h: 300 },
          nodes: [
            { id: 'node:frame', bounds },
            { id: 'node:card', bounds },
            { id: 'node:rich', bounds },
            { id: 'node:gone', bounds },
            { id: 'node:photo', bounds },
            { id: 'node:chart', bounds },
          ],
        }),
      )
      const result = await call(client, 'resolve_reference', { id: 'ref:Ab12Cd34Ef' })
      expect(result.data.location).toMatchObject({ canvasId: root, canvasTitle: 'ホーム', canvasPath: ['ホーム'], status: 'ok' })
      expect(result.data.content.nodes).toEqual([
        { id: 'node:frame', type: 'frame', name: '設計', bounds, children: [{ id: 'node:note', type: 'note', parentId: 'node:frame', text: 'ここを直す' }] },
        { id: 'node:card', type: 'markdown-card', bounds, file: { id: doc.id, kind: 'markdown', title: 'メモ', path: 'メモ.md', absPath: join(workspace, 'メモ.md') } },
        { id: 'node:rich', type: 'text', bounds, text: '赤い文字\n二行目' },
        { id: 'node:gone', type: 'unknown', bounds, deleted: true },
        { id: 'node:photo', type: 'geo', bounds, label: '写真', assetId: 'asset:abc' },
        {
          id: 'node:chart', type: 'chart', bounds,
          chart: { kind: 'pie', innerRadius: 0.5, rows: [{ label: '東', value: 3, percent: 75 }, { label: '西', value: 1, percent: 25, color: '#ff0000' }, { label: '空', value: 0 }] },
        },
      ])
      expect(result.data.content.truncated).toBe(false)
      expect(result.data.warnings.join()).toContain('deleted')
    })

    // スライド（スライド v2）も frame と同じく、名前と中身を渡す。縦横比と、書き出しから外しているかも
    it('describes slides with their name, ratio and contents', async () => {
      const { client, records } = await setup()
      const root = records.rootCanvasId
      const node = (id: string, type: string, parentId: string, props: Record<string, unknown>) => ({ typeName: 'node', id, type, parentId, x: 0, y: 0, props })
      records.apply(
        [
          node('node:slide', 'slide', root, { ratio: '4:3', name: '表紙', hidden: true }),
          node('node:note', 'note', 'node:slide', { text: '題名' }),
        ],
        [],
      )
      const bounds = { x: 0, y: 0, w: 1440, h: 1080 }
      records.putRef(ref({ kind: 'canvas', canvasId: root, rect: { x: -5, y: -5, w: 1500, h: 1100 }, nodes: [{ id: 'node:slide', bounds }] }))
      const result = await call(client, 'resolve_reference', { id: 'ref:Ab12Cd34Ef' })
      expect(result.data.content.nodes).toEqual([
        { id: 'node:slide', type: 'slide', name: '表紙', ratio: '4:3', hidden: true, bounds, children: [{ id: 'node:note', type: 'note', parentId: 'node:slide', text: '題名' }] },
      ])
    })

    // スライドの中身を並べる入れ物（slide-layout）も、並べ方と中身を渡す
    it('describes a slide-layout with its layout and contents', async () => {
      const { client, records } = await setup()
      const root = records.rootCanvasId
      const node = (id: string, type: string, parentId: string, props: Record<string, unknown>) => ({ typeName: 'node', id, type, parentId, x: 0, y: 0, props })
      records.apply(
        [
          node('node:slide', 'slide', root, { ratio: '16:9', name: '', hidden: false }),
          node('node:layout', 'slide-layout', 'node:slide', { layout: 'bullets', w: 1920, h: 1080, slots: { rows: [{ body: 'node:note' }] } }),
          node('node:note', 'note', 'node:layout', { text: '項目' }),
        ],
        [],
      )
      const bounds = { x: 0, y: 0, w: 1920, h: 1080 }
      records.putRef(ref({ kind: 'canvas', canvasId: root, rect: { x: -5, y: -5, w: 2000, h: 1100 }, nodes: [{ id: 'node:slide', bounds }] }))
      const result = await call(client, 'resolve_reference', { id: 'ref:Ab12Cd34Ef' })
      expect(result.data.content.nodes[0].children).toEqual([
        { id: 'node:layout', type: 'slide-layout', parentId: 'node:slide', layout: 'bullets', children: [{ id: 'node:note', type: 'note', parentId: 'node:layout', text: '項目' }] },
      ])
    })

    it('returns the text of a PDF region and of its page', async () => {
      const { client, records, dataDir } = await setup()
      const hash = 'a'.repeat(64)
      mkdirSync(join(dataDir, 'assets'), { recursive: true })
      writeFileSync(join(dataDir, 'assets', `${hash}.pages.json`), JSON.stringify({ version: 1, pages: ['page one', 'page two text'] }))
      const now = Date.now()
      records.apply(
        [
          {
            typeName: 'file', id: 'file:pdf', kind: 'pdf', title: 'paper', path: 'paper.pdf', assetId: `asset:${hash}`,
            parentCanvasId: records.rootCanvasId, ownerNodeId: null, createdAt: now, updatedAt: now, deletedAt: null, trash: null,
          },
        ],
        [],
      )
      records.putRef(ref({ kind: 'pdf', fileId: 'file:pdf', pageIndex: 1, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, text: 'two' }))
      const result = await call(client, 'resolve_reference', { id: 'ref:Ab12Cd34Ef' })
      expect(result.data.location).toMatchObject({ fileId: 'file:pdf', title: 'paper', path: 'paper.pdf', page: 2, pageIndex: 1 })
      expect(result.data.content).toEqual({ text: 'two', pageText: 'page two text' })
      // PDF を読めないモデルもあるので、取り出したテキストのファイルを渡す。古い PDF でも pages.json から作る
      const textPath = join(dataDir, 'assets', `${hash}.txt`)
      expect(result.data.location.textPath).toBe(textPath)
      expect(readFileSync(textPath, 'utf8')).toBe('=== page 1 ===\npage one\n\f=== page 2 ===\npage two text\n')
    })

    it('gives the PDF text file for PDF pages in a canvas region, and nothing when the text is not extracted yet', async () => {
      const { client, records, dataDir } = await setup()
      const root = records.rootCanvasId
      const hash = 'b'.repeat(64)
      mkdirSync(join(dataDir, 'assets'), { recursive: true })
      writeFileSync(join(dataDir, 'assets', `${hash}.pages.json`), JSON.stringify({ version: 1, pages: ['one', 'two'] }))
      const now = Date.now()
      const pdf = (id: string, assetHash: string) => ({
        typeName: 'file', id, kind: 'pdf', title: id, path: '', assetId: `asset:${assetHash}`, pageCount: 2,
        parentCanvasId: root, ownerNodeId: null, createdAt: now, updatedAt: now, deletedAt: null, trash: null,
      })
      const page = (id: string, fileId: string, pageIndex: number) => ({ typeName: 'node', id, type: 'pdf-page', parentId: root, x: 0, y: 0, props: { fileId, pageIndex } })
      records.apply([pdf('file:pdf', hash), pdf('file:new', 'c'.repeat(64)), page('node:p1', 'file:pdf', 0), page('node:p2', 'file:pdf', 1), page('node:n1', 'file:new', 0)], [])
      const bounds = { x: 0, y: 0, w: 10, h: 10 }
      records.putRef(ref({ kind: 'canvas', canvasId: root, rect: bounds, nodes: ['node:p1', 'node:p2', 'node:n1'].map((id) => ({ id, bounds })) }))
      const result = await call(client, 'resolve_reference', { id: 'ref:Ab12Cd34Ef' })
      const textPath = join(dataDir, 'assets', `${hash}.txt`)
      expect(result.data.content.nodes).toEqual([
        { id: 'node:p1', type: 'pdf-page', bounds, page: 1, file: { id: 'file:pdf', kind: 'pdf', title: 'file:pdf', path: '', pageCount: 2, textPath } },
        { id: 'node:p2', type: 'pdf-page', bounds, page: 2, file: { id: 'file:pdf', kind: 'pdf', title: 'file:pdf', path: '', pageCount: 2, textPath } },
        { id: 'node:n1', type: 'pdf-page', bounds, page: 1, file: { id: 'file:new', kind: 'pdf', title: 'file:new', path: '', pageCount: 2 } },
      ])
    })

    it('returns the part of a PDF page a canvas region covered, and says when it is a figure', async () => {
      const { client, records, refImages } = await setup()
      const root = records.rootCanvasId
      const page = (id: string, pageIndex: number) => ({ typeName: 'node', id, type: 'pdf-page', parentId: root, x: 0, y: 0, props: { fileId: 'file:pdf', pageIndex } })
      records.apply([page('node:p1', 0), page('node:p2', 1)], [])
      const bounds = { x: 0, y: 0, w: 10, h: 10 }
      const rect = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }
      records.putRef(
        ref({
          kind: 'canvas',
          canvasId: root,
          rect: bounds,
          nodes: [
            { id: 'node:p1', bounds, pdf: { fileId: 'file:pdf', pageIndex: 0, rect, text: 'この段落' } },
            { id: 'node:p2', bounds, pdf: { fileId: 'file:pdf', pageIndex: 1, rect, text: '', figure: true } },
          ],
        }),
      )
      const unit = 'fraction of the page (0-1, origin at the top left)'
      const result = await call(client, 'resolve_reference', { id: 'ref:Ab12Cd34Ef' })
      expect(result.data.content.nodes.map((n: { region?: unknown }) => n.region)).toEqual([
        { rect, rectUnit: unit, text: 'この段落' },
        { rect, rectUnit: unit, text: '', figure: true, note: expect.stringContaining('no image was attached') },
      ])

      // 引用ツールから作る PDF の範囲も、図なら画像を見るよう伝える
      records.putRef(ref({ id: 'ref:Zz99Zz99Zz', kind: 'pdf', fileId: 'file:pdf', pageIndex: 1, rect, text: '', figure: true }))
      await refImages.save('ref:Zz99Zz99Zz', PNG, { x: 0, y: 0, w: 10, h: 10 }, new Date(Date.UTC(2026, 8, 25)))
      const pdf = await client.callTool({ name: 'resolve_reference', arguments: { id: 'ref:Zz99Zz99Zz' } })
      const content = pdf.content as { type: string; text?: string }[]
      expect(content.map((c) => c.type)).toEqual(['image', 'text'])
      expect(JSON.parse(content[1]!.text!).content).toMatchObject({ figure: true, note: expect.stringContaining('look at the attached image') })
    })

    // 手書き線のある範囲は、画像を先に、JSON をあとに返す（MAI-64）
    describe('with a freehand stroke', () => {
      async function drawRef() {
        const env = await setup()
        const root = env.records.rootCanvasId
        env.records.apply(
          [
            { typeName: 'node', id: 'node:group', type: 'group', parentId: root, x: 0, y: 0, props: {} },
            { typeName: 'node', id: 'node:ink', type: 'draw', parentId: 'node:group', x: 0, y: 0, props: { points: [0, 0, 10, 5, 20, 0], color: '#e03131', size: 4, isComplete: true } },
          ],
          [],
        )
        const bounds = { x: 0, y: 0, w: 20, h: 5 }
        env.records.putRef(ref({ kind: 'canvas', canvasId: root, rect: { x: -10, y: -10, w: 400, h: 200 }, nodes: [{ id: 'node:group', bounds }] }))
        return env
      }

      it('returns the image first, and says how its pixels map to the canvas', async () => {
        const { client, refImages } = await drawRef()
        await refImages.save('ref:Ab12Cd34Ef', PNG, { x: -10, y: -10, w: 400, h: 200 }, new Date(Date.UTC(2026, 8, 25)))
        const result = await client.callTool({ name: 'resolve_reference', arguments: { id: 'ref:Ab12Cd34Ef' } })
        const content = result.content as { type: string; text?: string; data?: string; mimeType?: string }[]
        expect(content.map((c) => c.type)).toEqual(['image', 'text'])
        expect(content[0]).toMatchObject({ mimeType: 'image/png', data: PNG.toString('base64') })
        const data = JSON.parse(content[1]!.text!)
        expect(data.image).toMatchObject({ x: -10, y: -10, w: 400, h: 200, scale: 2, capturedAt: '2026-09-25T00:00:00.000Z' })
        expect(data.content.nodes[0].children).toEqual([
          { id: 'node:ink', type: 'draw', parentId: 'node:group', color: '#e03131', size: 4, pointCount: 3, note: expect.stringContaining('look at the attached image') },
        ])
      })

      it('returns only the JSON while there is no image', async () => {
        const { client } = await drawRef()
        const result = await client.callTool({ name: 'resolve_reference', arguments: { id: 'ref:Ab12Cd34Ef' } })
        const content = result.content as { type: string; text: string }[]
        expect(content.map((c) => c.type)).toEqual(['text'])
        const data = JSON.parse(content[0]!.text)
        expect(data.image).toBeUndefined()
        expect(data.content.nodes[0].children[0]).toMatchObject({ type: 'draw', color: '#e03131', size: 4, pointCount: 3 })
        expect(data.content.nodes[0].children[0].points).toBeUndefined()
      })
    })

    it('reports an unknown reference as a tool error', async () => {
      const { client } = await setup()
      const result = await call(client, 'resolve_reference', { id: 'ref:Zz99Zz99Zz' })
      expect(result.isError).toBe(true)
      expect(result.text).toContain('copy it again')
      expect(result.text).toContain('deleted 3 days after')
    })
  })
})
