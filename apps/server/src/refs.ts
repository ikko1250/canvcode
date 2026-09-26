import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { resolveLines, validateReference, type Box, type PdfRegion, type ReferenceRecord } from '@canvcode/core'
import { ensurePdfTextFile } from './assets.ts'
import { HttpError, type FileStore } from './files.ts'
import { RefConflictError, type RecordStore, type StoredRecord } from './records.ts'
import { MAX_REF_IMAGE_BYTES, RefImageExistsError, type RefImageInfo, type RefImageStore } from './refImages.ts'

// AI に見てほしい場所の参照（ref）。
// - POST /api/refs：ブラウザが作った ref を保存する（ID もブラウザが作る。クリップボードにすぐ書けるように）
// - GET /api/refs/<id>：ref を返す（/r/<id> を開いたとき）
// - PUT /api/refs/<id>/image?x=&y=&w=&h=：範囲を描いた PNG を ref に添える（MAI-64。x〜h は描いたワールド座標の範囲）
// - resolveReference：ref を、AI が読める中身にする（MCP の resolve_reference）

const REFS_PATH = '/api/refs'
const MAX_BODY = 1024 * 1024

export async function handleRefs(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  records: RecordStore,
  images?: RefImageStore,
  search: URLSearchParams = new URLSearchParams(),
): Promise<boolean> {
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
  if (images && path.endsWith('/image')) return handleImage(req, res, path.slice(REFS_PATH.length + 1, -'/image'.length), records, images, search)
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

async function handleImage(
  req: IncomingMessage,
  res: ServerResponse,
  rawId: string,
  records: RecordStore,
  images: RefImageStore,
  search: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'PUT') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  let id: string
  try {
    id = decodeURIComponent(rawId)
  } catch {
    id = ''
  }
  if (!records.getRef(id)) {
    sendJson(res, 404, { error: 'reference not found' })
    return true
  }
  if ((req.headers['content-type'] ?? '') !== 'image/png') {
    sendJson(res, 415, { error: 'png only' })
    return true
  }
  const [x, y, w, h] = ['x', 'y', 'w', 'h'].map((key) => Number(search.get(key) ?? NaN))
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
    sendJson(res, 400, { error: 'x, y, w and h are required' })
    return true
  }
  try {
    const info = await images.save(id, await readBody(req, MAX_REF_IMAGE_BYTES), { x, y, w, h })
    sendJson(res, 201, info)
  } catch (error) {
    if (error instanceof RefImageExistsError) sendJson(res, 409, { error: error.message })
    else if (error instanceof HttpError) sendJson(res, error.status, { error: error.message })
    else sendJson(res, 400, { error: error instanceof Error ? error.message : 'invalid image' })
  }
  return true
}

export interface RefDeps {
  records: RecordStore
  files: FileStore
  dataDir: string
  // ref に添えた画像（MAI-64）。なければ、画像は返さない
  refImages?: RefImageStore
}

const MAX_NODES = 300
const MAX_NODE_TEXT = 4000
const MAX_PAGE_TEXT = 8000
const PDF_TEXTLESS = 'The PDF has no extractable text (it may be scanned images).'

// 文書の場所。本文は入れず、AI が自分で読めるよう絶対パスを付ける（Markdown / Python は absPath、PDF は取り出したテキストの textPath）。
// AI は CanvCode のサーバーと同じマシンで動いている前提
export interface FileSummary {
  kind?: string
  title?: string
  path?: string
  absPath?: string
  textPath?: string
  pageCount?: number
  note?: string
  missing?: boolean
}

// 1 つの ref を解決する間の File の要約。同じ PDF のページがたくさん選ばれても、1 回だけ調べる
type SummaryCache = Map<string, Promise<FileSummary | undefined>>

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
  file?: FileSummary & { id: string }
  target?: { id: string; title?: string }
  page?: number
  slide?: number
  assetId?: string
  color?: string
  size?: number
  pointCount?: number
  note?: string
  // 範囲選択の枠が一部にかかった PDF のページの、ページの中の範囲と文字
  region?: DescribedRegion
  children?: DescribedNode[]
}

export interface DescribedRegion {
  rect: Box
  rectUnit: string
  text: string
  figure?: true
  note?: string
}

// 画像を添えたときに JSON に足すもの。画像のピクセルとワールド座標の対応
export type DescribedImage = RefImageInfo & { note: string }

const IMAGE_NOTE =
  'The attached image shows this region as it looked when the reference was made (capturedAt). ' +
  'Pixel (px, py) in the image is world point (x + px / scale, y + py / scale). The JSON is the current content and may differ.'
const DRAW_NOTE = 'Freehand stroke. Its shape is not in the JSON: look at the attached image.'
const DRAW_NOTE_NO_IMAGE = 'Freehand stroke. Its shape is not in the JSON (no image was attached to this reference).'
const RECT_UNIT = 'fraction of the page (0-1, origin at the top left)'
const FIGURE_NOTE = 'This part of the page is mostly a figure (little or no text): look at the attached image.'
const FIGURE_NOTE_NO_IMAGE = 'This part of the page is mostly a figure (little or no text), but no image was attached to this reference.'

