import { applyMat, boxesIntersect, IDENTITY, multiply, transformOf, type Box, type Mat, type NodeRecord, type Vec } from '@canvcode/core'
import { noteHeight, noteType, slideSize, type NoteProps, type SlideRatio } from '@canvcode/nodes'
import { slideOrder } from '@canvcode/canvas/slideOrder'
import { slideLayoutOverflow, type SlideOverflow } from '@canvcode/canvas/slideOverflow'
import { getMaxRowCount, getStandardMaxRowCount, TABLE_IMAGE_SPEC, TABLE_SPEC, TABLE_IMAGE_WIDTH_RANGE, TABLE_IMAGES_SPEC } from '@canvcode/slides'
import type { RecordStore, StoredRecord } from '../records.ts'
import { describeChart, plainTextOfProps } from '../refs.ts'

// AI に Canvas の上のものを読ませる（MCP の list_canvases・read_canvas・read_nodes）。
// - 軽さを優先する：1 行 1 ノードの短い文字の一覧（outline）を返し、詳しい props は read_nodes で必要なノードだけ読む
// - Canvas 1 つを読むときは、parent_id の索引で Canvas の下だけをたどる（ワークスペース全体は読まない）
// - 座標はワールド座標（親の group / frame / slide の位置と回転を合成する）。整数に丸める
// - 並びは重なり順（親ごとの fractional index の順。奥から手前）。group / frame / slide の子は親のすぐ後に続く
// - サーバーはノードの型の描画や文字の配置を使わないので、props を構造的に読む（refs.ts と同じ。スライドの大きさだけは slideSize を使う）。
//   文字の配置を測れないので、テキストの幅（autoWidth）と高さ、引用ノートの高さは見積もり（outline では ~ を付ける）
// - スライドの番号とあふれは、画面と同じ関数（slideOrder・slideLayoutOverflow）で計算する。あふれの文字の幅は Node では概算

export const DEFAULT_LIMIT = 200
export const MAX_LIMIT = 1000
const MAX_LINE_TEXT = 80
const MAX_DETAIL_TEXT = 4000
const MAX_DELETED = 200
const MAX_CHILD_IDS = 200

// ---- Canvas の木（list_canvases） ----

// Canvas の木を文字にする。木は parentCanvasId でたどる（持ち主の Portal が置かれている Canvas が親）。
// 未配置（親がなく、ルートでない）は最後にまとめ、ゴミ箱の中のものは数だけ。PDF のページを並べた Canvas には pdf=<File の id> を付ける。
// Markdown などの File は list_documents で見るので、ここには出さない。ユーザーが見ている Canvas（viewingId）には viewing を付ける
export function listCanvases(records: RecordStore, query?: string, viewingId?: string): string {
  const canvases = records.ofTypeName('canvas')
  const pdfOf = new Map<string, string>()
  for (const file of records.ofTypeName('file')) {
    if (file.kind === 'pdf' && typeof file.pagesCanvasId === 'string') pdfOf.set(file.pagesCanvasId, file.id)
  }
  const nodeCount = canvasNodeCounts(records)
  const rootId = records.rootCanvasId
  const live = canvases.filter((c) => !c.deletedAt)
  const byId = new Map(live.map((c) => [c.id, c]))
  const children = new Map<string, StoredRecord[]>()
  for (const canvas of live) {
    const parent = typeof canvas.parentCanvasId === 'string' && byId.has(canvas.parentCanvasId) ? canvas.parentCanvasId : null
    const key = parent ?? (canvas.id === rootId ? '' : 'unplaced')
    if (canvas.id === rootId) continue
    const list = children.get(key) ?? []
    list.push(canvas)
    children.set(key, list)
  }
  for (const list of children.values()) list.sort((a, b) => String(a.title).localeCompare(String(b.title), 'ja'))
  const line = (canvas: StoredRecord): string => {
    const pdf = pdfOf.get(canvas.id)
    return `${canvas.id} ${JSON.stringify(String(canvas.title ?? ''))} nodes=${nodeCount.get(canvas.id) ?? 0}${pdf ? ` pdf=${pdf}` : ''}${canvas.id === viewingId ? ' viewing' : ''}`
  }
  const lines: string[] = []
  const trashed = canvases.length - live.length
  const needle = query?.trim().toLowerCase()
  if (needle) {
    // 絞り込むときは、当たった Canvas をルートからの道筋と一緒に平たく並べる
    const pathOf = (canvas: StoredRecord): string => {
      const names: string[] = []
      const seen = new Set<string>()
      for (let c: StoredRecord | undefined = canvas; c && !seen.has(c.id); c = byId.get(String(c.parentCanvasId))) {
        seen.add(c.id)
        names.unshift(String(c.title ?? ''))
      }
      return names.join('/')
    }
    for (const canvas of live) {
      if (!String(canvas.title ?? '').toLowerCase().includes(needle)) continue
      lines.push(`${line(canvas)} path=${JSON.stringify(pathOf(canvas))}`)
    }
    return [`rev=${records.rev} matched=${lines.length}`, ...lines].join('\n')
  }
  const seen = new Set<string>()
  const walk = (canvas: StoredRecord, depth: number): void => {
    if (seen.has(canvas.id)) return
    seen.add(canvas.id)
    lines.push(`${'  '.repeat(depth)}${line(canvas)}`)
    for (const child of children.get(canvas.id) ?? []) walk(child, depth + 1)
  }
  const root = byId.get(rootId)
  if (root) walk(root, 0)
  const unplaced = children.get('unplaced') ?? []
  if (unplaced.length) {
    lines.push('unplaced:')
    for (const canvas of unplaced) walk(canvas, 1)
  }
  if (trashed) lines.push(`trash: ${trashed} canvases (not listed)`)
  return [`rev=${records.rev} canvases=${live.length}`, ...lines].join('\n')
}

