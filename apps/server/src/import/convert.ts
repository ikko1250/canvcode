import { createHash, randomBytes } from 'node:crypto'
import type { StoredRecord } from '../records.ts'
import type { ZipReader } from './zip.ts'

// 旧データ（recursive-infinite-canvas の .ricbackup 形式 v1）を、新しいレコードに変換する（MAI-3、MAI-7、MAI-8、MAI-13、MAI-36）。
// ここではディスクにもデータベースにも書かない。書き込むもの（レコード・.md / .py の本文・Asset・サムネイル）と、
// 結果の報告をまとめて返す（書き込みは import.ts が行う）。
// - ゴミ箱の中の Document は取り込まない（MAI-36 で決定）
// - 旧の ID を引き継ぐ（接頭辞だけ置き換える）。ページの画像のように、Canvas をまたいで同じ ID があるものは、Canvas の ID を付けて分ける
// - 階層：旧のルートから Portal をたどり、最初に見つかった Portal を持ち主にする（MAI-8）。たどれないものは「未配置」
// - Markdown / Code の File の持ち主はカード。旧の Markdown / Code を指す Portal は、カードにする
// - PDF のページの画像は pdf-page にする。ページの上の書き込みは、そのままの位置に置く
// - 旧の引用（PDF の範囲を Markdown に書き込んだもの）は、引用ノートにして、その Markdown のカードの横に並べる

export interface ImportOptions {
  // 取り込み先のワークスペースのルート
  rootCanvasId: string
  // ワークスペースが空なら、旧のルートの中身をそのままルートに入れる。空でなければ「取り込み（日付）」の Canvas を作る
  empty: boolean
  // ルートにすでにあるノード（「取り込み」の Portal を、その右に置くため）
  rootNodes: StoredRecord[]
  now?: number
}

export interface PlannedFile {
  id: string
  kind: 'markdown' | 'code'
  title: string
  content: string
  // 階層とゴミ箱の項目まで。パス・大きさ・ハッシュは、書き出したあとで import.ts が入れる
  record: StoredRecord
}

export interface PlannedAsset {
  hash: string
  mime: string
  data: Buffer
  width: number
  height: number
}

export interface ImportReport {
  canvases: number
  markdown: number
  code: number
  pdf: number
  nodes: number
  quotes: number
  images: number
  unplaced: number
  // 取り込まなかったもの
  skippedTrashed: number
  skippedLinks: number
  unsupported: Record<string, number>
  // 失われた書式など（テキストの太字・リンク、Portal の独自の名前）
  lostFormatting: number
  lostPortalLabels: number
  importCanvasId: string | null
}

export interface ImportPlan {
  records: StoredRecord[]
  files: PlannedFile[]
  assets: PlannedAsset[]
  thumbnails: { canvasId: string; png: Buffer }[]
  report: ImportReport
  // 旧の Canvas などの ID（すでに取り込んであるかを確かめるため）
  oldCanvasIds: string[]
}

// ---- 旧データの形（使う項目だけ） ----

interface OldDocument {
  id: string
  kind: 'canvas' | 'markdown' | 'code' | 'pdf'
  title: string
  createdAt: number
  updatedAt: number
  deletedAt?: number | null
}

interface OldAnchor {
  id: string
  sourceDocumentId: string
  locator: { pageIndex?: number; rects?: { x: number; y: number; w: number; h: number }[] }
  quote: string
  targetDocumentId: string
  createdAt: number
}

interface OldBinary {
  __ricBinary: true
  path: string
  type: string
  name?: string
}

interface OldRecord {
  id: string
  typeName: string
  type?: string
  parentId?: string
  index?: string
  x?: number
  y?: number
  rotation?: number
  isLocked?: boolean
  opacity?: number
  meta?: Record<string, unknown>
  props?: Record<string, unknown>
  fromId?: string
  toId?: string
}

interface KeyValue<T> {
  key: string
  value: T
}

interface OldDatabase<S> {
  name: string
  stores: S
}

type AppStores = {
  documents: KeyValue<OldDocument>[]
  contents: KeyValue<string>[]
  blobs: KeyValue<OldBinary>[]
  anchors: KeyValue<OldAnchor>[]
  previews: KeyValue<string>[]
}

type TldrawStores = {
  records: KeyValue<OldRecord>[]
  assets: KeyValue<OldBinary>[]
}

// ---- tldraw の値 → 新しい値 ----

