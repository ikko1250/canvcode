import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  applyMat,
  randomIdSuffix,
  transformOf,
  unionBoxes,
  indicesBetween,
  type Box,
  type FileRecord,
  type NodeRecord,
  type Patch,
  type Transaction,
  type Vec,
  type WorkspaceRecord,
} from '@canvcode/core'
import { adjustOf, GEO_SHAPES, normalizeCrop, richTextFromPlain, slotsOf, solidPaint, toFill, type ImageCrop, type SlideLayoutKind, type SlideRatio } from '@canvcode/nodes'
import { getMaxRowCount } from '@canvcode/slides'
import { alignBoxes, distributeBoxes, spaceBoxes, type ArrangeBox, type Move } from '@canvcode/canvas/arrange'
import { makeBinding } from '@canvcode/canvas/bindings'
import { nodeIn, type Editor } from '@canvcode/canvas/editor'
import { patchAdjust, tableHeightPatch } from '@canvcode/canvas/slideLayoutAdjust'
import { presentRows } from '@canvcode/canvas/slideLayoutArrange'
import { hasSlideLayoutRows, slideLayoutRowOf } from '@canvcode/canvas/slideLayoutRows'
import type { HistoryMeta, OwnerPortalDeletion } from '@canvcode/canvas/workspace'
import { z } from 'zod'
import type { AgentOpEntry, StoredRecord } from '../records.ts'
import type { AgentHost } from './host.ts'

// AI の編集（MCP の edit_canvas、undo_canvas_edit）。
// - 1 回の呼び出しの操作（ops）をすべて、サーバーの中のワークスペース（host.ts）の 1 つのトランザクション（source: 'user'）で行う。
//   ストアのフック（矢印の端・空の group・持ち主とゴミ箱）は、画面で操作したときと同じく働く
// - 途中の操作が 1 つでも失敗したら、何も変えない（エラーには何番目の操作かを入れる）
// - 確定した差分を 1 回で保存し（RecordStore の 1 つのトランザクション）、開いているタブに 1 回で知らせる（origin: ai）
// - 差分の前後を agent_ops に残し、undo_canvas_edit・POST /api/agent-ops/<id>/undo で取り消せる。
//   取り消すのは、そのあと誰も変えていないときだけ（変わっていれば衝突として断る。core の History と同じ考え方）
// - 座標はワールド座標（read_canvas と同じ）。group / frame の中のノードは、親のローカル座標に直して書く
// - ツールの入力のスキーマは小さく保ち（毎回 AI に渡る）、操作ごとの細かい形はここで確かめる
// - 位置を決めずに作ったノードは、ユーザーが見ている範囲（viewport）があれば、その中心の近くの空いた所に置く
// - スライド（スライド v2）のテンプレート・行は、画面の操作と同じ Editor の関数（putSlideTemplate・putSlideLayoutRow）で書き、
//   commit の直前に Editor のコミットフックで slide-layout の子を並べ直す（arrangeSlideLayoutsOnCommit）。文字の高さは見積もり

export const MAX_OPS = 500
// 位置を決めずに作ったノードを、Canvas の中身の右に置くときの間隔
const AUTO_GAP = 80
// 見ている範囲の中心の近くで空いた所を探すとき：ほかのノードとの間隔と、探す輪の数（ノードの大きさの半分ずつ外へ）
const FREE_MARGIN = 24
const FREE_RINGS = 12
const PLACE_GAP = 40
// AI が作るテキストの既定の幅（サーバーでは文字を測れないので、幅を決めて折り返す）
const TEXT_DEFAULT_WIDTH = 240
const MAX_LABEL = 80
const MAX_LISTED_IDS = 10

// 作れる型（矢印は connect で作る）。card は File の種類から型を決める。slide-layout はスライドのテンプレート（template）で作る
const CREATABLE = ['text', 'note', 'geo', 'frame', 'slide', 'card', 'markdown-card', 'code-card'] as const
const SLIDE_TEMPLATES = ['title', 'bullets', 'table', 'table-image', 'table-images'] as const satisfies readonly SlideLayoutKind[]
const CARD_TYPES: Record<string, string> = { markdown: 'markdown-card', code: 'code-card' }

export class EditError extends Error {}

// ---- 操作の形 ----

const id = z.string().min(1)
const ids = z.array(id).min(1)
const hex = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'expected a hex colour like #3b5bdb')
const paint = z.union([hex, z.literal('none')])
const finite = z.number().finite()
const place = z
  .strictObject({ rightOf: id.optional(), leftOf: id.optional(), below: id.optional(), above: id.optional(), gap: finite.optional() })
  .refine((p) => [p.rightOf, p.leftOf, p.below, p.above].filter(Boolean).length === 1, 'place needs exactly one of rightOf, leftOf, below, above')

// AI に分かりやすい形の props（型ごとに、使えるものだけを本物の props に直す）
const style = {
  text: z.string().optional(),
  color: hex.optional(),
  fill: paint.optional(),
  stroke: paint.optional(),
  strokeWidth: finite.min(0).optional(),
  // 線の種類（geo の線、arrow の線。props の strokeDash）
  dash: z.enum(['solid', 'dashed', 'dotted']).optional(),
  // 矢じり（arrow。connect の heads と同じ）
  heads: z.enum(['end', 'start', 'both', 'none']).optional(),
  fontSize: finite.positive().optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  shape: z.enum(GEO_SHAPES as [string, ...string[]]).optional(),
  name: z.string().optional(),
  label: z.string().optional(),
  cornerRadius: finite.min(0).optional(),
  w: finite.positive().optional(),
  h: finite.positive().optional(),
  ratio: z.enum(['16:9', '4:3']).optional(),
  hidden: z.boolean().optional(),
  props: z.record(z.string(), z.unknown()).optional(),
}
const position = { x: finite.optional(), y: finite.optional(), place: place.optional() }
// スライドの表パネル・右図枠の手で直した配置（slide-layout の adjust。1920 幅の px）。null はその値を既定に戻す
const offsetValue = finite.nullable().optional()
const slideAdjust = z.strictObject({
  table: z.strictObject({ dx: offsetValue, dy: offsetValue, w: offsetValue, h: offsetValue }).optional(),
  figure: z.strictObject({ dx: offsetValue, dy: offsetValue }).optional(),
  title: z.strictObject({ dx: offsetValue, dy: offsetValue }).optional(),
})
// 画像の切り抜く範囲（画像全体を 0〜1 とした割合）。null は切り抜きをやめる
const unit = finite.min(0).max(1)
const crop = z.strictObject({ x: unit, y: unit, w: unit.positive(), h: unit.positive() }).nullable()