// Canvas ごとのノードの数（group / frame の中も数える）。中身は読まず、親ごとの数を足し上げる
function canvasNodeCounts(records: RecordStore): Map<string, number> {
  const { counts, containers } = records.nodeCounts()
  const canvasOf = (id: string): string | undefined => {
    let current = id
    for (let guard = 0; guard < 10_000; guard++) {
      const parent = containers.get(current)
      if (parent === undefined) return current.startsWith('canvas:') ? current : undefined
      current = parent
    }
    return undefined
  }
  const out = new Map<string, number>()
  for (const [parent, n] of counts) {
    const canvas = canvasOf(parent)
    if (canvas) out.set(canvas, (out.get(canvas) ?? 0) + n)
  }
  return out
}

// ---- Canvas の下のノード ----

interface Item {
  record: StoredRecord
  props: Record<string, unknown>
  type: string
  depth: number
  parent?: Item
  children: Item[]
  // ローカル座標 → ワールド座標
  world: Mat
  // ローカル座標の箱。estimated はサーバーで測れず見積もったもの
  box: Box
  estimated: boolean
  // ワールド座標の外接の箱
  aabb: Box
}

// 重なり順に、子を親のすぐ後に並べたもの
type Tree = Item[]

// Canvas の下のノードを、parent_id の索引でたどって読む
function loadTree(records: RecordStore, canvasId: string): Tree {
  const flat: Item[] = []
  loadChildren(records, canvasId, undefined, IDENTITY, 0, new Map(), flat)
  return flat
}

function loadChildren(
  records: RecordStore,
  parentId: string,
  parent: Item | undefined,
  parentWorld: Mat,
  depth: number,
  byId: Map<string, Item>,
  flat: Item[],
): Item[] {
  const nodes = records.childrenOf(parentId).filter((r) => r.typeName === 'node' && !byId.has(r.id))
  nodes.sort(compareIndex)
  return nodes.map((record) => loadItem(records, record, parent, parentWorld, depth, byId, flat))
}

// ノードと、group / frame ならその下を読む
function loadItem(
  records: RecordStore,
  record: StoredRecord,
  parent: Item | undefined,
  parentWorld: Mat,
  depth: number,
  byId: Map<string, Item>,
  flat: Item[],
): Item {
  const props = (record.props ?? {}) as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : 'unknown'
  const item: Item = {
    record,
    props,
    type,
    depth,
    parent,
    children: [],
    world: multiply(parentWorld, localMatrix(record)),
    box: { x: 0, y: 0, w: 0, h: 0 },
    estimated: false,
    aabb: { x: 0, y: 0, w: 0, h: 0 },
  }
  byId.set(record.id, item)
  flat.push(item)
  if (isContainer(type)) item.children = loadChildren(records, record.id, item, item.world, depth + 1, byId, flat)
  const { box, estimated } = localBox(item)
  item.box = box
  item.estimated = estimated
  item.aabb = boundsOf(item.world, box)
  return item
}

// 子を持つ型（group・frame・スライド・スライドの中身を並べる slide-layout）
function isContainer(type: string): boolean {
  return type === 'group' || type === 'frame' || type === 'slide' || type === 'slide-layout'
}

function localMatrix(record: StoredRecord): Mat {
  return transformOf(num(record.x), num(record.y), num(record.rotation))
}

// ノードのローカル座標の箱。group は子の箱を合わせたもの
function localBox(item: Item): { box: Box; estimated: boolean } {
  const p = item.props
  switch (item.type) {
    case 'group': {
      const boxes = item.children.map((child) => boundsOf(localMatrix(child.record), child.box))
      return { box: union(boxes) ?? { x: 0, y: 0, w: 0, h: 0 }, estimated: item.children.some((c) => c.estimated) }
    }
    case 'arrow': {
      const points = [vecOf(p.start), vecOf(p.end)]
      return { box: union(points.map((v) => ({ ...v, w: 0, h: 0 })))!, estimated: false }
    }
    case 'draw': {
      const points = Array.isArray(p.points) ? (p.points as unknown[]) : []
      const boxes: Box[] = []
      for (let i = 0; i + 1 < points.length; i += 2) boxes.push({ x: num(points[i]), y: num(points[i + 1]), w: 0, h: 0 })
      return { box: union(boxes) ?? { x: 0, y: 0, w: 0, h: 0 }, estimated: false }
    }
    case 'text': {
      const fontSize = num(p.fontSize, 24)
      const lines = plainTextOfProps(p).split('\n')
      const w = p.autoWidth === false ? num(p.w) : Math.max(fontSize, ...lines.map((line) => textWidth(line, fontSize)))
      return { box: { x: 0, y: 0, w, h: lines.length * fontSize * 1.35 }, estimated: true }
    }
    // 付箋の高さは文字に合わせて伸びる（sizing が auto なら縮みもする）。文字から決めた高さは、文字の幅が概算なので estimated
    case 'note': {
      // 欠けた props は既定で補う（sizing を持たない古い付箋は fixed のまま）
      const h = noteHeight({ ...noteType.defaultProps(), sizing: undefined, ...p } as NoteProps)
      if (!Number.isFinite(h) || h === num(p.h)) return { box: { x: 0, y: 0, w: num(p.w), h: num(p.h) }, estimated: false }
      return { box: { x: 0, y: 0, w: num(p.w), h }, estimated: true }
    }
    // スライドは大きさを props に持たず、縦横比から決める
    case 'slide':
      return { box: { x: 0, y: 0, ...slideSize(p.ratio as SlideRatio) }, estimated: false }
    case 'quote-card': {
      const w = num(p.w, 280)
      const chars = typeof p.quote === 'string' ? p.quote.length : 0
      return { box: { x: 0, y: 0, w, h: 80 + Math.min(8, Math.ceil((chars * 14) / Math.max(1, w - 40))) * 20 }, estimated: true }
    }
    case 'link-card':
      return { box: { x: 0, y: 0, w: num(p.w, 400), h: typeof p.description === 'string' && p.description ? 110 : 70 }, estimated: true }
    default:
      return { box: { x: 0, y: 0, w: num(p.w), h: num(p.h) }, estimated: false }
  }
}

// ---- read_canvas ----

