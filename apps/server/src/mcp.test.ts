import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { FileStore, type FileEvent } from './files.ts'
import { handleMcp, MCP_PATH } from './mcp.ts'

// AI から使う MCP サーバー（MAI-59）

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(): Promise<{ client: Client; files: FileStore; events: FileEvent[]; url: URL }> {
  const workspace = mkdtempSync(join(tmpdir(), 'canvcode-mcp-'))
  cleanups.push(() => rmSync(workspace, { recursive: true, force: true }))
  const events: FileEvent[] = []
  const files = new FileStore(workspace, join(workspace, '.canvcode'), (event) => events.push(event))
  await files.init()
  cleanups.push(() => files.close())
  const server: Server = createServer((req, res) => {
    void handleMcp(req, res, new URL(req.url ?? '/', 'http://127.0.0.1').pathname, files).then((handled) => {
      if (!handled) res.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}${MCP_PATH}`)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(url))
  cleanups.push(() => client.close())
  return { client, files, events, url }
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
    expect(tools.map((t) => t.name).sort()).toEqual(['create_document', 'edit_document', 'list_documents', 'read_document', 'update_document'])
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
})