const opSchemas = {
  create: z.strictObject({
    op: z.literal('create'),
    type: z.enum(CREATABLE),
    as: z.string().optional(),
    parent: id.optional(),
    file: id.optional(),
    rotation: finite.optional(),
    template: z.enum(SLIDE_TEMPLATES).optional(),
    ...position,
    ...style,
  }),
  update: z.strictObject({
    op: z.literal('update'),
    id,
    rotation: finite.optional(),
    locked: z.boolean().optional(),
    opacity: finite.min(0).max(1).optional(),
    x: finite.optional(),
    y: finite.optional(),
    template: z.enum(SLIDE_TEMPLATES).optional(),
    adjust: slideAdjust.optional(),
    crop: crop.optional(),
    ...style,
  }),
  move: z.strictObject({ op: z.literal('move'), ids, dx: finite.optional(), dy: finite.optional(), ...position }),
  delete: z.strictObject({ op: z.literal('delete'), ids, documents: z.enum(['trash', 'unplace']).optional() }),
  group: z.strictObject({ op: z.literal('group'), ids: z.array(id).min(2), as: z.string().optional() }),
  ungroup: z.strictObject({ op: z.literal('ungroup'), ids }),
  connect: z.strictObject({
    op: z.literal('connect'),
    from: z.union([id, z.strictObject({ x: finite, y: finite })]),
    to: z.union([id, z.strictObject({ x: finite, y: finite })]),
    as: z.string().optional(),
    label: z.string().optional(),
    color: hex.optional(),
    bend: finite.optional(),
    heads: z.enum(['end', 'start', 'both', 'none']).optional(),
    dash: z.enum(['solid', 'dashed', 'dotted']).optional(),
  }),
  align: z.strictObject({ op: z.literal('align'), ids: z.array(id).min(2), edge: z.enum(['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom']) }),
  distribute: z.strictObject({ op: z.literal('distribute'), ids: z.array(id).min(2), axis: z.enum(['x', 'y']), gap: finite.min(0).optional() }),
  reparent: z.strictObject({ op: z.literal('reparent'), ids, parent: id }),
  // スライドの slide-layout に行を足す。slide（スライドか slide-layout）なら最後に、after（行のセル）ならその行の下に足す
  add_row: z
    .strictObject({ op: z.literal('add_row'), slide: id.optional(), after: id.optional(), text: z.string().optional(), label: z.string().optional(), as: z.string().optional() })
    .refine((o) => (o.slide === undefined) !== (o.after === undefined), 'add_row needs exactly one of slide, after'),
}

type OpName = keyof typeof opSchemas
type Op = { [K in OpName]: z.infer<(typeof opSchemas)[K]> }[OpName]
type StyleInput = Partial<Record<keyof typeof style, unknown>> & { text?: string }

// ツールの入力のスキーマ（小さく保つ。操作ごとの形は parseOp で確かめる）
export const editCanvasInput = {
  canvas_id: z.string().optional().describe("Canvas id (default: the one the user is viewing)"),
  ops: z.array(z.looseObject({ op: z.string() })).min(1).max(MAX_OPS).describe('Operations (see get_canvas_format)'),
  if_rev: z.number().int().min(0).optional().describe('Fail if a node to change was modified after this rev'),
  label: z.string().max(MAX_LABEL).optional().describe('Short description shown to the user'),
}

function parseOp(raw: unknown): Op {
  const name = (raw as { op?: unknown }).op
  const schema = typeof name === 'string' ? opSchemas[name as OpName] : undefined
  if (!schema) throw new EditError(`unknown op ${JSON.stringify(name)}. Use one of ${Object.keys(opSchemas).join(', ')}`)
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]!
    throw new EditError(`${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`)
  }
  return result.data as Op
}

// ---- 実行 ----

export interface EditRequest {
  canvasId: string
  // ユーザーがこの Canvas で見ている範囲（ワールド座標）。位置を決めずに作ったノードを、その中心の近くに置く
  viewport?: Box
  ops: unknown[]
  ifRev?: number
  label?: string
}

export interface EditResult {
  batch: string
  rev: number
  created: Record<string, string>
  counts: { created: number; updated: number; deleted: number }
  warnings?: string[]
}

// 操作をすべて行い、保存して知らせる。失敗したら EditError を投げる（何も変えない）
export function editCanvas(host: AgentHost, request: EditRequest): EditResult {
  if (request.ops.length > MAX_OPS) throw new EditError(`Too many ops (${request.ops.length}). Send at most ${MAX_OPS} per call.`)
  const workspace = host.workspace()
  const canvas = workspace.getCanvas(request.canvasId)
  if (!canvas) throw new EditError(`Unknown canvas id ${request.canvasId}. Use list_canvases to find one.`)
  if (canvas.deletedAt !== null) throw new EditError(`Canvas ${request.canvasId} is in the trash.`)
  const editor = host.editor(canvas.id)
  const label = request.label?.trim() || summarize(request.ops)
  const meta: HistoryMeta = { selectionBefore: [] }
  const tx = workspace.store.begin(label, { scope: canvas.id, history: 'ignore', source: 'user', meta })
  // 画面の操作と同じく、commit の直前に slide-layout の子を並べ直す
  editor.arrangeSlideLayoutsOnCommit(tx)
  const run = new EditRun(host, editor, tx, meta, request.viewport)
  let patch: Patch<WorkspaceRecord>
  try {
    for (const [i, raw] of request.ops.entries()) {
      const name = typeof (raw as { op?: unknown })?.op === 'string' ? (raw as { op: string }).op : '?'
      try {
        run.apply(parseOp(raw), i)
        // 途中経過を知らせて、矢印の端と空間の索引を合わせる（次の操作が、今の位置を読めるように）
        tx.flush()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new EditError(`ops[${i}] (${name}): ${message}. Nothing was changed.`)
      }
    }
    patch = tx.commit()
  } catch (error) {
    if (!tx.isDone) tx.cancel()
    throw error
  }
  run.warnings.push(...overflowWarnings(editor, patch))

  // 保存するのは、db の今の値から本当に変わったものだけ（前の値は db のものを残す。Undo で戻す値）
  const records = host.records
  const entries: AgentOpEntry[] = []
  for (const [recordId, change] of patch) {
    const before = records.get(recordId) ?? null
    const after = (change.after ?? null) as StoredRecord | null
    if (JSON.stringify(before) === JSON.stringify(after)) continue
    entries.push({ id: recordId, before, after })
  }
  if (entries.length === 0) {
    host.revert(patch)
    return { batch: '', rev: records.rev, created: run.created, counts: { created: 0, updated: 0, deleted: 0 }, warnings: ['nothing changed', ...run.warnings] }
  }
  if (request.ifRev !== undefined) {
    const revs = records.revsOf(entries.filter((e) => e.before).map((e) => e.id))
    const stale = [...revs].filter(([, rev]) => rev > request.ifRev!).map(([recordId]) => recordId)
    if (stale.length) {
      host.revert(patch)
      throw new EditError(
        `Conflict: ${stale.length} record(s) changed after rev ${request.ifRev} (${listIds(stale)}). Nothing was changed. ` +
          `Read them again (read_canvas since=${request.ifRev}) and retry.`,
      )
    }
  }
  const batch = `ai-${randomIdSuffix(12)}`
  let rev: number
  try {
    rev = records.applyAgentOp({ id: batch, canvasId: canvas.id, label, createdAt: Date.now(), patch: entries })
  } catch (error) {
    host.revert(patch)
    throw new EditError(`Could not save: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`)
  }
  const counts = countNodes(entries)
  const puts = entries.flatMap((e) => (e.after ? [e.after] : []))
  const deleted = entries.flatMap((e) => (e.after ? [] : [e.id]))
  host.sync?.broadcast(
    rev,
    puts,
    { origin: { kind: 'ai', batchId: batch, label, canvasId: canvas.id, count: counts.created + counts.updated + counts.deleted } },
    { deleted, except: host.listener },
  )
  return { batch, rev, created: run.created, counts, ...(run.warnings.length ? { warnings: run.warnings } : {}) }
}