// PDF のページの中の範囲を、AI に返す形にする
function describeRegion(region: PdfRegion, hasImage: boolean): DescribedRegion {
  return {
    rect: region.rect,
    rectUnit: RECT_UNIT,
    text: region.text,
    ...(region.figure ? { figure: true as const, note: hasImage ? FIGURE_NOTE : FIGURE_NOTE_NO_IMAGE } : {}),
  }
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
  const saved = await deps.refImages?.read(ref.id)
  const image: { image?: DescribedImage } = saved ? { image: { ...saved.info, note: IMAGE_NOTE } } : {}
  if (ref.kind === 'lines') {
    const file = await fileSummary(ref.fileId, deps)
    const location = {
      fileId: ref.fileId,
      ...(file ? { title: file.title, path: file.path, fileKind: file.kind, ...(file.absPath ? { absPath: file.absPath } : {}) } : {}),
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
    const file = record ? await fileSummary(ref.fileId, deps) : undefined
    if (file?.note === PDF_TEXTLESS) warnings.push(PDF_TEXTLESS)
    return {
      ...head,
      warnings,
      ...image,
      location: {
        fileId: ref.fileId,
        ...(record ? { title: record.title, path: record.path } : {}),
        ...(file?.textPath ? { textPath: file.textPath } : {}),
        page: ref.pageIndex + 1,
        pageIndex: ref.pageIndex,
        rect: ref.rect,
        rectUnit: RECT_UNIT,
      },
      content: {
        text: ref.text,
        ...(ref.figure ? { figure: true, note: saved ? FIGURE_NOTE : FIGURE_NOTE_NO_IMAGE } : {}),
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
  const cache: SummaryCache = new Map()
  const nodes: DescribedNode[] = []
  for (const { id, bounds, pdf } of ref.nodes) {
    if (budget.left <= 0) {
      budget.truncated = true
      break
    }
    budget.left--
    const record = deps.records.get(id)
    const region = pdf ? { region: describeRegion(pdf, Boolean(saved)) } : {}
    if (!record) {
      nodes.push({ id, type: 'unknown', bounds, deleted: true, ...region })
      continue
    }
    nodes.push({ ...(await describeNode(record, deps, budget, Boolean(saved), cache)), bounds, ...region })
  }
  if (ref.nodes.some(({ id }) => !deps.records.get(id))) warnings.push('Some nodes were deleted after the reference was made.')
  return {
    ...head,
    warnings,
    ...image,
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
async function describeNode(
  record: StoredRecord,
  deps: RefDeps,
  budget: { left: number; truncated: boolean },
  hasImage: boolean,
  cache: SummaryCache,
): Promise<DescribedNode> {
  const props = (record.props ?? {}) as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : 'unknown'
  const out: DescribedNode = { id: record.id, type }
  if (typeof record.parentId === 'string' && !record.parentId.startsWith('canvas:')) out.parentId = record.parentId
  const str = (key: string): string | undefined => {
    const value = props[key]
    return typeof value === 'string' && value !== '' ? truncate(value, MAX_NODE_TEXT) : undefined
  }
  const file = async (key = 'fileId'): Promise<DescribedNode['file']> => {
    const id = props[key]
    if (typeof id !== 'string' || !id) return undefined
    let pending = cache.get(id)
    if (!pending) cache.set(id, (pending = fileSummary(id, deps)))
    const info = await pending
    return info ? { id, ...info } : { id }
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
      out.file = await file()
      if (!out.file) out.text = str('inlineText')
      break
    case 'code-card':
    case 'slide-deck-card':
      out.file = await file()
      break
    case 'quote-card':
      out.quote = str('quote')
      out.memo = str('memo')
      out.file = await file()
      break
    case 'pdf-page':
      out.file = await file()
      if (typeof props.pageIndex === 'number') out.page = props.pageIndex + 1
      break
    case 'slide-page':
      out.file = await file()
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
    // 手書き線（MAI-64）。点の列は渡さない（AI には、画像を見るほうが形を読み取りやすい。文字数もすぐに埋まる）
    case 'draw':
      if (typeof props.color === 'string') out.color = props.color
      if (typeof props.size === 'number') out.size = props.size
      if (Array.isArray(props.points)) out.pointCount = Math.floor(props.points.length / 2)
      out.note = hasImage ? DRAW_NOTE : DRAW_NOTE_NO_IMAGE
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
      children.push(await describeNode(child, deps, budget, hasImage, cache))
    }
    if (children.length) out.children = children
  }
  for (const key of Object.keys(out) as (keyof DescribedNode)[]) if (out[key] === undefined) delete out[key]
  return out
}

async function fileSummary(id: string, deps: RefDeps): Promise<FileSummary | undefined> {
  let info
  try {
    info = deps.files.getInfo(id)
  } catch {
    // FileStore が扱わない File（PDF）はレコードから
    const record = deps.records.get(id)
    if (!record || record.typeName !== 'file') return undefined
    const out: FileSummary = { kind: String(record.kind), title: String(record.title), path: String(record.path) }
    if (typeof record.pageCount === 'number') out.pageCount = record.pageCount
    const assetId = record.assetId
    const text = typeof assetId === 'string' && assetId.startsWith('asset:')
      ? await ensurePdfTextFile(deps.dataDir, assetId.slice('asset:'.length)).catch(() => null)
      : null
    if (text) out.textPath = text.path
    if (text?.textless) out.note = PDF_TEXTLESS
    if (record.missing === true) out.missing = true
    return out
  }
  const out: FileSummary = { kind: info.kind, title: info.title, path: info.path }
  if (info.missing) out.missing = true
  else {
    try {
      out.absPath = deps.files.resolveWorkspacePath(info.path)
    } catch {
      // ワークスペースの外を指す（ありえないはずだが）ときは、パスを付けない
    }
  }
  return out
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

async function readBody(req: IncomingMessage, max = MAX_BODY): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > max) throw new HttpError(413, 'too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
