import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { resolveLines, validateReference, type Box, type ReferenceRecord } from '@canvcode/core'
import { HttpError, type FileStore } from './files.ts'
import { RefConflictError, type RecordStore, type StoredRecord } from './records.ts'

// AI に見てほしい場所の参照（ref）。
// - POST /api/refs：ブラウザが作った ref を保存する（ID もブラウザが作る。クリップボードにすぐ書けるように）
// - GET /api/refs/<id>：ref を返す（/r/<id> を開いたとき）
// - resolveReference：ref を、AI が読める中身にする（MCP の resolve_reference）

const REFS_PATH = '/api/refs'
const MAX_BODY = 1024 * 1024

export async function handleRefs(req: IncomingMessage, res: ServerResponse, path: string, records: RecordStore): Promise<boolean> {
  if (path === REFS_PATH) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    let ref: ReferenceRecord
    try {
      ref = validateReference(JSON.parse((await readBody(req)).toString('utf8')))
    } catch (error) {
      sendJson(res, error instanceof HttpError ? error.status : 400, { error: error instanceof Error ? error.message : 'invalid reference' })
      return true
    }
    try {
      records.putRef(ref)
    } catch (error) {
      if (error instanceof RefConflictError) {
        sendJson(res, 409, { error: error.message })
        return true
      }
      throw error
    }
    sendJson(res, 201, { id: ref.id })
    return true
  }
  if (!path.startsWith(`${REFS_PATH}/`)) return false
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  let id: string
  try {
    id = decodeURIComponent(path.slice(REFS_PATH.length + 1))
  } catch {
    sendJson(res, 400, { error: 'invalid id' })
    return true
  }
  const ref = records.getRef(id)
  if (ref) sendJson(res, 200, ref)
  else sendJson(res, 404, { error: 'reference not found' })
  return true
}

export interface RefDeps {
  records: RecordStore
  files: FileStore
  dataDir: string
}

const MAX_NODES = 300
const MAX_NODE_TEXT = 4000
const MAX_PAGE_TEXT = 8000

export interface DescribedNode {
  id: string
  type: string
  parentId?: string
  bounds?: Box
  deleted?: true
  text?: string
  label?: string
  name?: string
  memo?: string
  quote?: string
  file?: { id: string; kind?: string; title?: string; path?: string; missing?: boolean }
  target?: { id: string; title?: string }
  page?: number
  slide?: number
  assetId?: string
  children?: DescribedNode[]
}

// ref を、AI に返す中身にする。指している先が消えていても投げず、status と warnings で知らせる
export async function resolveReference(ref: ReferenceRecord, deps: RefDeps): Promise<Record<string, unknown>> {
  const head = {
    id: ref.id,
    kind: ref.kind,
    createdAt: new Date(ref.createdAt).toISOString(),
    openPath: `/r/${encodeURIComponent(ref.id)}`,
  }
  const warnings: string[] = []
  if (ref.kind === 'lines') {
    const file = fileSummary(ref.fileId, deps)
    const location = {
      fileId: ref.fileId,
      ...(file ? { title: file.title, path: file.path, fileKind: file.kind } : {}),
      originalStartLine: ref.startLine,
      originalEndLine: ref.endLine,
    }
    let text: string
    try {
      text = (await deps.files.read(ref.fileId)).text
    } catch (error) {
      if (!(error instanceof HttpError)) throw error
      warnings.push('The file could not be read (it was deleted or moved outside CanvCode). Showing the lines as they were when the reference was made.')
      return { ...head, warnings, location: { ...location, startLine: ref.startLine, endLine: ref.endLine, status: 'missing-file' }, content: { text: ref.snapshot } }
    }
    const found = resolveLines(text, ref)
    if (trashed(ref.fileId, deps)) warnings.push('The file is in the trash.')
    if (found.status === 'moved') {
      warnings.push(`The text moved: now lines ${found.startLine}-${found.endLine} (was ${ref.startLine}-${ref.endLine}).`)
    } else if (found.status === 'lost') {
      warnings.push('The referenced lines were edited and could not be found. Showing the same line numbers from the current file; the original text is in content.snapshot.')
    }
    return {
      ...head,
      warnings,
      location: { ...location, startLine: found.startLine, endLine: found.endLine, status: found.status },
      content: { text: found.text, ...(found.status === 'unchanged' ? {} : { snapshot: ref.snapshot }) },
    }
  }
  if (ref.kind === 'pdf') {
    const record = deps.records.get(ref.fileId)
    if (!record) warnings.push('The PDF was deleted from the workspace.')
    else if (record.deletedAt) warnings.push('The PDF is in the trash.')
    const pageText = record ? await pdfPageText(record, ref.pageIndex, deps.dataDir) : null
    return {
      ...head,
      warnings,
      location: {
        fileId: ref.fileId,
        ...(record ? { title: record.title, path: record.path } : {}),
        page: ref.pageIndex + 1,
        pageIndex: ref.pageIndex,
        rect: ref.rect,
        rectUnit: 'fraction of the page (0-1, origin at the top left)',
      },
      content: {
        text: ref.text,
        ...(pageText === null ? {} : { pageText: truncate(pageText, MAX_PAGE_TEXT) }),
      },
    }
  }
  // canvas
  const canvas = deps.records.get(ref.canvasId)
  const status = !canvas ? 'missing' : canvas.deletedAt ? 'trashed' : 'ok'
  if (status === 'missing') warnings.push('The canvas was deleted.')
  if (status === 'trashed') warnings.push('The canvas is in the trash.')
  warnings.push('Bounds are world coordinates recorded when the reference was made; nodes may have moved since.')
  const budget = { left: MAX_NODES, truncated: false }
  const nodes: DescribedNode[] = []
  for (const { id, bounds } of ref.nodes) {
    if (budget.left <= 0) {
      budget.truncated = true
      break
    }
    budget.left--
    const record = deps.records.get(id)
    if (!record) {
      nodes.push({ id, type: 'unknown', bounds, deleted: true })
      continue
    }
    nodes.push({ ...describeNode(record, deps, budget), bounds })
  }
  if (ref.nodes.some(({ id }) => !deps.records.get(id))) warnings.push('Some nodes were deleted after the reference was made.')
  return {
    ...head,
    warnings,
    location: {
      canvasId: ref.canvasId,
      ...(canvas ? { canvasTitle: canvas.title, canvasPath: canvasPath(ref.canvasId, deps) } : {}),
      rect: ref.rect,
      status,
    },
    content: { nodes, truncated: budget.truncated },
  }
}