// AI の編集を取り消す。そのあとに変わったレコードがあれば、何もせずに EditError を投げる
export function undoCanvasEdit(host: AgentHost, batchId: string): { rev: number; restored: number } {
  const records = host.records
  const op = records.getAgentOp(batchId)
  if (!op) throw new EditError(`Unknown batch ${batchId} (only the latest edits are kept).`)
  if (op.undoneAt !== null) throw new EditError(`Batch ${batchId} is already undone.`)
  const conflicts = op.patch.filter((e) => JSON.stringify(records.get(e.id) ?? null) !== JSON.stringify(e.after)).map((e) => e.id)
  if (conflicts.length) {
    throw new EditError(`Conflict: ${conflicts.length} record(s) changed after this edit (${listIds(conflicts)}). Nothing was undone.`)
  }
  const puts = op.patch.flatMap((e) => (e.before ? [e.before] : []))
  const deleted = op.patch.flatMap((e) => (e.before ? [] : [e.id]))
  const rev = records.applyAgentUndo(op.id, puts, deleted)
  // サーバーの中のワークスペースにも、SyncHub の購読から当たる（なければ直接当てる）
  if (host.sync) host.sync.broadcast(rev, puts, { origin: { kind: 'ai-undo', batchId: op.id, label: op.label, canvasId: op.canvasId } }, { deleted })
  else host.applyRemote(puts as unknown as WorkspaceRecord[], deleted)
  return { rev, restored: op.patch.length }
}

// 変えたスライド（中身を変えたものも）のうち、文字があふれている・並べられなかった行があるものの警告
function overflowWarnings(editor: Editor, patch: Patch<WorkspaceRecord>): string[] {
  const overflows = editor.slideOverflows()
  if (overflows.size === 0) return []
  const touched = new Set<string>()
  for (const id of patch.keys()) {
    if (!editor.index.get(id)) continue
    touched.add(id)
    for (const ancestor of editor.index.ancestorsOf(id)) touched.add(ancestor)
  }
  return [...overflows].flatMap(([slideId, { nodes, extraRows }]) => {
    if (!touched.has(slideId)) return []
    const parts = [nodes.length ? `text does not fit in ${listIds(nodes)}` : '', extraRows ? `${extraRows} row(s) over the limit are not placed` : '']
    return [`slide ${slideId} overflows: ${parts.filter(Boolean).join('; ')}`]
  })
}

function countNodes(entries: AgentOpEntry[]): EditResult['counts'] {
  const counts = { created: 0, updated: 0, deleted: 0 }
  for (const e of entries) {
    if ((e.after ?? e.before)?.typeName !== 'node') continue
    if (!e.before) counts.created++
    else if (!e.after) counts.deleted++
    else counts.updated++
  }
  return counts
}

// 既定のラベル：操作の種類と数（「create 3, connect 2」）
function summarize(ops: unknown[]): string {
  const counts = new Map<string, number>()
  for (const op of ops) {
    const name = String((op as { op?: unknown })?.op ?? '?')
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts].map(([name, n]) => `${name} ${n}`).join(', ').slice(0, MAX_LABEL)
}

function listIds(ids: string[]): string {
  return ids.slice(0, MAX_LISTED_IDS).join(', ') + (ids.length > MAX_LISTED_IDS ? `, +${ids.length - MAX_LISTED_IDS}` : '')
}

// 1 回の edit_canvas の操作を行う
class EditRun {
  readonly created: Record<string, string> = {}
  readonly warnings: string[] = []
  private readonly refs = new Map<string, string>()
  private readonly host: AgentHost
  private readonly editor: Editor
  private readonly tx: Transaction<WorkspaceRecord>
  private readonly meta: HistoryMeta
  // 位置を決めずに作るノードを置く所（最初は見ている範囲の中心の近くの空いた所か、Canvas の中身の右）
  private auto: Vec | null = null
  private readonly viewport: Box | undefined

  constructor(host: AgentHost, editor: Editor, tx: Transaction<WorkspaceRecord>, meta: HistoryMeta, viewport?: Box) {
    this.host = host
    this.editor = editor
    this.tx = tx
    this.meta = meta
    this.viewport = viewport
  }

  private get canvasId(): string {
    return this.editor.canvasId
  }