export interface ReadCanvasOptions {
  canvasId?: string
  rect?: Box
  query?: string
  types?: string[]
  depth?: number
  since?: number
  limit?: number
  cursor?: string
  // ユーザーがこの Canvas で見ている範囲（見出しの行に viewing= で出す）
  viewing?: Box
}

export class OutlineError extends Error {}

// Canvas のノードを 1 行ずつの一覧にする。
// - depth（既定 0）までの group / frame / slide の子を字下げして並べ、それより深いものは [N children] にまとめる
// - query・types・since は depth によらず group / frame / slide の中も探す。親の行がないノードには in=<親の id> を付ける
// - rect はワールド座標の外接の箱が重なるもの
// - since は、その rev より後に変わったノード（矢印のつながりが変わったものも）と、その後に消えたノードの id（deleted=。
//   消えたものはどの Canvas にあったか分からないので、ワークスペース全体のもの）
// - cursor は、絞り込んだ後の何行目からか（同じ rev の間は同じ並び）
export function readCanvas(records: RecordStore, options: ReadCanvasOptions): string {
  const canvasId = options.canvasId ?? records.rootCanvasId
  const canvas = records.get(canvasId)
  if (!canvas || canvas.typeName !== 'canvas') throw new OutlineError(`Unknown canvas id ${canvasId}. Use list_canvases to find one.`)
  const offset = options.cursor ? Number(options.cursor) : 0
  if (!Number.isInteger(offset) || offset < 0) throw new OutlineError('Invalid cursor. Pass the next= value from the previous result.')
  const limit = Math.min(MAX_LIMIT, Math.max(1, options.limit ?? DEFAULT_LIMIT))
  const depth = Math.max(0, options.depth ?? 0)
  const tree = loadTree(records, canvas.id)
  const bindings = bindingsByArrow(records, tree)
  const slides = slideInfos(tree)
  const needle = options.query?.trim().toLowerCase() || undefined
  const types = options.types?.length ? new Set(options.types) : undefined
  const changes = options.since === undefined ? undefined : records.idsChangedSince(options.since)
  const searching = Boolean(needle || types || changes)
  const filtered = searching || Boolean(options.rect)

  const files = new Map<string, StoredRecord | undefined>()
  const recordOf = (id: string): StoredRecord | undefined => {
    if (!files.has(id)) files.set(id, records.get(id))
    return files.get(id)
  }
  const shown: Item[] = []
  for (const item of tree) {
    if (!searching && item.depth > depth) continue
    if (options.rect && !boxesIntersect(item.aabb, options.rect)) continue
    if (types && !types.has(item.type) && !types.has(typeLabel(item))) continue
    if (needle && !searchText(item, recordOf).toLowerCase().includes(needle)) continue
    if (changes && !changes.changed.has(item.record.id) && !(bindings.get(item.record.id) ?? []).some((b) => changes.changed.has(b.id))) continue
    shown.push(item)
  }
  const page = shown.slice(offset, offset + limit)
  const next = offset + limit < shown.length ? offset + limit : undefined
  const head = [
    `${canvas.id} ${JSON.stringify(String(canvas.title ?? ''))}`,
    canvas.deletedAt ? 'trashed' : '',
    options.viewing ? `viewing=${point(options.viewing)},${round(options.viewing.w)}x${round(options.viewing.h)}` : '',
    `rev=${records.rev}`,
    `nodes=${tree.length}`,
    filtered ? `matched=${shown.length}` : '',
    `shown=${page.length}`,
    next === undefined ? '' : `next=${next}`,
  ].filter(Boolean)
  const lines = [head.join(' ')]
  if (changes) {
    const deleted = changes.deleted.filter((id) => id.startsWith('node:'))
    if (deleted.length) lines.push(`deleted=${deleted.slice(0, MAX_DELETED).join(',')}${deleted.length > MAX_DELETED ? ` (+${deleted.length - MAX_DELETED})` : ''}`)
  }
  const printed = new Set<string>()
  for (const item of page) {
    const expanded = !searching && item.depth < depth
    lines.push(outlineLine(item, { bindings, recordOf, slides, expanded, parentShown: !item.parent || printed.has(item.parent.record.id) }))
    printed.add(item.record.id)
  }
  return lines.join('\n')
}

function bindingsByArrow(records: RecordStore, tree: Tree): Map<string, StoredRecord[]> {
  const out = new Map<string, StoredRecord[]>()
  const arrows = tree.filter((item) => item.type === 'arrow').map((item) => item.record.id)
  for (const binding of records.bindingsFrom(arrows)) {
    const from = String(binding.fromId)
    out.set(from, [...(out.get(from) ?? []), binding])
  }
  return out
}

interface LineContext {
  bindings: Map<string, StoredRecord[]>
  recordOf: (id: string) => StoredRecord | undefined
  slides: Map<string, SlideInfo>
  expanded: boolean
  parentShown: boolean
}