// ノードを、AI が読める形にする。ノードの型は @canvcode/nodes にあるが、サーバーは読み込まないので props を構造的に読む
function describeNode(record: StoredRecord, deps: RefDeps, budget: { left: number; truncated: boolean }): DescribedNode {
  const props = (record.props ?? {}) as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : 'unknown'
  const out: DescribedNode = { id: record.id, type }
  if (typeof record.parentId === 'string' && !record.parentId.startsWith('canvas:')) out.parentId = record.parentId
  const str = (key: string): string | undefined => {
    const value = props[key]
    return typeof value === 'string' && value !== '' ? truncate(value, MAX_NODE_TEXT) : undefined
  }
  const file = (key = 'fileId'): DescribedNode['file'] => {
    const id = props[key]
    if (typeof id !== 'string' || !id) return undefined
    const info = fileSummary(id, deps)
    return info ? { id, kind: info.kind, title: info.title, path: info.path, ...(info.missing ? { missing: true } : {}) } : { id }
  }
  switch (type) {
    case 'text':
    case 'note':
      out.text = str('text')
      break
    case 'geo':
    case 'arrow':
      out.label = str('label')
      break
    case 'frame':
      out.name = str('name')
      break
    case 'markdown-card':
      out.file = file()
      if (!out.file) out.text = str('inlineText')
      break
    case 'code-card':
    case 'slide-deck-card':
      out.file = file()
      break
    case 'quote-card':
      out.quote = str('quote')
      out.memo = str('memo')
      out.file = file()
      break
    case 'pdf-page':
      out.file = file()
      if (typeof props.pageIndex === 'number') out.page = props.pageIndex + 1
      break
    case 'slide-page':
      out.file = file()
      if (typeof props.slideIndex === 'number') out.slide = props.slideIndex + 1
      break
    case 'portal': {
      const id = props.targetId
      if (typeof id === 'string') {
        const target = deps.records.get(id)
        out.target = { id, ...(typeof target?.title === 'string' ? { title: target.title } : {}) }
      }
      break
    }
    case 'image':
      if (typeof props.assetId === 'string') out.assetId = props.assetId
      break
  }
  if (type === 'group' || type === 'frame') {
    const children: DescribedNode[] = []
    for (const child of deps.records.childrenOf(record.id)) {
      if (child.typeName !== 'node') continue
      if (budget.left <= 0) {
        budget.truncated = true
        break
      }
      budget.left--
      children.push(describeNode(child, deps, budget))
    }
    if (children.length) out.children = children
  }
  for (const key of Object.keys(out) as (keyof DescribedNode)[]) if (out[key] === undefined) delete out[key]
  return out
}

function fileSummary(id: string, deps: RefDeps): { kind: string; title: string; path: string; missing: boolean } | undefined {
  try {
    const info = deps.files.getInfo(id)
    return { kind: info.kind, title: info.title, path: info.path, missing: info.missing }
  } catch {
    // FileStore が扱わない File（PDF）はレコードから
    const record = deps.records.get(id)
    if (!record || record.typeName !== 'file') return undefined
    return { kind: String(record.kind), title: String(record.title), path: String(record.path), missing: record.missing === true }
  }
}

function trashed(id: string, deps: RefDeps): boolean {
  return Boolean(deps.records.get(id)?.deletedAt)
}

// ルートから Canvas までの題名
function canvasPath(canvasId: string, deps: RefDeps): string[] {
  const path: string[] = []
  const seen = new Set<string>()
  for (let id: unknown = canvasId; typeof id === 'string' && !seen.has(id); ) {
    seen.add(id)
    const record = deps.records.get(id)
    if (!record) break
    path.unshift(String(record.title ?? ''))
    id = record.parentCanvasId
  }
  return path
}

async function pdfPageText(file: StoredRecord, pageIndex: number, dataDir: string): Promise<string | null> {
  const assetId = file.assetId
  if (typeof assetId !== 'string' || !assetId.startsWith('asset:')) return null
  const hash = assetId.slice('asset:'.length)
  if (!/^[0-9a-f]{64}$/.test(hash)) return null
  try {
    const data = JSON.parse(await readFile(join(dataDir, 'assets', `${hash}.pages.json`), 'utf8')) as { pages?: unknown }
    const page = Array.isArray(data.pages) ? data.pages[pageIndex] : undefined
    return typeof page === 'string' ? page : null
  } catch {
    return null
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…（${text.length - max} 文字省略）` : text
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > MAX_BODY) throw new HttpError(413, 'too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
