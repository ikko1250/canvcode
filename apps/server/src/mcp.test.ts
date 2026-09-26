import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { FileStore, type FileEvent } from './files.ts'
import { handleMcp, MCP_PATH } from './mcp.ts'
import { RecordStore } from './records.ts'
import { RefImageStore } from './refImages.ts'
import { SlidesApi } from './slides.ts'

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
  const slides = new SlidesApi(files, workspace, 0, dataDir)
  const refImages = new RefImageStore(dataDir)
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    void (async () => {
      if (await slides.handle(req, res, url.pathname, url.searchParams)) return
      if (!(await handleMcp(req, res, url.pathname, { files, records, dataDir, slides, refImages }))) res.writeHead(404).end()
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}${MCP_PATH}`)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(url))
  cleanups.push(() => client.close())
  return { client, files, records, refImages, dataDir, events, url, workspace }
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
      'create_slide_deck',
      'edit_document',
      'get_slide_format',
      'list_documents',
      'preview_slide_deck',
      'read_document',
      'read_slide_deck',
      'resolve_reference',
      'update_document',
      'update_slide_deck',
    ])
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
          node('node:gone', 'geo', root, { label: 'x' }),
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
            { id: 'node:gone', bounds },
          ],
        }),
      )
      const result = await call(client, 'resolve_reference', { id: 'ref:Ab12Cd34Ef' })
      expect(result.data.location).toMatchObject({ canvasId: root, canvasTitle: 'ホーム', canvasPath: ['ホーム'], status: 'ok' })
      expect(result.data.content.nodes).toEqual([
        { id: 'node:frame', type: 'frame', name: '設計', bounds, children: [{ id: 'node:note', type: 'note', parentId: 'node:frame', text: 'ここを直す' }] },
        { id: 'node:card', type: 'markdown-card', bounds, file: { id: doc.id, kind: 'markdown', title: 'メモ', path: 'メモ.md', absPath: join(workspace, 'メモ.md') } },
        { id: 'node:gone', type: 'unknown', bounds, deleted: true },
      ])
      expect(result.data.content.truncated).toBe(false)
      expect(result.data.warnings.join()).toContain('deleted')
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
      const PNG = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
        Buffer.from('IHDR', 'ascii'),
        Buffer.from([0, 0, 3, 32, 0, 0, 1, 144, 8, 6, 0, 0, 0, 0, 0, 0, 0]),
      ])

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

describe('MCP slide decks', () => {
  const deck = '# 表紙 {#cover}\n## 副題\n\n# 要点\n\n- 一つ目\n  - 子\n- 二つ目\n'

  it('explains the format with examples that are valid decks', async () => {
    const { client } = await setup()
    const guide = (await client.callTool({ name: 'get_slide_format', arguments: {} })).content as { text: string }[]
    const text = guide[0]!.text
    const markdown = text.match(/~~~markdown\n([\s\S]*?)\n~~~/)?.[1]
    const json = text.match(/~~~json\n([\s\S]*?)\n~~~/)?.[1]
    expect(markdown).toBeTruthy()
    expect(json).toBeTruthy()
    // 例の画像は無いが、作るときには画像を読まないので、デッキとしては受け付ける
    const fromMarkdown = await call(client, 'create_slide_deck', { title: 'md', content: markdown })
    expect(fromMarkdown.isError, fromMarkdown.text).toBe(false)
    expect(fromMarkdown.data.slides.map((s: { layout: string }) => s.layout)).toEqual(['title', 'bullets', 'table', 'table-image', 'table-image', 'table-images'])
    const fromJson = await call(client, 'create_slide_deck', { title: 'json', content: json, format: 'json' })
    expect(fromJson.isError, fromJson.text).toBe(false)
    expect(fromJson.data.document.path).toBe('json.slide.json')
  })

  it('creates a deck, gives slides ids, and reads it back with an outline', async () => {
    const { client, events, workspace } = await setup()
    const created = await call(client, 'create_slide_deck', { title: '発表', content: deck })
    expect(created.data.document).toMatchObject({ kind: 'slides', title: '発表', path: '発表.slide.md' })
    expect(events).toContainEqual(expect.objectContaining({ type: 'file-added' }))
    const saved = readFileSync(join(workspace, '発表.slide.md'), 'utf8')
    expect(saved).toContain('# 表紙 {#cover}')
    expect(saved).toMatch(/^# 要点 \{#s-[a-z0-9]{6}\}$/m)

    const listed = await call(client, 'list_documents', { kind: 'slides' })
    expect(listed.data.documents).toEqual([created.data.document])

    const read = await call(client, 'read_slide_deck', { id: created.data.document.id })
    expect(read.data).toMatchObject({ format: 'md', hash: created.data.hash, text: saved, warnings: [] })
    expect(read.data.slides).toEqual([
      { number: 1, id: 'cover', layout: 'title', title: '表紙' },
      { number: 2, id: expect.stringMatching(/^s-/), layout: 'bullets', title: '要点' },
    ])
  })

  it('refuses decks that cannot be read, and reports the line', async () => {
    const { client, files } = await setup()
    const bad = await call(client, 'create_slide_deck', { title: 'bad', content: '# 表\n\n| a | b | c |\n' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain(':3:')
    expect(files.list()).toEqual([])

    const created = await call(client, 'create_slide_deck', { title: 'deck', content: deck })
    const id = created.data.document.id
    const edit = await call(client, 'edit_document', { id, old_string: '- 二つ目', new_string: '段落' })
    expect(edit.isError).toBe(true)
    const replace = await call(client, 'update_slide_deck', { id, content: 'no heading' })
    expect(replace.isError).toBe(true)
    expect((await files.read(id)).hash).toBe(created.data.hash)
  })

  it('replaces a deck, keeping ids, and detects a stale hash', async () => {
    const { client, files, events } = await setup()
    const created = await call(client, 'create_slide_deck', { title: 'deck', content: deck })
    const id = created.data.document.id
    const next = '# 表紙 {#cover}\n\n# 指標 {#metrics}\n\n| 売上 | 1.2 億円 |\n'
    const updated = await call(client, 'update_slide_deck', { id, content: next, expected_hash: created.data.hash })
    expect(updated.data.slides.map((s: { id: string }) => s.id)).toEqual(['cover', 'metrics'])
    expect((await files.read(id)).text).toBe(next)
    expect(events.at(-1)).toMatchObject({ type: 'file-changed', file: { id } })

    const stale = await call(client, 'update_slide_deck', { id, content: deck, expected_hash: created.data.hash })
    expect(stale.isError).toBe(true)
    expect(stale.text).toContain('changed since you read it')
  })

  it('returns lint warnings for overflowing slides', async () => {
    const { client } = await setup()
    const long = 'とても長い本文'.repeat(40)
    const created = await call(client, 'create_slide_deck', { title: 'long', content: `# 長い\n\n| 項目 | ${long} |\n` })
    expect(created.isError).toBe(false)
    expect(created.data.warnings.length).toBeGreaterThan(0)
  })

  it('returns the slide images, and a tool error while they cannot be made', async () => {
    const { client, url, workspace } = await setup()
    const created = await call(client, 'create_slide_deck', { title: 'deck', content: deck })
    const id = created.data.document.id
    // テストの環境ではプレビューの画面が無く、画像は作れない
    const failed = await client.callTool({ name: 'preview_slide_deck', arguments: { id, slides: [2] } })
    expect(failed.isError).toBe(true)
    const outOfRange = await call(client, 'preview_slide_deck', { id, slides: [3] })
    expect(outOfRange.isError).toBe(true)
    expect(outOfRange.text).toContain('全 2 枚')

    // 撮った画像があれば、それを返す
    const pages = await (await fetch(new URL(`/api/slides/${encodeURIComponent(id)}/pages`, url))).json() as { pages: { hash: string }[] }
    const png = Buffer.from('\x89PNG\r\n\x1a\n', 'binary')
    mkdirSync(join(workspace, '.canvcode', 'slide-pages'), { recursive: true })
    for (const page of pages.pages) writeFileSync(join(workspace, '.canvcode', 'slide-pages', `${page.hash}.png`), png)
    const result = await client.callTool({ name: 'preview_slide_deck', arguments: { id } })
    expect(result.isError).toBeFalsy()
    const content = result.content as { type: string; text?: string; data?: string; mimeType?: string }[]
    expect(content.filter((c) => c.type === 'image')).toHaveLength(2)
    expect(content[0]).toMatchObject({ type: 'text', text: 'Slide 1 {#cover}: 表紙' })
    expect(content[1]).toMatchObject({ type: 'image', mimeType: 'image/png', data: png.toString('base64') })
  })
})