// tldraw の色の名前 → 線・文字の色
const COLORS: Record<string, string> = {
  black: '#1d1d1d',
  grey: '#9fa8b2',
  'light-violet': '#e085f4',
  violet: '#ae3ec9',
  blue: '#4465e9',
  'light-blue': '#4ba1f1',
  yellow: '#f1ac4b',
  orange: '#e16919',
  green: '#099268',
  'light-green': '#4cb05e',
  'light-red': '#f87777',
  red: '#e03131',
  white: '#ffffff',
}
// 付箋の紙の色（tldraw の付箋は black が標準の黄色）
const NOTE_COLORS: Record<string, string> = {
  black: '#fff3bf',
  grey: '#e9ecef',
  'light-violet': '#f3d9fa',
  violet: '#e5dbff',
  blue: '#d0ebff',
  'light-blue': '#c5f6fa',
  yellow: '#ffec99',
  orange: '#ffd8a8',
  green: '#b2f2bb',
  'light-green': '#d3f9d8',
  'light-red': '#ffe3e3',
  red: '#ffc9c9',
  white: '#ffffff',
}
const STROKE_SIZES: Record<string, number> = { s: 2, m: 3.5, l: 5, xl: 10 }
const TEXT_SIZES: Record<string, number> = { s: 18, m: 24, l: 36, xl: 44 }
const NOTE_SIZES: Record<string, number> = { s: 18, m: 22, l: 26, xl: 32 }
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'])
const PORTAL_SIZE = { w: 240, h: 170 }
const QUOTE_WIDTH = 320
const GAP = 40