  apply(op: Op, i: number): void {
    switch (op.op) {
      case 'create':
        return this.create(op, i)
      case 'update':
        return this.update(op)
      case 'move':
        return this.move(op)
      case 'delete':
        return this.remove(op)
      case 'group':
        return this.group(op, i)
      case 'ungroup':
        return this.ungroup(op)
      case 'connect':
        return this.connect(op, i)
      case 'align':
        return this.arrange(op.ids, (boxes) => alignBoxes(boxes, op.edge))
      case 'distribute':
        if (op.gap === undefined && op.ids.length < 3) throw new EditError('distribute needs at least 3 ids (or a gap)')
        return this.arrange(op.ids, (boxes) => (op.gap === undefined ? distributeBoxes(boxes, op.axis) : spaceBoxes(boxes, op.axis, op.gap)))
      case 'reparent':
        return this.reparent(op)
      case 'add_row':
        return this.addRow(op, i)
    }
  }

  // ---- 操作 ----

  private create(op: Extract<Op, { op: 'create' }>, i: number): void {
    let type: string = op.type
    let file: FileRecord | undefined
    if (type === 'card' || type.endsWith('-card')) {
      if (!op.file) throw new EditError(`${type} needs file (a document id from list_documents)`)
      file = this.ensureFile(op.file)
      const cardType = CARD_TYPES[file.kind]
      if (!cardType) throw new EditError(`${op.file} is a ${file.kind} file and cannot be placed as a card`)
      if (type !== 'card' && type !== cardType) throw new EditError(`${op.file} is a ${file.kind} file; use type ${cardType} (or card)`)
      type = cardType
    } else if (op.file) {
      throw new EditError(`file is only for cards`)
    }
    const parentId = op.parent ? this.container(op.parent) : this.canvasId
    const def = this.editor.types.get(type)!
    let props = applyStyle(type, def.defaultProps() as Record<string, unknown>, op, true)
    if (file) props = { ...props, fileId: file.id, role: file.ownerNodeId === null ? 'owner' : 'shortcut' }
    if (op.as !== undefined && this.refs.has(op.as)) throw new EditError(`"as": "${op.as}" is already used`)
    if (op.template !== undefined && type !== 'slide') throw new EditError('template is only for slides')
    if (op.rotation && (def.canRotate === false || def.container === 'group')) throw new EditError(`${type} cannot be rotated`)
    const node = this.editor.makeNode(type, { x: 0, y: 0, parentId, props })
    this.tx.put(node)
    this.tx.flush()
    if (op.rotation) this.rotate(node.id, op.rotation)
    const target = this.targetTopLeft(node.id, op, parentId)
    this.translateTo(node.id, target.point, target.aabb)
    if (op.template !== undefined) this.applyTemplate(node.id, op.template)
    this.remember(node.id, op.as, i)
  }

  private update(op: Extract<Op, { op: 'update' }>): void {
    const nodeId = this.node(op.id)
    let node = nodeIn(this.tx, nodeId)!
    if (op.locked === false && node.locked) {
      node = { ...node, locked: false }
      this.tx.put(node)
    }
    const changesOtherThanLock = Object.keys(op).some((key) => key !== 'op' && key !== 'id' && key !== 'locked')
    if (node.locked && changesOtherThanLock) throw new EditError(`${nodeId} is locked. Add "locked": false to change it`)
    const def = this.editor.getType(node)
    let props = applyStyle(node.type, node.props as Record<string, unknown>, op, false)
    if (op.crop !== undefined) props = cropProps(nodeId, node.type, props, op.crop)
    if (op.w !== undefined || op.h !== undefined) {
      if (!def.resize) throw new EditError(`${node.type} cannot be resized`)
      const bounds = def.getBounds({ ...node, props })
      props = def.resize({ ...node, props }, { w: op.w ?? bounds.w, h: op.h ?? bounds.h }) as Record<string, unknown>
    }
    const next: NodeRecord = { ...node, props }
    if (op.opacity !== undefined) next.opacity = op.opacity
    if (op.locked === true) next.locked = true
    this.tx.put(next)
    // スライドの比率を変えたら、中の slide-layout の大きさも合わせる（画面の比率の切り替えと同じ）
    if (node.type === 'slide' && op.ratio !== undefined) this.editor.putSlideRatio(this.tx, nodeId, op.ratio as SlideRatio)
    this.tx.flush()
    if (op.template !== undefined) {
      if (node.type !== 'slide') throw new EditError('template is only for slides')
      this.applyTemplate(nodeId, op.template)
    }
    if (op.adjust !== undefined) this.adjustSlideLayout(nodeId, op.adjust)
    if (op.rotation !== undefined) {
      if (def.canRotate === false || def.container === 'group') throw new EditError(`${node.type} cannot be rotated`)
      this.rotate(nodeId, op.rotation)
    }
    if (op.x !== undefined || op.y !== undefined) {
      const current = this.topLeft(nodeId)
      this.translateTo(nodeId, { x: op.x ?? current.x, y: op.y ?? current.y }, false)
    }
  }

  // スライド（か slide-layout・その子）の slide-layout の配置（adjust）を変える（画面のデザインパネルの「配置」と同じ）。並べ直しは commit の直前
  private adjustSlideLayout(nodeId: string, adjust: z.infer<typeof slideAdjust>): void {
    const node = nodeIn(this.tx, nodeId)!
    const parent = nodeIn(this.tx, node.parentId)
    const layout =
      node.type === 'slide-layout'
        ? node
        : node.type === 'slide'
          ? this.editor.index.childrenOf(nodeId).map((id) => nodeIn(this.tx, id)).find((child) => child?.type === 'slide-layout')
          : parent?.type === 'slide-layout'
            ? parent
            : undefined
    if (!layout) throw new EditError(`${nodeId} is not a slide with a template`)
    const props = layout.props as Record<string, unknown>
    if (!hasSlideLayoutRows(props.layout)) throw new EditError('adjust is not for the title template')
    if ((adjust.table?.w != null || adjust.figure) && props.layout !== 'table-image') throw new EditError('table.w and figure are only for the table-image template')
    const orUndefined = (group: Record<string, number | null | undefined> | undefined) =>
      group && Object.fromEntries(Object.entries(group).filter(([, v]) => v !== undefined).map(([k, v]) => [k, v ?? undefined]))
    const table = orUndefined(adjust.table)
    // 表パネルの高さは行数で決まる範囲に収める。dy を指定しなければ、パネルの上端を今の位置に残す（画面のデザインパネルと同じ）
    if (table && adjust.table?.h !== undefined) {
      const slots = slotsOf(props.slots)
      const rowCount = presentRows(slots, (id) => nodeIn(this.tx, id)?.parentId === layout.id).length
      const panel = slots.panel ? nodeIn(this.tx, slots.panel) : undefined
      const panelY = adjust.table.dy === undefined && panel?.parentId === layout.id ? panel.y : undefined
      Object.assign(table, tableHeightPatch(props.layout, rowCount, panelY, adjust.table.h ?? undefined))
    }
    const next = patchAdjust(adjustOf(props.adjust), { table, figure: orUndefined(adjust.figure), title: orUndefined(adjust.title) })
    this.tx.put({ ...layout, props: { ...props, adjust: next } })
    this.tx.flush()
  }