// 1 行：<id> <型> <x>,<y> <w>x<h> [rot=度] [型ごとのもの] "文字" [locked] [in=親] [N children]
function outlineLine(item: Item, ctx: LineContext): string {
  const { record, props: p, type } = item
  const parts: string[] = [`${'  '.repeat(item.parent && ctx.parentShown ? item.depth : 0)}${record.id}`, typeLabel(item)]
  if (type === 'arrow') {
    const ends = endpoints(item, ctx.bindings.get(record.id) ?? [])
    parts.push(`${ends.start.node ?? point(ends.start.world)}→${ends.end.node ?? point(ends.end.world)}`)
  } else {
    parts.push(point(applyMat(item.world, { x: item.box.x, y: item.box.y })), `${item.estimated ? '~' : ''}${round(item.box.w)}x${round(item.box.h)}`)
    const rotation = worldRotation(item)
    if (rotation) parts.push(`rot=${rotation}`)
  }
  switch (type) {
    case 'geo': {
      const fill = fillLabel(p.fill)
      if (fill) parts.push(`fill=${fill}`)
      break
    }
    case 'portal':
      if (typeof p.targetId === 'string') parts.push(p.targetId)
      break
    case 'markdown-card':
    case 'code-card':
    case 'table-card':
    case 'quote-card':
    case 'pdf-page':
      if (typeof p.fileId === 'string' && p.fileId) parts.push(p.fileId)
      if (type === 'pdf-page' && typeof p.pageIndex === 'number') parts.push(`p=${p.pageIndex + 1}`)
      break
    case 'chart':
      if (typeof p.kind === 'string') parts.push(p.kind)
      break
    case 'link-card':
      if (typeof p.url === 'string') parts.push(p.url)
      break
    // 番号（非表示なら hidden）と、文字があふれている・並べられなかった行があるときの overflow
    case 'slide': {
      const info = ctx.slides.get(record.id)
      parts.push(info?.number ? `n=${info.number}` : p.hidden === true ? 'hidden' : '')
      if (info?.overflow) parts.push('overflow')
      break
    }
  }
  const text = lineText(item, ctx.recordOf)
  if (text) parts.push(JSON.stringify(text.length > MAX_LINE_TEXT ? `${text.slice(0, MAX_LINE_TEXT)}…` : text))
  if (record.locked === true) parts.push('locked')
  if (item.parent && !ctx.parentShown) parts.push(`in=${item.parent.record.id}`)
  if (isContainer(type) && !ctx.expanded && item.children.length) parts.push(`[${item.children.length} children]`)
  return parts.filter(Boolean).join(' ')
}

function typeLabel(item: Item): string {
  return item.type === 'geo' && typeof item.props.shape === 'string' ? `geo/${item.props.shape}` : item.type
}

// 一覧に出す文字（ノードの文字・名前、カードなら File の名前、Portal なら行き先の Canvas の名前）
function lineText(item: Item, recordOf: (id: string) => StoredRecord | undefined): string {
  const p = item.props
  const str = (value: unknown): string => (typeof value === 'string' ? value : '')
  switch (item.type) {
    case 'text':
    case 'note':
      return plainTextOfProps(p)
    case 'geo':
    case 'arrow':
      return str(p.label)
    case 'frame':
    case 'slide':
      return str(p.name)
    case 'slide-layout':
      return str(p.layout)
    case 'quote-card':
      return str(p.quote) || str(p.memo)
    case 'link-card':
      return str(p.title)
    case 'chart':
      return describeChart(p).rows.map((row) => row.label).join(', ')
    case 'portal':
      return typeof p.targetId === 'string' ? str(recordOf(p.targetId)?.title) : ''
    case 'markdown-card':
      if (typeof p.fileId !== 'string' || !p.fileId) return str(p.inlineText)
      return str(recordOf(p.fileId)?.title)
    case 'code-card':
    case 'table-card':
    case 'pdf-page':
      return typeof p.fileId === 'string' ? str(recordOf(p.fileId)?.title) : ''
    default:
      return ''
  }
}

function searchText(item: Item, recordOf: (id: string) => StoredRecord | undefined): string {
  return item.type === 'quote-card' ? `${lineText(item, recordOf)}\n${String(item.props.memo ?? '')}` : lineText(item, recordOf)
}

// ---- read_nodes ----

// ノードを詳しく（ただし AI が読みやすく）する。段落と run はプレーンテキストに、単色の塗りは色だけにする。
// 位置（x・y）はワールド座標での箱の左上、大きさはローカル座標（回転する前）の幅と高さ。
// Canvas 全体は読まず、親をたどってワールド座標の行列を作り、group / frame ならその下だけを読む
export function readNodes(records: RecordStore, ids: string[]): { nodes: Record<string, unknown>[]; missing?: string[] } {
  const nodes: Record<string, unknown>[] = []
  const missing: string[] = []
  // スライドの番号とあふれは Canvas ごとに 1 回だけ計算する（スライドを読むときだけ、その Canvas を読む）
  const slidesOf = new Map<string, Map<string, SlideInfo>>()
  for (const id of ids) {
    const record = records.get(id)
    if (!record || record.typeName !== 'node') {
      missing.push(id)
      continue
    }
    let world = IDENTITY
    let canvasId: string | undefined
    let parentId = record.parentId
    for (let guard = 0; guard < 10_000 && typeof parentId === 'string'; guard++) {
      if (parentId.startsWith('canvas:')) {
        canvasId = parentId
        break
      }
      const parent = records.get(parentId)
      if (!parent) break
      world = multiply(localMatrix(parent), world)
      parentId = parent.parentId
    }
    const item = loadItem(records, record, undefined, world, 0, new Map(), [])
    const bindings = item.type === 'arrow' ? records.bindingsFrom([id]) : []
    let slide: SlideInfo | undefined
    if (item.type === 'slide' && canvasId) {
      if (!slidesOf.has(canvasId)) slidesOf.set(canvasId, slideInfos(loadTree(records, canvasId)))
      slide = slidesOf.get(canvasId)!.get(id)
    }
    nodes.push(detail(item, canvasId, bindings, records, slide))
  }
  return missing.length ? { nodes, missing } : { nodes }
}