export async function convertBackup(zip: ZipReader, options: ImportOptions): Promise<ImportPlan> {
  const now = options.now ?? Date.now()
  const manifest = await zip.readJson<{ magic?: string; formatVersion?: number; appDatabasePath: string; tldrawDatabasePaths: string[] }>('manifest.json')
  if (manifest.magic !== 'recursive-infinite-canvas-backup' || manifest.formatVersion !== 1) {
    throw new Error('recursive-infinite-canvas の .ricbackup（形式 v1）ではありません')
  }
  const app = (await zip.readJson<OldDatabase<AppStores>>(manifest.appDatabasePath)).stores
  const docs = new Map(app.documents.map((e) => [e.value.id, e.value]))
  const live = (id: string) => {
    const doc = docs.get(id)
    return doc && !doc.deletedAt ? doc : undefined
  }
  const contents = new Map(app.contents.map((e) => [e.key, e.value]))
  const blobs = new Map(app.blobs.map((e) => [e.key, e.value]))

  const report: ImportReport = {
    canvases: 0,
    markdown: 0,
    code: 0,
    pdf: 0,
    nodes: 0,
    quotes: 0,
    images: 0,
    unplaced: 0,
    skippedTrashed: [...docs.values()].filter((d) => d.deletedAt).length,
    skippedLinks: 0,
    unsupported: {},
    lostFormatting: 0,
    lostPortalLabels: 0,
    importCanvasId: null,
  }
  const unsupported = (what: string) => (report.unsupported[what] = (report.unsupported[what] ?? 0) + 1)

  const canvases = new Map<string, StoredRecord>()
  const files = new Map<string, PlannedFile>()
  const nodes = new Map<string, StoredRecord>()
  const bindings: StoredRecord[] = []
  // PDF の File と SourceAnchor（どちらも木には入らない）
  const pdfFiles: StoredRecord[] = []
  const anchors: StoredRecord[] = []
  const assets = new Map<string, PlannedAsset>()
  const thumbnails: { canvasId: string; png: Buffer }[] = []
  const usedIds = new Set<string>()
  // 参照を持つノード（Portal とカード）。階層を決めるのに使う
  const references: { nodeId: string; canvasId: string; targetId: string; self: boolean }[] = []
  // PDF の File の id → ページのノード（pageIndex → ノード）
  const pdfPages = new Map<string, Map<number, StoredRecord>>()

  const makeCanvas = (id: string, title: string, createdAt = now, updatedAt = now): StoredRecord => ({
    typeName: 'canvas',
    id,
    title,
    parentCanvasId: null,
    ownerNodeId: null,
    createdAt,
    updatedAt,
    deletedAt: null,
    trash: null,
  })

  // 旧のルートを入れる Canvas
  let rootTarget = options.rootCanvasId
  if (!options.empty) {
    const date = new Date(now).toISOString().slice(0, 10)
    rootTarget = `canvas:${randomId()}`
    canvases.set(rootTarget, makeCanvas(rootTarget, `取り込み（${date}）`))
    report.importCanvasId = rootTarget
  }

  // Markdown / Code の File（本文は contents。なければ、カードが持っていた写し）
  const cardContent = new Map<string, string>()
  const ensureFile = (doc: OldDocument, content?: string): PlannedFile | undefined => {
    if (doc.kind !== 'markdown' && doc.kind !== 'code') return undefined
    const id = `file:${doc.id}`
    let file = files.get(id)
    if (!file) {
      file = {
        id,
        kind: doc.kind,
        title: doc.title || '無題',
        content: contents.get(doc.id) ?? content ?? cardContent.get(doc.id) ?? '',
        record: fileRecord(id, doc.kind, doc.title || '無題', doc.createdAt, doc.updatedAt),
      }
      files.set(id, file)
      if (doc.kind === 'markdown') report.markdown++
      else report.code++
    }
    return file
  }

  // ---- tldraw のデータベースを 1 つずつ変換する ----

  const markdownCanvases: { docId: string; canvasId: string }[] = []
  for (const path of manifest.tldrawDatabasePaths) {
    const db = await zip.readJson<OldDatabase<TldrawStores>>(path)
    const key = db.name.replace(/^TLDRAW_DOCUMENT_v2/, '')
    const records = db.stores.records.map((e) => e.value)
    const shapes = records.filter((r) => r.typeName === 'shape')
    // カードが持っている本文の写し（contents にないときに使う）
    for (const shape of shapes) {
      const documentId = shape.props?.documentId
      if ((shape.type === 'markdown-card' || shape.type === 'code-card') && typeof documentId === 'string' && typeof shape.props?.content === 'string') {
        if (!cardContent.has(documentId)) cardContent.set(documentId, shape.props.content)
      }
    }
    let canvasId: string
    let pdfDoc: OldDocument | undefined
    let selfDocId: string | null = null
    if (key === 'root-canvas') {
      canvasId = rootTarget
    } else if (key.startsWith('markdown-canvas:') || key.startsWith('code-canvas:')) {
      const docId = key.slice(key.indexOf(':') + 1)
      const doc = live(docId)
      if (!doc) continue
      ensureFile(doc)
      // 中身が自分のカードだけなら、Canvas にはしない
      const extra = shapes.filter((s) => s.props?.documentId !== docId)
      if (extra.length === 0) continue
      canvasId = `canvas:md-${docId}`
      canvases.set(canvasId, makeCanvas(canvasId, `${doc.title} のキャンバス`, doc.createdAt, doc.updatedAt))
      markdownCanvases.push({ docId, canvasId })
      selfDocId = docId
    } else {
      const doc = live(key)
      if (!doc || (doc.kind !== 'canvas' && doc.kind !== 'pdf')) continue
      canvasId = `canvas:${doc.id}`
      canvases.set(canvasId, makeCanvas(canvasId, doc.title, doc.createdAt, doc.updatedAt))
      if (doc.kind === 'pdf') pdfDoc = doc
    }

    // PDF：原本を Asset にして、File を作る
    let pdfFileId: string | null = null
    let pdfAssetId: string | null = null
    if (pdfDoc) {
      const blob = blobs.get(pdfDoc.id)
      if (!blob || !zip.has(blob.path)) {
        unsupported('原本のない PDF')
        canvases.delete(canvasId)
        continue
      }
      const data = await zip.read(blob.path)
      const hash = sha256(data)
      if (!assets.has(hash)) assets.set(hash, { hash, mime: 'application/pdf', data, width: 0, height: 0 })
      pdfAssetId = `asset:${hash}`
      pdfFileId = `file:${pdfDoc.id}`
      pdfPages.set(pdfFileId, new Map())
      report.pdf++
    }

    // 旧のシェイプの ID → 新しいノードの ID（Canvas をまたいで同じ ID があれば、Canvas の ID を付ける）
    const idMap = new Map<string, string>()
    const prefix = key === 'root-canvas' ? 'root' : key.replace(/^.*:/, '').slice(0, 8)
    for (const shape of shapes) {
      const suffix = shape.id.replace(/^shape:/, '')
      let id = `node:${suffix}`
      if (usedIds.has(id)) id = `node:${prefix}-${suffix}`
      for (let n = 2; usedIds.has(id); n++) id = `node:${prefix}-${suffix}-${n}`
      usedIds.add(id)
      idMap.set(shape.id, id)
    }
    const assetRecords = new Map(records.filter((r) => r.typeName === 'asset').map((r) => [r.id, r]))
    const binaryAssets = new Map(db.stores.assets.map((e) => [e.key, e.value]))

    for (const shape of shapes) {
      const id = idMap.get(shape.id)!
      const parentId = shape.parentId?.startsWith('page:') ? canvasId : idMap.get(shape.parentId ?? '')
      if (!parentId) continue
      const props = shape.props ?? {}
      const base = {
        typeName: 'node',
        id,
        parentId,
        x: num(shape.x),
        y: num(shape.y),
        rotation: num(shape.rotation),
        index: typeof shape.index === 'string' && validIndex(shape.index) ? shape.index : 'a0',
        opacity: typeof shape.opacity === 'number' ? shape.opacity : 1,
        locked: shape.isLocked === true,
        meta: {},
      }
      const scale = typeof props.scale === 'number' ? props.scale : 1
      const put = (type: string, nodeProps: Record<string, unknown>, extra: Partial<typeof base> = {}) => {
        const node = { ...base, ...extra, type, props: nodeProps }
        nodes.set(id, node)
        report.nodes++
        return node
      }
      switch (shape.type) {
        case 'image': {
          const page = typeof shape.meta?.pdfPage === 'number' ? shape.meta.pdfPage : null
          if (page !== null && pdfFileId && pdfAssetId) {
            const node = put(
              'pdf-page',
              { assetId: pdfAssetId, fileId: pdfFileId, pageIndex: page - 1, w: num(props.w), h: num(props.h) },
              { locked: true },
            )
            pdfPages.get(pdfFileId)!.set(page - 1, node)
            break
          }
          const asset = assetRecords.get(String(props.assetId))
          const planned = asset ? await imageAsset(zip, asset, binaryAssets) : null
          if (!planned) {
            unsupported(asset?.props?.mimeType === 'image/svg+xml' ? 'SVG の画像' : '読めない画像')
            break
          }
          if (!assets.has(planned.hash)) assets.set(planned.hash, planned)
          put('image', { assetId: `asset:${planned.hash}`, w: num(props.w), h: num(props.h), crop: convertCrop(props.crop) })
          report.images++
          break
        }
        case 'draw': {
          const points = decodeDrawSegments(props.segments, num(props.scaleX, 1), num(props.scaleY, 1))
          if (points.length < 2) break
          put('draw', { points, color: color(props.color), size: (STROKE_SIZES[String(props.size)] ?? 3.5) * scale, isComplete: true })
          break
        }
        case 'line': {
          const handles = Object.values((props.points ?? {}) as Record<string, { index: string; x: number; y: number }>).sort((a, b) =>
            a.index < b.index ? -1 : 1,
          )
          const points = handles.flatMap((p) => [p.x, p.y])
          if (points.length < 4) break
          put('draw', { points, color: color(props.color), size: (STROKE_SIZES[String(props.size)] ?? 3.5) * scale, isComplete: true })
          break
        }
        case 'text': {
          const { text, formatted } = plainText(props.richText)
          if (formatted) report.lostFormatting++
          const align = props.textAlign === 'middle' ? 'center' : props.textAlign === 'end' ? 'right' : 'left'
          put('text', {
            text,
            fontSize: (TEXT_SIZES[String(props.size)] ?? 24) * scale,
            color: color(props.color),
            align,
            w: num(props.w, 200) * scale,
            autoWidth: props.autoSize !== false,
          })
          break
        }
        case 'note': {
          const { text, formatted } = plainText(props.richText)
          if (formatted) report.lostFormatting++
          const w = typeof shape.meta?.noteWidth === 'number' ? shape.meta.noteWidth : 200 * scale
          const h = typeof shape.meta?.noteHeight === 'number' ? shape.meta.noteHeight : (200 + num(props.growY)) * scale
          put('note', { text, w, h, color: NOTE_COLORS[String(props.color)] ?? NOTE_COLORS.black, fontSize: (NOTE_SIZES[String(props.size)] ?? 18) * scale * num(props.fontSizeAdjustment, 1) })
          break
        }
        case 'bookmark': {
          // 付箋にする（名前と URL）
          const asset = assetRecords.get(String(props.assetId))
          const url = String(props.url ?? asset?.props?.src ?? '')
          const title = String(asset?.props?.title ?? '')
          put('note', { text: title && title !== url ? `${title}\n${url}` : url, w: num(props.w, 300), h: Math.min(num(props.h, 200), 200), color: NOTE_COLORS.grey, fontSize: 16 })
          break
        }
        case 'arrow': {
          const { text } = plainText(props.richText)
          const head = (value: unknown) => (value === 'none' || value === undefined ? 'none' : 'arrow')
          put('arrow', {
            start: vec(props.start),
            end: vec(props.end),
            bend: num(props.bend),
            clip: [0, 1],
            color: color(props.color),
            size: (STROKE_SIZES[String(props.size)] ?? 3.5) * scale,
            arrowheadStart: head(props.arrowheadStart),
            arrowheadEnd: head(props.arrowheadEnd ?? 'arrow'),
            label: text,
          })
          break
        }
        case 'group':
          put('group', {})
          break
        case 'frame':
          put('frame', { w: num(props.w, 320), h: num(props.h, 240), name: String(props.name ?? 'フレーム') })
          break
        case 'portal': {
          const targetDocId = String(props.targetDocumentId ?? '')
          const target = live(targetDocId)
          if (!target) {
            report.skippedLinks++
            break
          }
          if (typeof props.label === 'string' && props.label && props.label !== target.title) report.lostPortalLabels++
          if (target.kind === 'markdown' || target.kind === 'code') {
            // Markdown / Code を指す Portal は、その File のカードにする（大きさはそのまま、高さを固定）
            ensureFile(target)
            put(target.kind === 'markdown' ? 'markdown-card' : 'code-card', { fileId: `file:${target.id}`, w: Math.max(num(props.w, 320), 200), h: num(props.h, 160), sizing: 'fixed', role: 'shortcut' })
            references.push({ nodeId: id, canvasId, targetId: `file:${target.id}`, self: false })
          } else {
            put('portal', { targetId: `canvas:${target.id}`, role: 'shortcut', w: num(props.w, PORTAL_SIZE.w), h: num(props.h, PORTAL_SIZE.h) })
            references.push({ nodeId: id, canvasId, targetId: `canvas:${target.id}`, self: false })
          }
          break
        }
        case 'markdown-card':
        case 'code-card': {
          const kind = shape.type === 'markdown-card' ? 'markdown' : 'code'
          const documentId = typeof props.documentId === 'string' ? props.documentId : null
          let fileId: string
          if (documentId) {
            const doc = live(documentId)
            if (!doc) {
              report.skippedLinks++
              break
            }
            fileId = ensureFile(doc, typeof props.content === 'string' ? props.content : undefined)!.id
          } else {
            // 本文だけを持っていたカードは、その本文から新しい File を作る（MAI-7）
            fileId = `file:${id.slice('node:'.length)}`
            const title = String(props.title ?? '') || '無題'
            files.set(fileId, { id: fileId, kind, title, content: String(props.content ?? ''), record: fileRecord(fileId, kind, title, now, now) })
            if (kind === 'markdown') report.markdown++
            else report.code++
          }
          put(shape.type, { fileId, w: num(props.w, 560), h: num(props.h, 320), sizing: 'fixed', role: 'shortcut' })
          references.push({ nodeId: id, canvasId, targetId: fileId, self: documentId !== null && documentId === selfDocId })
          break
        }
        default:
          unsupported(`シェイプ（${shape.type}）`)
      }
    }

    // 矢印のつながり（両端のノードがあるものだけ）
    for (const record of records) {
      if (record.typeName !== 'binding' || record.type !== 'arrow') continue
      const fromId = idMap.get(record.fromId ?? '')
      const toId = idMap.get(record.toId ?? '')
      if (!fromId || !toId || !nodes.has(fromId) || !nodes.has(toId)) continue
      const props = record.props ?? {}
      const suffix = record.id.replace(/^binding:/, '')
      let bindingId = `binding:${suffix}`
      for (let n = 2; usedIds.has(bindingId); n++) bindingId = `binding:${prefix}-${suffix}${n > 2 ? `-${n}` : ''}`
      usedIds.add(bindingId)
      bindings.push({
        typeName: 'binding',
        id: bindingId,
        type: 'arrow',
        fromId,
        toId,
        props: { terminal: props.terminal === 'start' ? 'start' : 'end', normalizedAnchor: vec(props.normalizedAnchor, { x: 0.5, y: 0.5 }), isPrecise: props.isPrecise === true },
      })
    }

    // PDF の File（ページの Canvas を持つ。File 自体は木に入れない。MAI-32）
    if (pdfDoc && pdfFileId && pdfAssetId) {
      const pages = pdfPages.get(pdfFileId)!
      const hash = pdfAssetId.slice('asset:'.length)
      pdfFiles.push({
        ...fileRecord(pdfFileId, 'pdf', pdfDoc.title, pdfDoc.createdAt, pdfDoc.updatedAt),
        path: '',
        size: assets.get(hash)!.data.length,
        mtime: pdfDoc.updatedAt,
        hash,
        missing: false,
        assetId: pdfAssetId,
        pagesCanvasId: canvasId,
        pageCount: pages.size ? Math.max(...pages.keys()) + 1 : 0,
      })
    }
  }

  // 置かれていない Markdown / Code（カードも Portal もない）も File にする（未配置になる）
  for (const doc of docs.values()) if (!doc.deletedAt) ensureFile(doc)

  // ---- 階層：旧のルートから Portal とカードをたどり、最初に見つかったものを持ち主にする（MAI-8） ----

  const owned = new Set<string>()
  const byCanvas = new Map<string, typeof references>()
  for (const ref of references) byCanvas.set(ref.canvasId, [...(byCanvas.get(ref.canvasId) ?? []), ref])
  const targetRecord = (id: string) => (id.startsWith('file:') ? files.get(id)?.record : canvases.get(id))
  const walk = (start: string) => {
    const queue = [start]
    owned.add(start)
    while (queue.length > 0) {
      const canvasId = queue.shift()!
      const refs = (byCanvas.get(canvasId) ?? []).slice().sort((a, b) => (index(nodes.get(a.nodeId)) < index(nodes.get(b.nodeId)) ? -1 : 1))
      for (const ref of refs) {
        const target = targetRecord(ref.targetId)
        if (!target || owned.has(ref.targetId) || ref.self) continue
        owned.add(ref.targetId)
        target.parentCanvasId = canvasId
        target.ownerNodeId = ref.nodeId
        const node = nodes.get(ref.nodeId)!
        node.props = { ...(node.props as object), role: 'owner' }
        if (ref.targetId.startsWith('canvas:')) queue.push(ref.targetId)
      }
    }
  }
  walk(rootTarget)
  // たどれなかった Canvas（未配置）の中も、同じように持ち主を決める（その Canvas 自身は未配置のまま）。
  // Markdown / Code 用の Canvas は、あとで File の持ち主の隣に置くので、ここでは扱わない
  const markdownCanvasIds = new Set(markdownCanvases.map((m) => m.canvasId))
  for (const id of canvases.keys()) if (!owned.has(id) && !markdownCanvasIds.has(id)) walk(id)

  // 中身のある Markdown / Code 用の Canvas：その持ち主の Portal を、File の持ち主のカードの隣に置く（MAI-13）
  for (const { docId, canvasId } of markdownCanvases) {
    const file = files.get(`file:${docId}`)
    const cardId = file?.record.ownerNodeId as string | null | undefined
    const card = cardId ? nodes.get(cardId) : undefined
    if (card) {
      const portalId = uniqueNodeId(usedIds, `portal-${docId}`)
      const cardW = num((card.props as { w?: number }).w, 320)
      nodes.set(portalId, {
        typeName: 'node',
        id: portalId,
        type: 'portal',
        parentId: card.parentId,
        x: num(card.x) + cardW + GAP,
        y: num(card.y),
        rotation: 0,
        index: nextIndex(card.index as string),
        opacity: 1,
        locked: false,
        props: { targetId: canvasId, role: 'owner', ...PORTAL_SIZE },
        meta: {},
      })
      report.nodes++
      const canvas = canvases.get(canvasId)!
      canvas.parentCanvasId = file!.record.parentCanvasId
      canvas.ownerNodeId = portalId
      owned.add(canvasId)
    }
    walk(canvasId)
  }

  // ---- 旧の引用 → 引用ノート ----

  const quotesBeside = new Map<string, number>()
  for (const { value: anchor } of app.anchors) {
    const source = live(anchor.sourceDocumentId)
    const target = live(anchor.targetDocumentId)
    const pdfFileId = `file:${anchor.sourceDocumentId}`
    if (!source || source.kind !== 'pdf' || !target || !pdfPages.has(pdfFileId)) {
      report.skippedLinks++
      continue
    }
    const pageIndex = anchor.locator.pageIndex ?? 0
    const rects = anchor.locator.rects ?? []
    // 矩形がなければページ全体。複数あれば、全体を囲む矩形
    const rect = rects.length === 1 ? { ...rects[0] } : rects.length > 1 ? unionRects(rects) : { x: 0, y: 0, w: 1, h: 1 }
    const anchorId = `anchor:${anchor.id}`
    // 書き込み先の Markdown のカードの横。なければ、PDF のページの横
    const card = (() => {
      const ownerId = files.get(`file:${target.id}`)?.record.ownerNodeId as string | null | undefined
      return ownerId ? nodes.get(ownerId) : undefined
    })()
    const page = pdfPages.get(pdfFileId)?.get(pageIndex)
    const beside = card ?? page
    if (!beside) {
      report.skippedLinks++
      continue
    }
    const bw = num((beside.props as { w?: number }).w, 320)
    const bh = num((beside.props as { h?: number }).h, 0)
    const stacked = quotesBeside.get(beside.id) ?? 0
    const y = card ? num(beside.y) + stacked : num(beside.y) + rect.y * bh + stacked
    quotesBeside.set(beside.id, stacked + estimateQuoteHeight(anchor.quote) + 16)
    const noteId = uniqueNodeId(usedIds, `quote-${anchor.id}`)
    nodes.set(noteId, {
      typeName: 'node',
      id: noteId,
      type: 'quote-card',
      parentId: beside.parentId,
      x: num(beside.x) + bw + GAP,
      y,
      rotation: 0,
      index: nextIndex(beside.index as string),
      opacity: 1,
      locked: false,
      props: { anchorId, fileId: pdfFileId, quote: anchor.quote, figure: null, memo: '', w: QUOTE_WIDTH },
      meta: {},
    })
    report.nodes++
    report.quotes++
    // 形は packages/core の SourceAnchorRecord と同じ
    anchors.push({
      typeName: 'anchor',
      id: anchorId,
      fileId: pdfFileId,
      locator: { kind: 'pdf', pageIndex, rect },
      quote: anchor.quote,
      createdAt: anchor.createdAt ?? now,
    })
  }

  // ---- サムネイル（旧の previews） ----

  for (const { key, value } of app.previews) {
    const docId = key.replace(/:v\d+$/, '')
    const canvasId = `canvas:${docId}`
    const match = /^data:image\/png;base64,(.+)$/.exec(value)
    if (match && canvases.has(canvasId)) thumbnails.push({ canvasId, png: Buffer.from(match[1], 'base64') })
  }

  // 「取り込み」の Canvas は、ルートの既存のノードの右に Portal を置く
  if (report.importCanvasId) {
    const right = options.rootNodes.reduce((max, n) => Math.max(max, num(n.x) + num((n.props as { w?: number })?.w, 200)), 0)
    const portalId = uniqueNodeId(usedIds, `import-${Date.now()}`)
    nodes.set(portalId, {
      typeName: 'node',
      id: portalId,
      type: 'portal',
      parentId: options.rootCanvasId,
      x: right + 200,
      y: 0,
      rotation: 0,
      index: 'zz',
      opacity: 1,
      locked: false,
      props: { targetId: report.importCanvasId, role: 'owner', ...PORTAL_SIZE },
      meta: {},
    })
    const canvas = canvases.get(report.importCanvasId)!
    canvas.parentCanvasId = options.rootCanvasId
    canvas.ownerNodeId = portalId
  }

  // PDF のページの Canvas と「取り込み」の Canvas は数えない
  const pagesCanvases = new Set(pdfFiles.map((f) => f.pagesCanvasId))
  report.canvases = [...canvases.keys()].filter((id) => !pagesCanvases.has(id) && id !== report.importCanvasId).length
  report.unplaced =
    [...canvases.values()].filter((c) => c.ownerNodeId === null && c.id !== rootTarget).length +
    [...files.values()].filter((f) => f.record.ownerNodeId === null).length

  return {
    records: [...canvases.values(), ...pdfFiles, ...nodes.values(), ...bindings, ...anchors],
    files: [...files.values()],
    assets: [...assets.values()],
    thumbnails,
    report,
    oldCanvasIds: [...canvases.keys()].filter((id) => id !== options.rootCanvasId && id !== report.importCanvasId),
  }
}

