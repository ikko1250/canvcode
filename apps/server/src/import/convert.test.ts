import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import type { StoredRecord } from '../records.ts'
import { convertBackup, decodeDrawSegments, plainText } from './convert.ts'
import { ZipReader } from './zip.ts'

// 旧データの変換（MAI-36）。小さな .ricbackup をその場で作って確かめる（実物は個人のデータなので使わない）

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// 最小限の ZIP を書く（deflate と無圧縮を混ぜる）
function writeZip(entries: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-zip-'))
  dirs.push(dir)
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [i, [name, content]] of Object.entries(entries).entries()) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const method = i % 2 === 0 ? 8 : 0
    const data = method === 8 ? deflateRawSync(raw) : raw
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(0x800, 8)
    header.writeUInt16LE(method, 10)
    header.writeUInt32LE(data.length, 20)
    header.writeUInt32LE(raw.length, 24)
    header.writeUInt16LE(nameBuf.length, 28)
    header.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, data)
    central.push(header, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const dirBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(dirBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  const path = join(dir, 'test.ricbackup')
  writeFileSync(path, Buffer.concat([...locals, dirBuf, end]))
  return path
}

const rich = (text: string, marks = false) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text, ...(marks ? { marks: [{ type: 'bold' }] } : {}) }] }],
})
const shape = (id: string, type: string, props: object, extra: object = {}) => ({
  key: `shape:${id}`,
  value: { typeName: 'shape', id: `shape:${id}`, type, parentId: 'page:page', index: 'a1', x: 10, y: 20, rotation: 0, isLocked: false, opacity: 1, meta: {}, props, ...extra },
})
const tldraw = (key: string, records: object[], assets: object[] = []) => JSON.stringify({ name: `TLDRAW_DOCUMENT_v2${key}`, stores: { records, assets } })
const doc = (id: string, kind: string, title: string, deleted = false) => ({ key: id, value: { id, kind, title, createdAt: 1, updatedAt: 2, ...(deleted ? { deletedAt: 3 } : {}) } })

function backup(): string {
  const app = {
    name: 'ric',
    version: 7,
    stores: {
      documents: [
        doc('child', 'canvas', '子'),
        doc('trashed', 'canvas', '捨てた', true),
        doc('memo', 'markdown', 'メモ'),
        doc('paper', 'pdf', '論文'),
        doc('loose', 'markdown', 'どこにもない'),
      ],
      contents: [
        { key: 'memo', value: '# メモ\n\n> 引用した文\n' },
        { key: 'loose', value: '置かれていない' },
      ],
      blobs: [{ key: 'paper', value: { __ricBinary: true, path: 'app/binary/blobs/paper.bin', type: 'application/pdf' } }],
      anchors: [
        {
          key: 'q1',
          value: { id: 'q1', sourceDocumentId: 'paper', locator: { pageIndex: 1, rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.1 }] }, quote: '引用した文', targetDocumentId: 'memo', createdAt: 5 },
        },
      ],
      previews: [{ key: 'child:v2', value: `data:image/png;base64,${Buffer.from('png').toString('base64')}` }],
      conversations: [],
    },
  }
  const pageImage = (n: number) =>
    shape(`pdf-page-${n}`, 'image', { w: 600, h: 800, assetId: `asset:pdf-page-${n}` }, { meta: { pdfPage: n }, y: (n - 1) * 840 })
  return writeZip({
    'manifest.json': JSON.stringify({
      magic: 'recursive-infinite-canvas-backup',
      formatVersion: 1,
      appDatabasePath: 'app/database.json',
      tldrawDatabasePaths: ['tldraw/0/database.json', 'tldraw/1/database.json', 'tldraw/2/database.json', 'tldraw/3/database.json', 'tldraw/4/database.json'],
    }),
    'app/database.json': JSON.stringify(app),
    'app/binary/blobs/paper.bin': Buffer.from('%PDF-1.4 fake'),
    'tldraw/0/database.json': tldraw('root-canvas', [
      shape('p1', 'portal', { w: 320, h: 160, label: '独自の名前', targetDocumentId: 'child', targetKind: 'canvas' }),
      shape('p2', 'portal', { w: 320, h: 160, targetDocumentId: 'child', targetKind: 'canvas' }, { index: 'a2' }),
      shape('p3', 'portal', { w: 320, h: 160, targetDocumentId: 'trashed', targetKind: 'canvas' }),
      shape('p4', 'portal', { w: 320, h: 160, targetDocumentId: 'paper', targetKind: 'pdf' }, { index: 'a3' }),
      shape('n1', 'note', { color: 'black', size: 's', richText: rich('付箋', true), scale: 1 }, { meta: { noteWidth: 300, noteHeight: 150 } }),
    ]),
    'tldraw/1/database.json': tldraw('child', [
      shape('md', 'portal', { w: 320, h: 160, targetDocumentId: 'memo', targetKind: 'markdown' }),
      shape('t1', 'text', { richText: rich('テキスト'), size: 'm', color: 'red', w: 100, autoSize: true, textAlign: 'middle', scale: 1 }),
      shape('card', 'markdown-card', { w: 400, h: 300, title: '本文だけ', content: '# 本文だけのカード' }),
      shape('bm', 'bookmark', { url: 'https://example.com', w: 300, h: 320, assetId: 'asset:b' }),
      { key: 'asset:b', value: { typeName: 'asset', id: 'asset:b', type: 'bookmark', props: { src: 'https://example.com', title: '例' } } },
      shape('odd', 'highlight', {}),
    ]),
    'tldraw/2/database.json': tldraw('paper', [pageImage(1), pageImage(2), shape('pdf-page-2-draw', 'draw', { segments: [], color: 'red', size: 'm' })]),
    'tldraw/3/database.json': tldraw('trashed', [shape('x', 'text', { richText: rich('捨てた') })]),
    // 別の Canvas にも同じ ID（shape:pdf-page-1）がある
    'tldraw/4/database.json': tldraw('markdown-canvas:memo', [
      shape('self', 'markdown-card', { w: 400, h: 300, documentId: 'memo', content: '' }),
      shape('pdf-page-1', 'note', { color: 'yellow', size: 'm', richText: rich('メモのキャンバスの付箋') }),
    ]),
  })
}

