import type { IncomingMessage, ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { normalizeRefId } from '@canvcode/core'
import { HttpError, type FileInfo } from './files.ts'
import { resolveReference, type RefDeps } from './refs.ts'

// AI から CanvCode を使うための MCP サーバー（MAI-59）。
// - Claude Code などが Streamable HTTP で /mcp につなぐ（claude mcp add --transport http canvcode http://127.0.0.1:8787/mcp）
// - 第 1 段は Markdown / Python の File の読み書きだけ。本文は FileStore（実ファイル）を通すので、レコードには触れない
// - 書いたら開いているブラウザに知らせる。ブラウザは保存していない編集がなければ読み直し、あれば衝突として尋ねる
// - セッションは持たない（要求ごとにサーバーを作る）
// - ユーザーが CanvCode で範囲を選んでコピーした ref:XXXXXXXXXX は、resolve_reference で中身にする

export const MCP_PATH = '/mcp'

export type McpDeps = RefDeps

export function createMcpServer(deps: McpDeps): McpServer {
  const { files } = deps
  const server = new McpServer(
    { name: 'canvcode', version: '0.1.0' },
    {
      instructions:
        'CanvCode is an infinite canvas whose Markdown (.md) and Python (.py) documents are real files. ' +
        'Use list_documents to find a document id, read_document before editing, and prefer edit_document for small changes. ' +
        'New documents appear under "未配置" (unplaced) in the sidebar; the user places them on a canvas. ' +
        'When the user\'s message contains an id like ref:XXXXXXXXXX, it points at a place the user selected in CanvCode ' +
        '(a region of a canvas, lines of a document, or a region of a PDF page): call resolve_reference with it first. ' +
        'Document ids (file:...) in its result can be passed to read_document.',
    },
  )

  server.registerTool(
    'list_documents',
    {
      title: 'List documents',
      description: 'List Markdown and Python documents in the workspace. Filter by a substring of the title or path, and by kind.',
      inputSchema: {
        query: z.string().optional().describe('Case-insensitive substring of the title or path'),
        kind: z.enum(['markdown', 'code']).optional().describe('markdown (.md) or code (.py)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, kind }) => {
      const needle = query?.toLowerCase()
      const found = files
        .list()
        .filter((f) => !kind || f.kind === kind)
        .filter((f) => !needle || f.title.toLowerCase().includes(needle) || f.path.toLowerCase().includes(needle))
        .sort((a, b) => a.path.localeCompare(b.path))
        .map(summary)
      return json({ documents: found })
    },
  )

  server.registerTool(
    'read_document',
    {
      title: 'Read a document',
      description: 'Read the full text of a document. The returned hash can be passed to update_document as expected_hash.',
      inputSchema: { id: z.string().describe('Document id (file:...) from list_documents') },
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      guard(async () => {
        const { text, hash } = await files.read(id)
        return json({ id, hash, text })
      }),
  )

  server.registerTool(
    'resolve_reference',
    {
      title: 'Resolve a reference',
      description:
        'Resolve a reference id (ref:XXXXXXXXXX) that the user copied in CanvCode to show you what to look at. ' +
        'Returns the location (canvas region, document lines, or PDF page region) and its content: the current text of the lines, ' +
        'the nodes in the canvas region (with document ids you can pass to read_document), or the text in the PDF region.',
      inputSchema: { id: z.string().describe('Reference id, e.g. ref:Ab12Cd34Ef (the ref: prefix may be omitted)') },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const normalized = normalizeRefId(id)
      const ref = normalized ? deps.records.getRef(normalized) : undefined
      if (!ref) return error(`Unknown reference id ${normalized ?? JSON.stringify(id)}. Ask the user to copy it again from CanvCode.`)
      return json(await resolveReference(ref, deps))
    },
  )

  server.registerTool(
    'create_document',
    {
      title: 'Create a document',
      description: 'Create a new Markdown or Python document. It is added to the workspace as unplaced; the user can place it on a canvas from the sidebar.',
      inputSchema: {
        kind: z.enum(['markdown', 'code']).describe('markdown (.md) or code (.py)'),
        title: z.string().describe('File name without the extension. A number is appended if the name is taken'),
        content: z.string().default('').describe('Initial text'),
      },
    },
    ({ kind, title, content }) =>
      guard(async () => {
        const info = await files.create(kind, title, content, { announce: true })
        return json({ document: summary(info), hash: info.hash })
      }),
  )

  server.registerTool(
    'update_document',
    {
      title: 'Replace a document',
      description:
        'Replace the whole text of a document. Pass expected_hash (from read_document) to refuse the write if the document changed since you read it.',
      inputSchema: {
        id: z.string().describe('Document id (file:...)'),
        content: z.string().describe('New full text'),
        expected_hash: z.string().optional().describe('Hash from read_document'),
      },
      annotations: { destructiveHint: true },
    },
    ({ id, content, expected_hash }) =>
      guard(async () => {
        const info = await files.write(id, content, expected_hash ?? '', { announce: true })
        return json({ document: summary(info), hash: info.hash })
      }),
  )

  server.registerTool(
    'edit_document',
    {
      title: 'Edit part of a document',
      description:
        'Replace an exact string in a document. old_string must appear exactly once unless replace_all is true. Line endings are matched as LF.',
      inputSchema: {
        id: z.string().describe('Document id (file:...)'),
        old_string: z.string().min(1).describe('Exact text to replace'),
        new_string: z.string().describe('Replacement text'),
        replace_all: z.boolean().default(false).describe('Replace every occurrence'),
      },
    },
    ({ id, old_string, new_string, replace_all }) =>
      guard(async () => {
        const { text: raw, hash } = await files.read(id)
        // 改行コードは元のまま保つ（ブラウザの編集と同じ。MAI-10）
        const crlf = raw.includes('\r\n')
        const text = crlf ? raw.replace(/\r\n/g, '\n') : raw
        const from = old_string.replace(/\r\n/g, '\n')
        const to = new_string.replace(/\r\n/g, '\n')
        const count = text.split(from).length - 1
        if (count === 0) return error('old_string was not found in the document. Read it again and copy the text exactly.')
        if (count > 1 && !replace_all) {
          return error(`old_string appears ${count} times. Add surrounding text to make it unique, or set replace_all.`)
        }
        const next = replace_all ? text.split(from).join(to) : text.replace(from, () => to)
        const info = await files.write(id, crlf ? next.replace(/\n/g, '\r\n') : next, hash, { announce: true })
        return json({ document: summary(info), hash: info.hash, replaced: replace_all ? count : 1 })
      }),
  )

  return server
}

// /mcp を扱う。扱わないパスなら false を返す
export async function handleMcp(req: IncomingMessage, res: ServerResponse, path: string, deps: McpDeps): Promise<boolean> {
  if (path !== MCP_PATH) return false
  if (req.method !== 'POST') {
    // セッションを持たないので、GET（通知の購読）と DELETE（セッションの終了）は受けない
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'POST' })
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }))
    return true
  }
  const server = createMcpServer(deps)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res)
  } catch (err) {
    console.error('mcp request failed', err)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }))
    }
  }
  return true
}

function summary(info: FileInfo): Pick<FileInfo, 'id' | 'kind' | 'title' | 'path' | 'missing'> {
  return { id: info.id, kind: info.kind, title: info.title, path: info.path, missing: info.missing }
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function error(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

// FileStore の失敗（HttpError）を、AI が読めるツールのエラーにする
async function guard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run()
  } catch (err) {
    if (!(err instanceof HttpError)) throw err
    if (err.status === 409) return error('The document was changed since you read it. Call read_document again and retry.')
    if (err.status === 404) return error(`${err.message}. Use list_documents to find a valid id.`)
    return error(err.message)
  }
}