// ---- 小さな道具 ----

function fileRecord(id: string, kind: string, title: string, createdAt: number, updatedAt: number): StoredRecord {
  return { typeName: 'file', id, kind, title, parentCanvasId: null, ownerNodeId: null, createdAt, updatedAt, deletedAt: null, trash: null }
}

async function imageAsset(zip: ZipReader, asset: OldRecord, binaries: Map<string, OldBinary>): Promise<PlannedAsset | null> {
  const props = asset.props ?? {}
  const mime = String(props.mimeType ?? '')
  if (!IMAGE_TYPES.has(mime)) return null
  let data: Buffer | null = null
  const src = String(props.src ?? '')
  const dataUrl = /^data:[^;,]+;base64,(.+)$/.exec(src)
  if (dataUrl) data = Buffer.from(dataUrl[1], 'base64')
  else {
    const binary = binaries.get(asset.id) ?? binaries.get(src)
    if (binary && zip.has(binary.path)) data = await zip.read(binary.path)
  }
  if (!data || data.length === 0) return null
  const ratio = typeof props.pixelRatio === 'number' ? props.pixelRatio : 1
  return { hash: sha256(data), mime, data, width: Math.round(num(props.w) * ratio), height: Math.round(num(props.h) * ratio) }
}

// tldraw のフリーハンドの点列：最初の点は float32 の (x, y)、続く点は前の点からの差を float16 で持つ（dim は 2）
export function decodeDrawSegments(segments: unknown, scaleX = 1, scaleY = 1): number[] {
  const out: number[] = []
  if (!Array.isArray(segments)) return out
  for (const segment of segments as { path?: string; points?: { x: number; y: number }[]; dim?: number }[]) {
    if (Array.isArray(segment.points)) {
      for (const p of segment.points) out.push(p.x * scaleX, p.y * scaleY)
      continue
    }
    if (typeof segment.path !== 'string') continue
    const bytes = Buffer.from(segment.path, 'base64')
    const dim = segment.dim === 3 ? 3 : 2
    if (bytes.length < 4 * dim) continue
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let x = view.getFloat32(0, true)
    let y = view.getFloat32(4, true)
    out.push(x * scaleX, y * scaleY)
    for (let i = 4 * dim; i + 2 * dim <= bytes.length; i += 2 * dim) {
      x += float16(view.getUint16(i, true))
      y += float16(view.getUint16(i + 2, true))
      out.push(x * scaleX, y * scaleY)
    }
  }
  // 同じ点の重なり（区切りの点）を除く
  const cleaned: number[] = []
  for (let i = 0; i < out.length; i += 2) {
    if (cleaned.length >= 2 && cleaned[cleaned.length - 2] === out[i] && cleaned[cleaned.length - 1] === out[i + 1]) continue
    cleaned.push(out[i], out[i + 1])
  }
  return cleaned
}