async function convert(options: { empty?: boolean } = {}) {
  const zip = await ZipReader.open(backup())
  try {
    return await convertBackup(zip, { rootCanvasId: 'canvas:root', empty: options.empty ?? true, rootNodes: [], now: 100 })
  } finally {
    await zip.close()
  }
}

const find = (records: StoredRecord[], id: string) => records.find((r) => r.id === id)!
const props = (record: StoredRecord) => record.props as Record<string, unknown>

describe('converting a .ricbackup', () => {
  it('builds the tree from the old root, making the first portal the owner', async () => {
    const { records } = await convert()
    const child = find(records, 'canvas:child')
    expect(child).toMatchObject({ title: '子', parentCanvasId: 'canvas:root', ownerNodeId: 'node:p1' })
    expect(props(find(records, 'node:p1')).role).toBe('owner')
    expect(props(find(records, 'node:p2')).role).toBe('shortcut')
    expect(find(records, 'node:p1').parentId).toBe('canvas:root')
  })

  it('skips documents in the trash and the portals to them', async () => {
    const { records, report } = await convert()
    expect(records.some((r) => r.id === 'canvas:trashed' || r.id === 'node:p3' || r.id === 'node:x')).toBe(false)
    expect(report.skippedTrashed).toBe(1)
    expect(report.skippedLinks).toBeGreaterThanOrEqual(1)
  })

  it('turns a portal to a Markdown document into the owner card of its file', async () => {
    const { records, files } = await convert()
    expect(find(records, 'node:md')).toMatchObject({ type: 'markdown-card', props: { fileId: 'file:memo', sizing: 'fixed', role: 'owner' } })
    const memo = files.find((f) => f.id === 'file:memo')!
    expect(memo.content).toBe('# メモ\n\n> 引用した文\n')
    expect(memo.record).toMatchObject({ parentCanvasId: 'canvas:child', ownerNodeId: 'node:md' })
    // 本文だけを持っていたカードからも File を作る。置かれていない文書は未配置
    expect(files.find((f) => f.title === '本文だけ')?.content).toBe('# 本文だけのカード')
    expect(files.find((f) => f.id === 'file:loose')?.record.ownerNodeId).toBeNull()
  })

  it('makes a PDF file with a locked page canvas, keeping the annotations', async () => {
    const { records, assets } = await convert()
    const file = find(records, 'file:paper')
    expect(file).toMatchObject({ kind: 'pdf', pagesCanvasId: 'canvas:paper', pageCount: 2 })
    expect(assets.some((a) => a.mime === 'application/pdf' && `asset:${a.hash}` === file.assetId)).toBe(true)
    const pages = records.filter((r) => r.type === 'pdf-page')
    expect(pages.map((p) => [props(p).pageIndex, p.locked, p.parentId])).toEqual([
      [0, true, 'canvas:paper'],
      [1, true, 'canvas:paper'],
    ])
    expect(find(records, 'canvas:paper')).toMatchObject({ parentCanvasId: 'canvas:root', ownerNodeId: 'node:p4' })
  })

  it('turns an old quote into a quote note beside the Markdown card', async () => {
    const { records, report } = await convert()
    const anchor = find(records, 'anchor:q1')
    expect(anchor).toMatchObject({ fileId: 'file:paper', locator: { kind: 'pdf', pageIndex: 1, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } }, quote: '引用した文' })
    const note = records.find((r) => r.type === 'quote-card')!
    expect(note).toMatchObject({ parentId: 'canvas:child', props: { anchorId: 'anchor:q1', fileId: 'file:paper' } })
    expect(Number(note.x)).toBeGreaterThan(10 + 320)
    expect(report.quotes).toBe(1)
  })

  it('makes a canvas for a Markdown document with extra content, next to its owner card', async () => {
    const { records } = await convert()
    const canvas = find(records, 'canvas:md-memo')
    expect(canvas).toMatchObject({ title: 'メモ のキャンバス', parentCanvasId: 'canvas:child' })
    const portal = find(records, canvas.ownerNodeId as string)
    expect(portal).toMatchObject({ type: 'portal', parentId: 'canvas:child', props: { targetId: 'canvas:md-memo', role: 'owner' } })
    // 自分のカードはショートカットのまま。同じ ID（shape:pdf-page-1）は、Canvas の ID を付けて分ける
    expect(records.filter((r) => r.parentId === 'canvas:md-memo').map((r) => [r.type, props(r).role ?? null])).toEqual([
      ['markdown-card', 'shortcut'],
      ['note', null],
    ])
    const ids = records.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('converts text, notes and bookmarks, and reports what was lost', async () => {
    const { records, report, thumbnails } = await convert()
    expect(find(records, 'node:t1')).toMatchObject({ type: 'text', props: { text: 'テキスト', fontSize: 24, align: 'center', color: '#e03131' } })
    expect(find(records, 'node:n1')).toMatchObject({ type: 'note', props: { text: '付箋', w: 300, h: 150 } })
    expect(props(find(records, 'node:bm')).text).toBe('例\nhttps://example.com')
    expect(report.lostFormatting).toBe(1)
    expect(report.lostPortalLabels).toBe(1)
    expect(report.unsupported).toEqual({ 'シェイプ（highlight）': 1 })
    expect(thumbnails.map((t) => t.canvasId)).toEqual(['canvas:child'])
  })

  it('puts the old root into a new canvas when the workspace is not empty', async () => {
    const { records, report } = await convert({ empty: false })
    const importCanvas = find(records, report.importCanvasId!)
    expect(importCanvas).toMatchObject({ parentCanvasId: 'canvas:root' })
    expect(find(records, 'node:p1').parentId).toBe(importCanvas.id)
    expect(find(records, importCanvas.ownerNodeId as string)).toMatchObject({ type: 'portal', parentId: 'canvas:root' })
  })
})

describe('old shape data', () => {
  it('decodes freehand points (float32 start, float16 deltas)', () => {
    const bytes = Buffer.alloc(12)
    bytes.writeFloatLE(10, 0)
    bytes.writeFloatLE(20, 4)
    // 1.0 と -2.0 の float16
    bytes.writeUInt16LE(0x3c00, 8)
    bytes.writeUInt16LE(0xc000, 10)
    expect(decodeDrawSegments([{ type: 'free', path: bytes.toString('base64'), dim: 2 }])).toEqual([10, 20, 11, 18])
  })

  it('flattens rich text, keeping lines and list items', () => {
    const text = plainText({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '一行目' }, { type: 'hardBreak' }, { type: 'text', text: '続き' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '項目' }] }] }] },
      ],
    })
    expect(text).toEqual({ text: '一行目\n続き\n・項目', formatted: true })
  })
})