function detail(item: Item, canvasId: string | undefined, bindings: StoredRecord[], records: RecordStore, slide?: SlideInfo): Record<string, unknown> {
  const { record, props: p, type } = item
  const origin = applyMat(item.world, { x: item.box.x, y: item.box.y })
  const out: Record<string, unknown> = { id: record.id, type, canvas: canvasId }
  if (typeof record.parentId === 'string' && !record.parentId.startsWith('canvas:')) out.parent = record.parentId
  if (type !== 'arrow') {
    Object.assign(out, { x: round2(origin.x), y: round2(origin.y), w: round2(item.box.w), h: round2(item.box.h) })
    if (item.estimated) out.sizeEstimated = true
  }
  const rotation = worldRotation(item)
  if (rotation) out.rotation = rotation
  out.index = record.index
  if (record.locked === true) out.locked = true
  if (typeof record.opacity === 'number' && record.opacity !== 1) out.opacity = record.opacity
  const copy = (...keys: string[]): void => {
    for (const key of keys) if (p[key] !== undefined && p[key] !== '') out[key] = p[key]
  }
  const file = (): void => {
    if (typeof p.fileId !== 'string' || !p.fileId) return
    const f = records.get(p.fileId)
    out.file = f ? { id: f.id, kind: f.kind, title: f.title, path: f.path, ...(f.deletedAt ? { trashed: true } : {}) } : { id: p.fileId, missing: true }
  }
  switch (type) {
    case 'text':
    case 'note':
      out.text = clip(plainTextOfProps(p))
      copy('fontSize', 'fontFamily', 'color', 'align')
      if (type === 'text') copy('autoWidth')
      if (type === 'note') copy('sizing')
      break
    case 'geo': {
      copy('shape', 'label')
      out.fill = fillLabel(p.fill) ?? 'none'
      const stroke = p.stroke as { color?: unknown } | string | null | undefined
      out.stroke = typeof stroke === 'string' ? stroke : typeof stroke?.color === 'string' ? stroke.color : 'none'
      copy('strokeWidth', 'strokeDash', 'cornerRadius', 'labelFontSize', 'labelColor')
      const fill = p.fill as { type?: unknown; assetId?: unknown; scaleMode?: unknown; crop?: unknown } | null | undefined
      if (fill?.type === 'image' && typeof fill.assetId === 'string') {
        out.assetId = fill.assetId
        out.scaleMode = fill.scaleMode
        if (fill.scaleMode === 'crop') out.crop = fill.crop
      }
      break
    }
    case 'arrow': {
      const ends = endpoints(item, bindings)
      for (const key of ['start', 'end'] as const) {
        const end = ends[key]
        out[key] = { x: round2(end.world.x), y: round2(end.world.y), ...(end.node ? { node: end.node } : {}) }
      }
      copy('label', 'color', 'size', 'bend', 'arrowheadStart', 'arrowheadEnd', 'strokeDash')
      break
    }
    case 'frame':
    case 'group':
    case 'slide':
    case 'slide-layout':
      copy('name')
      if (type === 'slide') {
        copy('ratio')
        if (p.hidden === true) out.hidden = true
        // 番号（非表示なら無い）と、あふれ（文字があふれている子の id・並べられなかった行の数）
        if (slide?.number) out.number = slide.number
        if (slide?.overflow) out.overflow = slide.overflow
      }
      // 並べる子の役割（子の id）
      if (type === 'slide-layout') copy('layout', 'slots', 'adjust')
      out.children = item.children.slice(0, MAX_CHILD_IDS).map((child) => child.record.id)
      if (item.children.length > MAX_CHILD_IDS) out.childCount = item.children.length
      break
    case 'portal': {
      if (typeof p.targetId === 'string') {
        const target = records.get(p.targetId)
        out.target = { id: p.targetId, ...(typeof target?.title === 'string' ? { title: target.title } : {}) }
      }
      copy('role')
      break
    }
    case 'markdown-card':
    case 'code-card':
      file()
      copy('role', 'sizing')
      if (type === 'markdown-card' && !p.fileId && typeof p.inlineText === 'string') out.text = clip(p.inlineText)
      break
    case 'table-card':
      file()
      copy('role', 'sizing', 'header', 'wrap', 'sort', 'filters')
      break
    case 'quote-card':
      file()
      copy('quote', 'memo')
      break
    case 'link-card':
      copy('url', 'title', 'description', 'siteName')
      break
    case 'pdf-page':
      file()
      if (typeof p.pageIndex === 'number') out.page = p.pageIndex + 1
      break
    case 'image':
      copy('assetId', 'crop')
      break
    case 'draw':
      copy('color', 'size')
      if (Array.isArray(p.points)) out.pointCount = Math.floor(p.points.length / 2)
      break
    case 'chart':
      out.chart = describeChart(p)
      break
    default:
      // 知らない型は、短い値だけをそのまま渡す
      for (const [key, value] of Object.entries(p)) {
        if (typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 200)) out[key] = value
      }
  }
  for (const key of Object.keys(out)) if (out[key] === undefined || out[key] === null) delete out[key]
  return out
}

// ---- スライド ----

interface SlideInfo {
  // 番号（1 から。非表示なら null）
  number: number | null
  // 文字があふれている子・並べられなかった行（無ければ null）
  overflow: SlideOverflow | null
}

// Canvas のスライドの番号とあふれ（Editor.slideNumbers・slideOverflows と同じ計算）。
// 番号は group・frame の中のスライドも、ワールドでの外接の箱で数える。あふれはスライドの直下の slide-layout の slots の子を測る
function slideInfos(tree: Tree): Map<string, SlideInfo> {
  const slides = tree.filter((item) => item.type === 'slide')
  const { numbers } = slideOrder(slides.map((item) => ({ id: item.record.id, box: item.aabb, hidden: item.props.hidden === true })))
  const out = new Map<string, SlideInfo>()
  for (const item of slides) {
    const found: SlideOverflow = { nodes: [], extraRows: 0 }
    for (const layout of item.children) {
      if (layout.type !== 'slide-layout') continue
      const children = new Map(layout.children.map((child) => [child.record.id, child.record as unknown as NodeRecord]))
      const { nodes, extraRows } = slideLayoutOverflow(layout.record as unknown as NodeRecord, children)
      found.nodes.push(...nodes)
      found.extraRows += extraRows
    }
    const overflow = found.nodes.length > 0 || found.extraRows > 0 ? found : null
    out.set(item.record.id, { number: numbers.get(item.record.id) ?? null, overflow })
  }
  return out
}

// ---- 形の計算 ----

interface Endpoint {
  world: Vec
  node?: string
}

// 矢印の両端。つながっている（Binding がある）端は、つながっている先のノードの id も返す
function endpoints(item: Item, bindings: StoredRecord[]): { start: Endpoint; end: Endpoint } {
  const terminal = (name: 'start' | 'end'): Endpoint => {
    const world = applyMat(item.world, vecOf(item.props[name]))
    const binding = bindings.find((b) => (b.props as { terminal?: unknown } | undefined)?.terminal === name)
    return binding && typeof binding.toId === 'string' ? { world, node: binding.toId } : { world }
  }
  return { start: terminal('start'), end: terminal('end') }
}