function float16(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1
  const exponent = (bits >> 10) & 0x1f
  const fraction = bits & 0x3ff
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024)
  if (exponent === 0x1f) return fraction ? NaN : sign * Infinity
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024)
}

// tldraw のリッチテキスト（ProseMirror の JSON）をプレーンテキストにする。太字・リンクなどがあれば formatted
export function plainText(rich: unknown): { text: string; formatted: boolean } {
  let formatted = false
  const blocks: string[] = []
  const inline = (node: { type?: string; text?: string; marks?: unknown[]; content?: unknown[] }): string => {
    if (node.type === 'text') {
      if (Array.isArray(node.marks) && node.marks.length > 0) formatted = true
      return node.text ?? ''
    }
    if (node.type === 'hardBreak') return '\n'
    return (node.content ?? []).map((c) => inline(c as typeof node)).join('')
  }
  const block = (node: { type?: string; content?: unknown[] }, prefix = '') => {
    if (node.type === 'bulletList' || node.type === 'orderedList') {
      formatted = true
      for (const [i, item] of (node.content ?? []).entries()) block(item as typeof node, node.type === 'bulletList' ? '・' : `${i + 1}. `)
      return
    }
    if (node.type === 'listItem') {
      for (const [i, child] of (node.content ?? []).entries()) block(child as typeof node, i === 0 ? prefix : '')
      return
    }
    if (node.type === 'doc') {
      for (const child of node.content ?? []) block(child as typeof node)
      return
    }
    blocks.push(prefix + inline(node))
  }
  if (rich && typeof rich === 'object') block(rich as { type?: string })
  else if (typeof rich === 'string') blocks.push(rich)
  return { text: blocks.join('\n').replace(/\s+$/, ''), formatted }
}