  private move(op: Extract<Op, { op: 'move' }>): void {
    const list = this.roots(op.ids.map((ref) => this.node(ref)))
    for (const nodeId of list) if (nodeIn(this.tx, nodeId)!.locked) throw new EditError(`${nodeId} is locked. Unlock it first (update with "locked": false)`)
    const hasDelta = op.dx !== undefined || op.dy !== undefined
    const hasTarget = op.x !== undefined || op.y !== undefined || op.place !== undefined
    if (hasDelta === hasTarget) throw new EditError('move needs either dx/dy or x/y/place')
    if (hasDelta) return this.translate(list, op.dx ?? 0, op.dy ?? 0)
    // 1 つなら read_canvas の x,y と同じ点（箱の左上）、いくつかなら全体を囲む箱の左上を合わせる
    const single = list.length === 1
    const from = single && !op.place ? this.topLeft(list[0]!) : this.aabbOf(list)
    let target: Vec = { x: from.x, y: from.y }
    if (op.place) target = this.placeBeside(op.place, this.aabbOf(list))
    target = { x: op.x ?? target.x, y: op.y ?? target.y }
    this.translate(list, target.x - from.x, target.y - from.y)
  }

  private remove(op: Extract<Op, { op: 'delete' }>): void {
    const list = op.ids.map((ref) => this.node(ref))
    for (const nodeId of list) if (nodeIn(this.tx, nodeId)?.locked) throw new EditError(`${nodeId} is locked. Unlock it first (update with "locked": false)`)
    // 持ち主（Portal やカード）を消したときの参照先の扱い。既定はゴミ箱（画面の「ゴミ箱に送る」と同じで、あとで戻せる）
    this.meta.ownerPortalDeletion = (op.documents ?? 'trash') as OwnerPortalDeletion
    for (const nodeId of list) this.tx.remove(nodeId)
  }

  private group(op: Extract<Op, { op: 'group' }>, i: number): void {
    const nodes = op.ids.map((ref) => nodeIn(this.tx, this.node(ref))!)
    const parentId = nodes[0]!.parentId
    if (nodes.some((n) => n.parentId !== parentId)) throw new EditError('nodes to group must have the same parent')
    // Editor.groupSelected と同じ：group は親の原点に置き、一番手前の子の重なり順を group に譲る
    const members = this.editor.index.sortByOrder(nodes.map((n) => n.id))
    const topmost = nodeIn(this.tx, members.at(-1)!)!
    const group = this.editor.makeNode('group', { x: 0, y: 0, parentId, index: topmost.index })
    this.tx.put(group)
    const indices = indicesBetween(null, null, members.length)
    for (const [k, memberId] of members.entries()) this.tx.put({ ...nodeIn(this.tx, memberId)!, parentId: group.id, index: indices[k]! })
    this.remember(group.id, op.as, i)
  }

  private ungroup(op: Extract<Op, { op: 'ungroup' }>): void {
    for (const ref of op.ids) {
      const group = nodeIn(this.tx, this.node(ref))!
      if (!this.editor.isContainer(group, 'group')) throw new EditError(`${group.id} is not a group`)
      // Editor.ungroupSelected と同じ：子はワールドでの位置を保ったまま、group があった重なり順の位置に並べる
      const children = this.editor.index.childrenOf(group.id)
      const siblings = this.editor.index.childrenOf(group.parentId)
      const at = siblings.indexOf(group.id)
      const before = at > 0 ? nodeIn(this.tx, siblings[at - 1]!)!.index : null
      const after = at >= 0 && at < siblings.length - 1 ? nodeIn(this.tx, siblings[at + 1]!)!.index : null
      const indices = indicesBetween(before, after, children.length)
      for (const [k, childId] of children.entries()) {
        const child = nodeIn(this.tx, childId)!
        this.tx.put({ ...this.editor.fromWorld(this.editor.toWorld(child), group.parentId), index: indices[k]! })
      }
      this.tx.remove(group.id)
      this.tx.flush()
    }
  }

  private connect(op: Extract<Op, { op: 'connect' }>, i: number): void {
    const end = (value: string | Vec): { point: Vec; target?: string } => {
      if (typeof value !== 'string') return { point: value }
      const target = this.node(value)
      const node = nodeIn(this.tx, target)!
      if (this.editor.getType(node).canBind === false) throw new EditError(`cannot connect to ${node.type} ${target}`)
      const box = this.editor.index.get(target)!.worldBounds
      return { point: { x: box.x + box.w / 2, y: box.y + box.h / 2 }, target }
    }
    const a = end(op.from)
    const b = end(op.to)
    if (a.target && a.target === b.target) throw new EditError('from and to are the same node')
    const heads = op.heads ?? 'end'
    const arrow = this.editor.makeNode('arrow', {
      x: a.point.x,
      y: a.point.y,
      props: {
        start: { x: 0, y: 0 },
        end: { x: b.point.x - a.point.x, y: b.point.y - a.point.y },
        bend: op.bend ?? 0,
        arrowheadStart: heads === 'start' || heads === 'both' ? 'arrow' : 'none',
        arrowheadEnd: heads === 'end' || heads === 'both' ? 'arrow' : 'none',
        ...(op.label !== undefined ? { label: op.label } : {}),
        ...(op.color !== undefined ? { color: op.color } : {}),
        ...(op.dash !== undefined && op.dash !== 'solid' ? { strokeDash: op.dash } : {}),
      },
    })
    this.tx.put(arrow)
    // 端をノードにつなぐ（つながっている先の中心を向く。端の位置は、ストアのフックが縁で切って決める）
    for (const [terminal, end] of [['start', a], ['end', b]] as const) {
      if (end.target) this.tx.put(makeBinding(arrow.id, end.target, { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false }))
    }
    this.remember(arrow.id, op.as, i)
  }

