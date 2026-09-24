import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

// AI から使う MCP サーバー（MAI-59）

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(): Promise<{ client: Client; files: FileStore; records: RecordStore; dataDir: string; events: FileEvent[]; url: URL }> {
  const workspace = mkdtempSync(join(tmpdir(), 'canvcode-mcp-'))
  cleanups.push(() => rmSync(workspace, { recursive: true, force: true }))
  const events: FileEvent[] = []
  const files = new FileStore(workspace, join(workspace, '.canvcode'), (event) => events.push(event))
  await files.init()
  cleanups.push(() => files.close())
  const dataDir = join(workspace, '.canvcode')
  const records = new RecordStore(dataDir)
  cleanups.push(() => records.close())
  const server: Server = createServer((req, res) => {
    void handleMcp(req, res, new URL(req.url ?? '/', 'http://127.0.0.1').pathname, { files, records, dataDir }).then((handled) => {
      if (!handled) res.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}${MCP_PATH}`)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(url))
  cleanups.push(() => client.close())
  return { client, files, records, dataDir, events, url }
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
      'edit_document',
      'list_documents',
      'read_document',
      'resolve_reference',
      'update_document',
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
      const { client, files, records } = await setup()
      const file = await files.create('code', 'main', 'import os\ndef f():\n    return 1\n')
      records.putRef(ref({ kind: 'lines', fileId: file.id, startLine: 2, endLine: 3, snapshot: 'def f():\n    return 1' }))

      const same = await call(client, 'resolve_reference', { id: 'ref:Ab12Cd34Ef' })
      expect(same.data).toMatchObject({
        id: 'ref:Ab12Cd34Ef',
        kind: 'lines',
        openPath: '/r/ref%3AAb12Cd34Ef',
        location: { fileId: file.id, path: 'main.py', fileKind: 'code', startLine: 2, endLine: 3, status: 'unchanged' },
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
      const { client, files, records } = await setup()
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
        { id: 'node:card', type: 'markdown-card', bounds, file: { id: doc.id, kind: 'markdown', title: 'メモ', path: 'メモ.md' } },
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
    })

    it('reports an unknown reference as a tool error', async () => {
      const { client } = await setup()
      const result = await call(client, 'resolve_reference', { id: 'ref:Zz99Zz99Zz' })
      expect(result.isError).toBe(true)
      expect(result.text).toContain('copy it again')
    })
  })
})