function convertCrop(crop: unknown): { x: number; y: number; w: number; h: number } | null {
  const c = crop as { topLeft?: { x: number; y: number }; bottomRight?: { x: number; y: number } } | null
  if (!c?.topLeft || !c.bottomRight) return null
  const w = c.bottomRight.x - c.topLeft.x
  const h = c.bottomRight.y - c.topLeft.y
  if (w <= 0 || h <= 0 || (w === 1 && h === 1 && c.topLeft.x === 0 && c.topLeft.y === 0)) return null
  return { x: c.topLeft.x, y: c.topLeft.y, w, h }
}

function unionRects(rects: { x: number; y: number; w: number; h: number }[]) {
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.w))
  const bottom = Math.max(...rects.map((r) => r.y + r.h))
  return { x, y, w: right - x, h: bottom - y }
}

// 引用ノートの高さの見積もり（重ねずに並べるため。正確な高さは画面で決まる）
function estimateQuoteHeight(quote: string): number {
  const lines = Math.min(12, Math.ceil([...quote].length / 20) + 1)
  return 30 + lines * 22 + 10 + 40
}

function color(name: unknown): string {
  return COLORS[String(name)] ?? COLORS.black
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function vec(value: unknown, fallback = { x: 0, y: 0 }): { x: number; y: number } {
  const v = value as { x?: unknown; y?: unknown } | null
  return v && typeof v.x === 'number' && typeof v.y === 'number' ? { x: v.x, y: v.y } : fallback
}

function index(node: StoredRecord | undefined): string {
  return typeof node?.index === 'string' ? node.index : ''
}

// 重なり順：その直後（同じ親の中で、ほぼ同じ位置）
function nextIndex(after: string | undefined): string {
  return `${after && validIndex(after) ? after : 'a0'}V`
}

const INDEX_DIGITS = /^[0-9A-Za-z]+$/
function validIndex(key: string): boolean {
  if (!INDEX_DIGITS.test(key) || key.endsWith('0')) return false
  const head = key[0]
  const length = head >= 'a' && head <= 'z' ? head.charCodeAt(0) - 95 : head >= 'A' && head <= 'Z' ? 92 - head.charCodeAt(0) : -1
  return length > 0 && key.length >= length
}

function uniqueNodeId(used: Set<string>, base: string): string {
  let id = `node:${base}`
  for (let n = 2; used.has(id); n++) id = `node:${base}-${n}`
  used.add(id)
  return id
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function randomId(): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  return [...randomBytes(16)].map((b) => alphabet[b % 62]).join('')
}