  private arrange(refs: string[], plan: (boxes: ArrangeBox[]) => Move[]): void {
    const list = this.roots(refs.map((ref) => this.node(ref)))
    for (const nodeId of list) if (nodeIn(this.tx, nodeId)!.locked) throw new EditError(`${nodeId} is locked`)
    const boxes = list.map((nodeId) => ({ id: nodeId, ...this.editor.index.get(nodeId)!.worldBounds }))
    const moves = plan(boxes)
    this.editor.detachArrows(this.tx, moves.map((m) => m.id))
    for (const move of moves) this.shift(move.id, move.dx, move.dy)
  }

  private reparent(op: Extract<Op, { op: 'reparent' }>): void {
    const parentId = op.parent === 'canvas' || op.parent === this.canvasId ? this.canvasId : this.container(op.parent)
    const list = op.ids.map((ref) => this.node(ref))
    for (const nodeId of list) {
      if (this.editor.isAncestorOrSelf(nodeId, parentId)) throw new EditError(`cannot put ${nodeId} inside itself`)
    }
    this.editor.reparent(this.tx, list, parentId)
  }

  // ---- スライド ----

  // 子の無いスライドに、テンプレートの slide-layout と子を置く（画面の applySlideTemplate と同じ。並べ直しは commit の直前）
  private applyTemplate(slideId: string, kind: SlideLayoutKind): void {
    if (this.editor.index.childrenOf(slideId).length > 0) throw new EditError(`${slideId} already has contents; a template needs an empty slide`)
    this.editor.putSlideTemplate(this.tx, slideId, kind)
    this.tx.flush()
  }

  // slide-layout に行を足す（画面の addSlideLayoutRow と同じく、隣の行のセルの書式を写す）。text / label で文字も書く。
  // as は本文の子の名前（見出しの子は created の "<as>:label"）
  private addRow(op: Extract<Op, { op: 'add_row' }>, i: number): void {
    const ref = this.node((op.slide ?? op.after)!)
    let layout = nodeIn(this.tx, ref)!
    if (op.after !== undefined || layout.type === 'slide') {
      const parentId = op.after !== undefined ? layout.parentId : layout.id
      const found =
        op.after !== undefined
          ? nodeIn(this.tx, parentId)
          : this.editor.index.childrenOf(parentId).map((id) => nodeIn(this.tx, id)).find((child) => child?.type === 'slide-layout')
      if (found?.type !== 'slide-layout') {
        throw new EditError(op.after !== undefined ? `${ref} is not a cell of a slide layout` : `${ref} has no template (apply one with "template")`)
      }
      layout = found
    } else if (layout.type !== 'slide-layout') {
      throw new EditError(`${ref} is not a slide`)
    }
    if (layout.locked) throw new EditError(`${layout.id} is locked`)
    const props = layout.props as Record<string, unknown>
    if (!hasSlideLayoutRows(props.layout)) throw new EditError(`a ${String(props.layout)} slide has no rows`)
    const rows = presentRows(slotsOf(props.slots), (id) => nodeIn(this.tx, id)?.parentId === layout.id)
    const max = getMaxRowCount(props.layout)
    if (rows.length >= max) throw new EditError(`a ${props.layout} slide has at most ${max} rows`)
    if (rows.length === 0) throw new EditError(`${layout.id} has no row to copy`)
    let at = rows.length - 1
    if (op.after !== undefined) {
      at = slideLayoutRowOf(rows, ref)
      if (at < 0) throw new EditError(`${ref} is not a cell of a row`)
    }
    const added = this.editor.putSlideLayoutRow(this.tx, layout.id, at)
    if (op.label !== undefined && !added.label) throw new EditError(`a ${props.layout} slide has no row labels`)
    const write = (cellId: string, text: string) => {
      const cell = nodeIn(this.tx, cellId)!
      this.tx.put({ ...cell, props: applyStyle(cell.type, cell.props as Record<string, unknown>, { text }, false) })
    }
    if (op.text !== undefined) write(added.body, op.text)
    if (op.label !== undefined) write(added.label!, op.label)
    this.remember(added.body, op.as, i)
    if (added.label) this.created[`${op.as ?? `#${i}`}:label`] = added.label
  }

  // ---- 位置 ----

  // 作ったノードを置く左上（ワールド座標）。aabb は外接の箱の左上か（false なら箱の左上の点）
  private targetTopLeft(nodeId: string, op: { x?: number; y?: number; place?: z.infer<typeof place> }, parentId: string): { point: Vec; aabb: boolean } {
    const box = this.editor.index.get(nodeId)!.worldBounds
    if (op.place) {
      const point = this.placeBeside(op.place, box)
      return { point: { x: op.x ?? point.x, y: op.y ?? point.y }, aabb: true }
    }
    if (op.x !== undefined && op.y !== undefined) return { point: { x: op.x, y: op.y }, aabb: false }
    let fallback: Vec
    if (parentId !== this.canvasId) {
      // 親（frame / group）の左上から少し内側
      const parent = this.editor.index.get(parentId)!.worldBounds
      fallback = { x: parent.x + 24, y: parent.y + 24 }
    } else {
      // 見ている範囲の中心の近くの空いた所（なければ Canvas の中身の右）から、上から順に並べる
      if (!this.auto && this.viewport) this.auto = this.freeSpot(nodeId, box, this.viewport)
      if (!this.auto) {
        const content = unionBoxes(this.editor.index.childrenOf(this.canvasId).flatMap((rootId) => (rootId === nodeId ? [] : [this.editor.index.get(rootId)!.worldBounds])))
        this.auto = content ? { x: content.x + content.w + AUTO_GAP, y: content.y } : { x: 0, y: 0 }
      }
      fallback = { ...this.auto }
      this.auto = { x: this.auto.x, y: this.auto.y + box.h + PLACE_GAP }
    }
    return { point: { x: op.x ?? fallback.x, y: op.y ?? fallback.y }, aabb: op.x === undefined && op.y === undefined }
  }

  // view の中心の近くで、box の大きさが空いている所の左上（ワールド座標）。中心から輪を広げて探し、なければ null。
  // この呼び出しで先に作ったノードも、空間の索引に入っているので避ける
  private freeSpot(nodeId: string, box: Box, view: Box): Vec | null {
    const stepX = Math.max(20, (box.w + FREE_MARGIN) / 2)
    const stepY = Math.max(20, (box.h + FREE_MARGIN) / 2)
    const origin = { x: view.x + view.w / 2 - box.w / 2, y: view.y + view.h / 2 - box.h / 2 }
    for (let r = 0; r <= FREE_RINGS; r++) {
      const ring: [number, number][] = []
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) if (Math.max(Math.abs(i), Math.abs(j)) === r) ring.push([i, j])
      ring.sort((a, b) => (a[0] * stepX) ** 2 + (a[1] * stepY) ** 2 - ((b[0] * stepX) ** 2 + (b[1] * stepY) ** 2))
      for (const [i, j] of ring) {
        const x = Math.round(origin.x + i * stepX)
        const y = Math.round(origin.y + j * stepY)
        const area = { x: x - FREE_MARGIN, y: y - FREE_MARGIN, w: box.w + FREE_MARGIN * 2, h: box.h + FREE_MARGIN * 2 }
        if (this.editor.index.search(area).every((hit) => hit === nodeId)) return { x, y }
      }
    }
    return null
  }