// ワールド座標での回転（度。0〜359 の整数）
function worldRotation(item: Item): number {
  const degrees = Math.round((Math.atan2(item.world.b, item.world.a) * 180) / Math.PI)
  return ((degrees % 360) + 360) % 360
}

function boundsOf(m: Mat, box: Box): Box {
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ].map((p) => applyMat(m, p))
  return union(corners.map((p) => ({ ...p, w: 0, h: 0 })))!
}

function union(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null
  const minX = Math.min(...boxes.map((b) => b.x))
  const minY = Math.min(...boxes.map((b) => b.y))
  const maxX = Math.max(...boxes.map((b) => b.x + b.w))
  const maxY = Math.max(...boxes.map((b) => b.y + b.h))
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

// 1 行の文字の幅の見積もり（全角は 1 文字 1em、半角は 0.55em）
function textWidth(line: string, fontSize: number): number {
  let em = 0
  for (const ch of line) em += ch.codePointAt(0)! >= 0x2e80 ? 1 : 0.55
  return em * fontSize
}

// 単色なら色（不透明度が 1 でなければ @ 不透明度）、ほかの塗りは種類、塗りなしは none
function fillLabel(fill: unknown): string | undefined {
  if (fill === undefined) return undefined
  if (fill === null) return 'none'
  if (typeof fill === 'string') return fill
  const paint = fill as { type?: unknown; color?: unknown; opacity?: unknown }
  if (paint.type === 'solid' && typeof paint.color === 'string') {
    return typeof paint.opacity === 'number' && paint.opacity !== 1 ? `${paint.color}@${round2(paint.opacity)}` : paint.color
  }
  return typeof paint.type === 'string' ? paint.type : undefined
}

function compareIndex(a: StoredRecord, b: StoredRecord): number {
  const ai = String(a.index ?? '')
  const bi = String(b.index ?? '')
  return ai < bi ? -1 : ai > bi ? 1 : a.id < b.id ? -1 : 1
}

function vecOf(value: unknown): Vec {
  const v = value as { x?: unknown; y?: unknown } | null | undefined
  return { x: num(v?.x), y: num(v?.y) }
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function round(value: number): number {
  return Math.round(value) || 0
}

function round2(value: number): number {
  return Math.round(value * 100) / 100 || 0
}

function point(p: Vec): string {
  return `${round(p.x)},${round(p.y)}`
}

function clip(text: string): string {
  return text.length > MAX_DETAIL_TEXT ? `${text.slice(0, MAX_DETAIL_TEXT)}…（${text.length - MAX_DETAIL_TEXT} 文字省略）` : text
}

// ---- get_canvas_format ----

// Canvas の読み方・書き換え方の説明（get_canvas_format）。ツールの説明は短くし、詳しいことはここに書く。
// editable でなければ（書き換えるツールを出していなければ）、書き換え方は書かない
export function canvasFormatGuide(options: { editable?: boolean } = {}): string {
  return `# CanvCode canvas format

## Structure
- A workspace has a tree of canvases. A canvas's child canvases are opened through portal nodes placed on it. list_canvases shows the tree; "unplaced" canvases have no portal yet.
- A PDF is shown as a canvas of locked pdf-page nodes (pdf=<file id> in list_canvases).
- Markdown / Python / table (CSV) documents are files (file:...), shown on canvases as cards. Read their text with read_document.

## Coordinates
- World coordinates: x grows right, y grows down, 1 unit = 1 CSS px at 100% zoom. Rotation is in degrees, clockwise.
- Nodes inside a group or frame store positions relative to the parent; the tools always report world coordinates.
- x,y is the world position of the top-left corner of the node's own (unrotated) box; WxH is its size. rot= is the node's rotation in world space.
- Sizes marked ~ (text, quote-card, link-card) are estimates: the server cannot measure text.

## read_canvas outline
First line: <canvas id> "<title>" [viewing=<x>,<y>,<W>x<H>] rev=<workspace revision> nodes=<total> [matched=<after filters>] shown=<lines> [next=<cursor>]
Then one line per node, back-to-front (z-order); children of a group/frame follow their parent, indented by depth:
  <id> <type> <x>,<y> <W>x<H> [rot=<deg>] [extra] ["text"] [locked] [in=<parent id>] [[N children]]
Arrows: <id> arrow <start>→<end> ["label"], where each end is a node id (bound) or x,y (free).
Extras: geo fill=#rrggbb (@opacity), linear/radial/image or none; portal: target canvas id; cards and pages: file id, p=<pdf page>; chart: kind; slide: n=<number> (or hidden), overflow (text does not fit or rows were not placed).
Text is truncated to ${MAX_LINE_TEXT} characters. Group/frame contents are collapsed as [N children] unless depth > 0.
Filters: rect (world box intersection), query (case-insensitive text), types (e.g. note, geo, geo/ellipse) and since search inside groups/frames too; nodes whose parent line is not shown get in=<parent id>.
since=<rev> returns only nodes changed after that revision (including arrows whose connections changed) and deleted=<ids> (node ids deleted anywhere in the workspace after it). Pass the rev from a previous result to see what the user changed.
Paging: when next= is present, call again with cursor=<next>.

## Where the user is looking
An open CanvCode tab reports the canvas the user is viewing and the world rect on their screen. list_canvases marks that canvas with "viewing"; read_canvas shows viewing=<rect> when it reads that canvas.
read_canvas and edit_canvas default to that canvas when canvas_id is omitted (read_canvas falls back to the root canvas when no tab is open). read_canvas view=true lists only the nodes on the user's screen.

## Node types
- text: free text (props: paragraphs → plain text, fontSize, color, autoWidth/w)
- note: sticky note (text, w, h, color = background); its height fits the text (sizing auto) unless h is given (then h is the minimum height, sizing fixed)
- geo: shape, one of rect, ellipse, blockArrow, blockArrowBoth, blockArrowBent, chevron (label, fill, stroke, strokeWidth, strokeDash, cornerRadius). fill "image" (slide image frames) adds assetId, scaleMode (fill | fit | crop | tile) and crop
- arrow: arrow or plain line ("矢印・線" in the UI), straight or arc between two points (start, end, bend, label, color, size, arrowheadStart/arrowheadEnd = arrow | bar | none, strokeDash); ends may be bound to nodes. Without arrowheads it is a plain line; bar is a short perpendicular cap, so bar at both ends is a dimension line |―| whose line reaches the end points exactly
- strokeDash (geo, arrow): solid | dashed | dotted; omitted = solid
- draw: freehand stroke (color, size; points are not returned)
- image: bitmap (assetId, w, h, crop = the part of the image shown, {x,y,w,h} as 0–1 fractions of the whole image, or null)
- frame: named container that clips its children (name, w, h)
- group: container without visuals; its box is the union of its children
- portal: window into a child canvas (target canvas id)
- markdown-card / code-card: a document file on the canvas
- table-card: a table document (a .csv / .tsv file) drawn as a grid; its text is the CSV (read_document). header = whether the first row is shown as the header; wrap = long cells wrap; sort {col, dir} and filters [{col, op, value}] (col is 0-based; filters are ANDed) only change what the card shows, not the file
- quote-card: quotation from a PDF or Markdown file with a memo
- link-card: a web link pasted as a card (url, and the page's title, description and thumbnail when they could be fetched)
- pdf-page: one page of a PDF (p= is 1-based)
- chart: pie or donut chart (rows of label and value)
- slide: a 16:9 (1920x1080) or 4:3 (1440x1080) page of the canvas's slide deck (name, ratio, hidden). One canvas = one deck; slides are exported to PDF in reading order: rows from top to bottom (slides overlapping vertically by half or more form a row), left to right in a row. n= is that number; hidden slides get none. Slides cannot be resized or rotated.
- slide-layout: the single child of a slide made by a template; it lays out the slide's contents. layout = title | bullets | table | table-image | table-images; slots = the ids of its children by role: title, subtitle, credits (title layout), panel, figure (table-image: the right frame; table-images: the lower left frame), figure2 (table-images: the lower right frame), rows [{label?, body}] (label: table layouts only). Its children are text (title, subtitle) and geo rects (cells).

## Details
read_nodes returns compact JSON per node: world x, y, w, h, rotation, z-order index, parent, locked, plain text, fill/stroke colours, file, arrow ends, children ids, chart rows,
slide number and overflow ({nodes: ids of cells (and a title over two lines) whose text does not fit, extraRows: rows over the limit}), slide-layout layout, slots and adjust.
${options.editable ? EDIT_GUIDE : '\nEditing canvas nodes is not available; these tools are read-only.\n'}`
}

// edit_canvas の説明（agent/ops.ts の操作の形と合わせる）
const EDIT_GUIDE = `
## Editing (edit_canvas)
edit_canvas(canvas_id?, ops, if_rev?, label?) runs all ops in order as one atomic edit (max 500): if any op fails, nothing changes and the error names ops[i].
Batch a whole change into one call. label is a short description the user sees with an undo button. Pass if_rev=<rev you read> to refuse if those nodes changed since.
Result: {"batch","rev","created":{"<as or #i>":"<new id>"},"counts":{created,updated,deleted},"warnings"?}. undo_canvas_edit(batch_id) undoes it.

Ids: an op may name what it creates with "as":"a"; later ops refer to it as "$a".
Coordinates: world. x,y = top-left of the node's box, as in read_canvas (also inside rotated frames/groups; the server converts).
Position (create/move): x,y, or place:{rightOf|leftOf|below|above:<id>, gap?:40} (aligns top or left edges). Omitted on create: in free space near the centre of the user's view (else right of the existing content); later unpositioned creates in the same call stack below it.
Colours are hex (#rrggbb); fill/stroke also accept "none".

Ops:
- create: type (text | note | geo | frame | slide | card | portal | pdf), as?, parent? (frame/group/slide id), position, w?, h?, rotation? (deg) and style:
  text: text, fontSize, color, align (left|center|right), w (wraps; default 240)
  note: text, color (background), fontSize, align, w, h
  geo: shape (rect | ellipse | blockArrow | blockArrowBoth | blockArrowBent | chevron), text (label), fill, stroke, strokeWidth, dash (solid | dashed | dotted), color (label), fontSize, align, cornerRadius, w, h
  frame: name, w, h
  slide: name, ratio, hidden, template (see Slides below)
  card: file (document id from list_documents; markdown, code or table) or path (its path as list_documents shows it), w, h (fixes the height). If the document already has a card, the new one is a shortcut to it (dashed, "↗"), fixed at 200 high unless h is given.
  portal: name (or text; the title of the new canvas), w, h. Makes a new empty canvas and its portal here. Fill it with another edit_canvas call whose canvas_id is the new canvas.
    With target ("$a" of a portal or pdf made earlier in the call, a portal node id, or a canvas id) and no name/text: makes no canvas; puts a shortcut portal (dashed, "↗") to that canvas here, e.g. to show the same PDF next to several groups of notes instead of drawing long arrows to one place.
  pdf: path (a PDF file in the workspace folder that list_documents returns: relative to it, or absolute inside it) or url (http/https), name (default: the file name), w, h. Imports the PDF as a canvas of its pages (like dropping it in the UI) and puts its portal here.
  portal (without target) and pdf add "canvases":{"<as or #i>":{"canvas":"canvas:…"}} to the result; pdf also gives "file", "pages" and "textPath" (the text of the PDF, a "=== page N ===" line before each page; absent when the PDF has no text).
- update: id, any style fields above, x, y, w, h, rotation, opacity, locked. Locked nodes need "locked":false first.
  arrow (made by connect): text (label), color, strokeWidth (line width), dash (solid | dashed | dotted), heads (end | start | both | none | bars; none = a plain line, bars = a dimension line |―| with short perpendicular bars at both ends, e.g. to show the size of a gap next to a bar chart).
  crop (image, or geo with an image fill): {"x":0.1,"y":0,"w":0.5,"h":1} = the part of the image to show (0–1 fractions of the whole image); null shows the whole image. An image keeps its width and gets the height of the cropped part; a geo keeps its box and its fill switches to scaleMode crop (null: back to fill).
- move: ids, dx,dy or x,y or place (several ids move together; x,y is their bounding box top-left).
- delete: ids, documents? ("trash" (default) | "unplace"): what happens to the canvas/document of a deleted portal or card.
- group: ids (2+, same parent), as?   ungroup: ids
- connect: from, to (node id or {x,y}), as?, label?, color?, bend?, heads? (end | start | both | none | bars; none = a plain line, bars = a dimension line |―|), dash? (solid | dashed | dotted). Arrows bound to nodes follow them when they move.
- align: ids, edge (left | hcenter | right | top | vcenter | bottom)
- distribute: ids, axis (x | y), gap? (without gap: 3+ ids, equal spacing between the outer ones)
- scale: ids, and either factor (e.g. 0.72) with origin? (top-left (default) | top | top-right | left | center | right | bottom-left | bottom | bottom-right of the ids' bounding box, or {x,y}), or fit {x,y,w,h} with align? (same names; default center): scales the whole selection uniformly (keeps aspect ratio); with fit, its bounding box fits inside the rect and is placed at that anchor of it. Contents of groups and frames scale too (positions, sizes, rotation pivots); arrows whose bound ends are all inside the selection scale with it (bend, width), and arrows to outside nodes stay connected and stretch.
  text? (default true): font sizes scale (text, notes, shape labels, including per-range sizes); minFontSize? keeps scaled text at least that size (text already smaller keeps its size; a clamped text box stays centred on its scaled position, so it may stick out slightly). Use "minFontSize":11 when shrinking a diagram into a slide.
  strokes? (default true): line widths, dash lengths and shadows scale; false keeps them.
  Slides and slide-layout cells cannot be scaled (scale the nodes on a slide instead). Locked nodes (or locked nodes inside a group/frame) are refused. Nodes with a minimum size (notes 60, cards 200, images 8) stop there (a warning lists them).
  Example: {"op":"scale","ids":["node:a","node:b"],"fit":{"x":100,"y":200,"w":1720,"h":760},"minFontSize":11}
- reparent: ids, parent (frame/group id, or "canvas")
- add_row: slide (slide or slide-layout id; adds the last row) or after (a cell id; adds below its row), text? (body), label? (table layouts), as? (names the body; created also gets "<as>:label"). New cells copy the format of the neighbouring row.
Text size is estimated on the server (it cannot measure fonts); give text a width.

Slides (presentations):
- create type "slide": ratio? ("16:9" default | "4:3"), name?, hidden?, template? and position (no w/h: the size comes from the ratio). update: name, ratio, hidden, template, adjust.
- template (title | bullets | table | table-image | table-images) fills an empty slide with a slide-layout and placeholder children (3 rows; table-images: 1 row of a full-width table above two image frames side by side). Then read_nodes the slide-layout for its slots and write the text with update {id, text} on each child.
- Rows: at most ${getMaxRowCount('table-image')} (table-image), ${getMaxRowCount('table-images')} (table-images). bullets and table use the normal layout up to ${getStandardMaxRowCount('table')} rows; more rows switch to a tighter layout (taller panel, smaller gaps) whose limit depends on the largest text in the cells (labels and bodies): ${getMaxRowCount('table')} at the default text size, more when every cell uses smaller text. Add with add_row; remove a row by deleting its body cell (its label goes with it and the rows close up).
- The children of a slide-layout are laid out again at the end of every edit (positions, sizes and body colours follow the layout and row order): x, y, w, h you write for them are replaced. Long text wraps and may overflow its cell (read_canvas shows overflow on the slide); shorten it or use fewer rows. A slide title (not the cover) wraps at the panel width (150–1810) and may take two lines; a third line overflows.
- adjust (update on the slide, its slide-layout or a child; not for the title template) moves the table panel with its rows and, for table-image, the figure frame, and sets the table-image table width and the table panel height: {"table":{"dx":0,"dy":-60,"w":800,"h":500},"figure":{"dx":0,"dy":0},"title":{"dx":0,"dy":0}} in px of a 1920-wide slide (4:3 shrinks x). w is ${TABLE_IMAGE_WIDTH_RANGE.min}–${TABLE_IMAGE_WIDTH_RANGE.max} (default ${TABLE_IMAGE_SPEC.tableWidth}); the figure keeps its right edge and gets narrower. null resets a value. The title follows the table's dy (not dx); title dx/dy move it further on its own.
- table.h (any template with rows) fixes the height of the grey table panel; the rows share that height (rows with their own height keep it, the others split the rest), so a smaller h stops rows from stretching to fill a tall panel. Without h the height follows the row count and text. h is kept between room for every row at one line and the slide bottom (table-images: the figures below keep at least ${TABLE_IMAGES_SPEC.minFiguresHeightPx}px and shrink as the table grows). Without dy, the panel keeps its top edge; with a fixed h the panel top is the full-panel top (y ${TABLE_IMAGE_SPEC.top}; table-images ${TABLE_IMAGES_SPEC.top}; the tighter layout ${TABLE_SPEC.tight.panelTop}) plus dy.
- Other nodes may be put inside a slide (parent = the slide id) and keep their positions.

Example:
{"canvas_id":"canvas:…","label":"Login flow","ops":[
 {"op":"create","type":"geo","as":"a","text":"Start","x":0,"y":0,"w":160,"h":60,"fill":"#e8eefc"},
 {"op":"create","type":"geo","as":"b","text":"Login","place":{"rightOf":"$a","gap":80},"w":160,"h":60},
 {"op":"connect","from":"$a","to":"$b","label":"open"},
 {"op":"create","type":"note","text":"Check 2FA","place":{"below":"$b"}},
 {"op":"move","ids":["node:x"],"dx":0,"dy":200}]}
`