  // ref の隣に、box（ワールド座標）を置くときの左上
  private placeBeside(spec: z.infer<typeof place>, box: Box): Vec {
    const gap = spec.gap ?? PLACE_GAP
    const refId = this.node((spec.rightOf ?? spec.leftOf ?? spec.below ?? spec.above)!)
    const r = this.editor.index.get(refId)!.worldBounds
    if (spec.rightOf) return { x: r.x + r.w + gap, y: r.y }
    if (spec.leftOf) return { x: r.x - gap - box.w, y: r.y }
    if (spec.below) return { x: r.x, y: r.y + r.h + gap }
    return { x: r.x, y: r.y - gap - box.h }
  }

  // ノードの箱の左上（ワールド座標。read_canvas の x,y と同じ点）
  private topLeft(nodeId: string): Vec {
    const entry = this.editor.index.get(nodeId)!
    return applyMat(entry.worldMatrix, { x: entry.localBounds.x, y: entry.localBounds.y })
  }

  private aabbOf(list: string[]): Box {
    return unionBoxes(list.map((nodeId) => this.editor.index.get(nodeId)!.worldBounds))!
  }

  private translateTo(nodeId: string, point: Vec, aabb: boolean): void {
    const from = aabb ? this.editor.index.get(nodeId)!.worldBounds : this.topLeft(nodeId)
    this.translate([nodeId], point.x - from.x, point.y - from.y)
  }

  // ワールド座標で動かす。一緒に動かない先につながった矢印は、つながりを外す（Editor.moveNodes と同じ）
  private translate(list: string[], dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return
    this.editor.detachArrows(this.tx, list)
    for (const nodeId of list) this.shift(nodeId, dx, dy)
  }

  private shift(nodeId: string, dx: number, dy: number): void {
    const node = nodeIn(this.tx, nodeId)
    if (!node) return
    const world = this.editor.toWorld(node)
    this.tx.put(this.editor.fromWorld({ ...world, x: world.x + dx, y: world.y + dy }))
  }

  // ワールドでの回転（度）にする。箱の中心は動かさない
  private rotate(nodeId: string, degrees: number): void {
    const node = nodeIn(this.tx, nodeId)!
    const entry = this.editor.index.get(nodeId)!
    const b = entry.localBounds
    const local = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
    const center = applyMat(entry.worldMatrix, local)
    const rotation = (degrees * Math.PI) / 180
    const offset = applyMat(transformOf(0, 0, rotation), local)
    const world = this.editor.toWorld(node)
    this.tx.put(this.editor.fromWorld({ ...world, x: center.x - offset.x, y: center.y - offset.y, rotation }))
    this.tx.flush()
  }

  // ---- id ----

  private remember(nodeId: string, as: string | undefined, i: number): void {
    if (as !== undefined) {
      if (this.refs.has(as)) throw new EditError(`"as": "${as}" is already used`)
      this.refs.set(as, nodeId)
    }
    this.created[as ?? `#${i}`] = nodeId
  }

  // "$a" を作ったノードの id にし、この Canvas のノードか確かめる
  private node(ref: string): string {
    let nodeId = ref
    if (ref.startsWith('$')) {
      const found = this.refs.get(ref.slice(1))
      if (!found) throw new EditError(`unknown reference ${ref} (name a node with "as" in an earlier op)`)
      nodeId = found
    }
    const node = nodeIn(this.tx, nodeId)
    if (!node) throw new EditError(`unknown node ${nodeId}`)
    if (this.host.workspace().canvasOf(nodeId) !== this.canvasId) throw new EditError(`${nodeId} is not on canvas ${this.canvasId}`)
    if (!this.editor.index.get(nodeId)) throw new EditError(`${nodeId} is not on canvas ${this.canvasId}`)
    return nodeId
  }

  private container(ref: string): string {
    const nodeId = this.node(ref)
    if (!this.editor.isContainer(nodeIn(this.tx, nodeId)!)) throw new EditError(`${nodeId} is not a frame or group`)
    return nodeId
  }

  // 祖先も含まれているものは、祖先と一緒に動くので除く
  private roots(list: string[]): string[] {
    const set = new Set(list)
    return [...set].filter((nodeId) => !this.editor.index.ancestorsOf(nodeId).some((a) => set.has(a)))
  }

  // カードにする File。レコードにまだなければ（外で作った File）、FileStore の情報から入れる
  private ensureFile(fileId: string): FileRecord {
    const workspace = this.host.workspace()
    const existing = workspace.getFile(fileId)
    if (existing) {
      if (existing.deletedAt !== null) throw new EditError(`${fileId} is in the trash`)
      return existing
    }
    let info
    try {
      info = this.host.files?.getInfo(fileId)
    } catch {
      info = undefined
    }
    if (!info) throw new EditError(`unknown document ${fileId}`)
    const now = Date.now()
    const record: FileRecord = {
      typeName: 'file',
      id: info.id,
      kind: info.kind,
      title: info.title,
      path: info.path,
      size: info.size,
      mtime: info.mtime,
      hash: info.hash,
      missing: info.missing,
      parentCanvasId: null,
      ownerNodeId: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      trash: null,
    }
    this.tx.put(record)
    return record
  }
}

// ---- props ----

// AI に分かりやすい形の値（text・fill・color など）を、型の本物の props に直す。その型で使えない値はエラーにする
function applyStyle(type: string, base: Record<string, unknown>, input: StyleInput, creating: boolean): Record<string, unknown> {
  const props: Record<string, unknown> = { ...base }
  const used = new Set<string>()
  const take = <T>(key: keyof typeof style): T | undefined => {
    const value = input[key]
    if (value !== undefined) used.add(key)
    return value as T | undefined
  }
  const text = take<string>('text')
  const label = take<string>('label')
  const name = take<string>('name')
  const color = take<string>('color')
  const fill = take<string>('fill')
  const stroke = take<string>('stroke')
  const strokeWidth = take<number>('strokeWidth')
  const dash = take<string>('dash')
  const heads = take<string>('heads')
  const fontSize = take<number>('fontSize')
  const align = take<string>('align')
  const shape = take<string>('shape')
  const cornerRadius = take<number>('cornerRadius')
  const ratio = take<string>('ratio')
  const hidden = take<boolean>('hidden')
  const w = creating ? take<number>('w') : undefined
  const h = creating ? take<number>('h') : undefined
  const raw = take<Record<string, unknown>>('props')
  const accepted = new Set<string>(['props'])
  const set = (key: string, value: unknown, field: string) => {
    if (value === undefined) return
    props[key] = value
    accepted.add(field)
  }
  switch (type) {
    case 'text':
      if (creating) {
        props.autoWidth = false
        props.w = TEXT_DEFAULT_WIDTH
      }
      set('paragraphs', text === undefined ? undefined : richTextFromPlain(text), 'text')
      set('color', color, 'color')
      set('fontSize', fontSize, 'fontSize')
      set('align', align, 'align')
      set('w', w, 'w')
      break
    case 'note':
      set('paragraphs', text === undefined ? undefined : richTextFromPlain(text), 'text')
      // 付箋の色は背景の色
      set('color', color ?? fill, color !== undefined ? 'color' : 'fill')
      if (color !== undefined && fill !== undefined) throw new EditError('give either color or fill for a note (both are the background)')
      set('fontSize', fontSize, 'fontSize')
      set('align', align, 'align')
      set('w', w, 'w')
      set('h', h, 'h')
      break
    case 'geo': {
      if (text !== undefined && label !== undefined) throw new EditError('give either text or label')
      const value = text ?? label
      if (value !== undefined) {
        set('label', value, text !== undefined ? 'text' : 'label')
        props.labelParagraphs = richTextFromPlain(value)
      }
      set('fill', fill === undefined ? undefined : fill === 'none' ? null : solidPaint(fill), 'fill')
      set('stroke', stroke === undefined ? undefined : stroke === 'none' ? null : solidPaint(stroke), 'stroke')
      set('strokeWidth', strokeWidth, 'strokeWidth')
      set('strokeDash', dash, 'dash')
      set('labelColor', color, 'color')
      set('labelFontSize', fontSize, 'fontSize')
      set('labelAlign', align, 'align')
      set('shape', shape, 'shape')
      set('cornerRadius', cornerRadius, 'cornerRadius')
      set('w', w, 'w')
      set('h', h, 'h')
      break
    }
    case 'frame':
      if (text !== undefined && name !== undefined) throw new EditError('give either text or name')
      set('name', text ?? name, text !== undefined ? 'text' : 'name')
      set('w', w, 'w')
      set('h', h, 'h')
      break
    // スライドの大きさは比率から決まる（w / h は持たない）
    case 'slide':
      if (text !== undefined && name !== undefined) throw new EditError('give either text or name')
      set('name', text ?? name, text !== undefined ? 'text' : 'name')
      set('ratio', ratio, 'ratio')
      set('hidden', hidden, 'hidden')
      break
    case 'arrow':
      if (text !== undefined && label !== undefined) throw new EditError('give either text or label')
      set('label', text ?? label, text !== undefined ? 'text' : 'label')
      set('color', color, 'color')
      // 矢印の線の太さは size
      set('size', strokeWidth, 'strokeWidth')
      set('strokeDash', dash, 'dash')
      if (heads !== undefined) {
        set('arrowheadStart', heads === 'start' || heads === 'both' ? 'arrow' : 'none', 'heads')
        set('arrowheadEnd', heads === 'end' || heads === 'both' ? 'arrow' : 'none', 'heads')
      }
      break
    case 'markdown-card':
    case 'code-card':
      set('w', w, 'w')
      if (h !== undefined) {
        props.sizing = 'fixed'
        set('h', h, 'h')
      }
      break
  }
  const rejected = [...used].filter((field) => !accepted.has(field))
  if (rejected.length) throw new EditError(`${rejected.join(', ')} ${rejected.length > 1 ? 'are' : 'is'} not supported for ${type}`)
  if (raw) Object.assign(props, raw)
  return props
}

// POST /api/agent-ops/<id>/undo：画面の「元に戻す」から AI の編集を取り消す
export function handleAgentOps(req: IncomingMessage, res: ServerResponse, path: string, host: AgentHost): boolean {
  const match = /^\/api\/agent-ops\/([^/]+)\/undo$/.exec(path)
  if (!match) return false
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  if (req.method !== 'POST') {
    send(405, { error: 'method not allowed' })
    return true
  }
  try {
    send(200, { ok: true, ...undoCanvasEdit(host, decodeURIComponent(match[1]!)) })
  } catch (error) {
    if (!(error instanceof EditError)) throw error
    send(error.message.startsWith('Unknown') ? 404 : 409, { error: error.message })
  }
  return true
}

// 画像の切り抜き（画面の切り抜きモードと同じ値）。
// - image：props.crop。幅はそのままにして、高さを切り抜いた範囲の縦横比に合わせる（今の箱と crop から画像の縦横比が分かる）
// - 画像の塗りの geo（スライドの画像枠など）：塗りを切り抜き（scaleMode: crop）にする。null なら塗りつぶし（fill）に戻す
function cropProps(nodeId: string, type: string, props: Record<string, unknown>, value: ImageCrop | null): Record<string, unknown> {
  if (type === 'image') {
    const w = props.w as number
    const h = props.h as number
    const current = props.crop ? normalizeCrop(props.crop) : { x: 0, y: 0, w: 1, h: 1 }
    const next = value ? normalizeCrop(value) : { x: 0, y: 0, w: 1, h: 1 }
    // 画像全体を今の倍率で描いたときの大きさ
    const fullW = w / current.w
    const fullH = h / current.h
    return { ...props, crop: value ? next : null, h: (w * (next.h * fullH)) / (next.w * fullW) }
  }
  const fill = toFill(props.fill)
  if (type === 'geo' && fill?.type === 'image') {
    return { ...props, fill: value ? { ...fill, scaleMode: 'crop', crop: normalizeCrop(value) } : { ...fill, scaleMode: 'fill' } }
  }
  throw new EditError(`crop is only for an image or a shape with an image fill (${nodeId})`)
}
