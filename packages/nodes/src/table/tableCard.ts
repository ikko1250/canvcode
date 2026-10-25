import type { NodeRecord } from '@canvcode/core'
import { defineNodeType, SHORTCUT_CARD_HEIGHT, pickImageLevel, type FileContentSource, type ImageRequester } from '../defineNodeType.ts'
import { tilesInRect, visibleLocalRect } from '../markdown/tiles.ts'
import { requestFontLoad, textMetricsGeneration, TEXT_FONT_FAMILY } from '../text/fonts.ts'
import { parseDelimited } from './delimited.ts'
import { TABLE_METRICS, columnAtX, drawCellBars, drawCells, estimateTextWidth, layoutTable, tableFont, type ColumnMark, type TableLayout, type TableMeasure } from './tableLayout.ts'
import { applyTableView, filterNeedsValue, withThousandsSeparators, type TableFilter, type TableSort } from './tableView.ts'

// 表のカード（`table-card`）。ワークスペースの .csv / .tsv の File を表にして見せる（.md・.py のカードと同じく、本文は File が持つ）。
// - DOM や SVG は使わない。列の幅を 1 度だけ測り（tableLayout.ts）、見えているところだけを TILE_SIZE の正方形のタイルに分けて、
//   Canvas2D でセルを描いた画像を画像キャッシュに入れる（Markdown カードのタイルと同じ選び方。何万行でも、作るのは見えているタイルだけ）
// - タイルは表の座標で切るので、カードの大きさを変えても作り直さない（カードの外にはみ出す分は切って描く）
// - 画面上で文字が小さいときはタイルを作らず、セルの代わりの帯を描く。もっと小さければ、表の地だけを描く
// - 高さは、既定では全部の行に合わせる（sizing: 'auto'）。'fixed' なら下端をぼかして切る
// - 1 行目を見出しにするか（header）・長いセルを折り返すか（wrap。既定は折り返さない）・並び替え（sort）・絞り込み（filters）は、
//   数の 3 桁区切り（thousands。既定は区切る）は、
//   カードごとに持つ（File の CSV は変えない。tableView.ts）。名前の帯には、絞り込んだ行の数と全体の行の数を出す

export interface TableCardProps {
  fileId: string
  w: number
  h: number
  sizing: 'auto' | 'fixed'
  role: 'owner' | 'shortcut'
  header: boolean
  wrap?: boolean
  // 数の列に 3 桁区切りを入れるか（省けば入れる）
  thousands?: boolean
  sort?: TableSort | null
  filters?: TableFilter[]
}

// 表のカードの型。描画のほかに、カードのローカル座標の点にある列を引ける（パイメニュー「操作」の並び替え・絞り込み）
export interface TableColumnInfo {
  col: number
  // 見出しの文字（見出しがない・空なら「列 N」）
  name: string
  numeric: boolean
}

export type TableCardNode = NodeRecord<TableCardProps>

export const TABLE_CARD_DEFAULT_WIDTH = 640
// 取り込んだときのカードの幅の上限と、高さを固定にする行の数・固定にしたときに見せる行の数
const IMPORT_MAX_WIDTH = 1600
const IMPORT_AUTO_ROWS = 500
const IMPORT_FIXED_ROWS = 30

const HEADER_H = 36
const MIN_HEIGHT = 80
const ROW_H = TABLE_METRICS.rowHeight
// 文字が画面上でこれより小さいときは、セルの代わりに帯を描く（CSS ピクセル。コードカードと同じ）
const BAR_THRESHOLD_PX = 5
// 行が画面上でこれより低いときは、表の地だけを描く
const PLAIN_THRESHOLD_PX = 2
const FADE_H = 48

const BACKGROUND = '#fbfcfd'
const HEADER_BG = '#eef4ef'
const BORDER = 'rgba(31, 35, 40, 0.18)'
const MUTED = '#8c959f'

export interface TableCardOptions {
  files?: FileContentSource
}

// 文字の幅。ブラウザでは Canvas で測り、測れないところ（サーバー）では見積もる
let measureContext: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined
const measureText: TableMeasure = (text, bold) => {
  if (measureContext === undefined) {
    if (typeof OffscreenCanvas !== 'undefined') measureContext = new OffscreenCanvas(1, 1).getContext('2d')
    else if (typeof document !== 'undefined') measureContext = document.createElement('canvas').getContext('2d')
    else measureContext = null
  }
  if (!measureContext) return estimateTextWidth(text, bold)
  measureContext.font = tableFont(bold)
  return measureContext.measureText(text).width
}

// File の本文を表にする（.tsv はタブで区切る）
export function parseTableFile(text: string, path?: string): string[][] {
  return parseDelimited(text, path && /\.tsv$/i.test(path) ? '\t' : undefined)
}

type TableView = Pick<TableCardProps, 'header' | 'wrap' | 'thousands' | 'sort' | 'filters'>

// 見せる行を配置する。並び替え・絞り込みをしている列には、見出しに印を付ける
function layoutRows(rows: string[][], view: TableView): TableLayout {
  // 同梱の Web フォントの読み込みを頼む（読み込めたら、測り直して描き直される）
  const sample = rows.slice(0, 200).flat().join('').slice(0, 4000)
  requestFontLoad(undefined, tableFont(false), sample)
  requestFontLoad(undefined, tableFont(true), sample)
  const marks: ColumnMark[] = []
  if (view.header) {
    if (view.sort) marks[view.sort.col] = { sort: view.sort.dir }
    for (const f of activeFilters(view)) marks[f.col] = { ...marks[f.col], filtered: true }
  }
  const shown = applyTableView(rows, view)
  return layoutTable(view.thousands === false ? shown : withThousandsSeparators(shown, view.header), { header: view.header, measure: measureText, wrap: view.wrap, marks })
}

// 値を入れてある絞り込みの条件（値の要らない条件はそのまま）
function activeFilters(view: TableView): TableFilter[] {
  return (view.filters ?? []).filter((f) => !filterNeedsValue(f.op) || f.value.trim() !== '')
}

// 取り込んだ表のカードの大きさ：幅は表に合わせ（IMPORT_MAX_WIDTH まで）、行が多ければ高さを固定にする。
// サーバーは本文を読まないので、'auto' のときも h に表の高さを入れておく
export function tableCardImportSize(text: string, path?: string): Pick<TableCardProps, 'w' | 'h' | 'sizing'> {
  const layout = layoutRows(parseTableFile(text, path), { header: true })
  const w = Math.max(200, Math.min(IMPORT_MAX_WIDTH, Math.ceil(layout.width)))
  if (layout.cells.length > IMPORT_AUTO_ROWS) return { w, h: HEADER_H + IMPORT_FIXED_ROWS * ROW_H, sizing: 'fixed' }
  return { w, h: Math.max(MIN_HEIGHT, HEADER_H + layout.height), sizing: 'auto' }
}

export function createTableCardType(options: TableCardOptions = {}) {
  const textOf = (props: TableCardProps) => options.files?.get(props.fileId) ?? null

  // CSV を読んだ表は、本文の版ごとに一度だけ作る（見せ方を変えても読み直さない）
  const rowsCache = new Map<string, string[][]>()
  const rowsOf = (content: { text: string; version: string; path?: string }) => {
    const key = `${content.version}|${content.path ?? ''}`
    let rows = rowsCache.get(key)
    if (!rows) {
      rows = parseTableFile(content.text, content.path)
      rowsCache.set(key, rows)
      if (rowsCache.size > 16) rowsCache.delete(rowsCache.keys().next().value!)
    }
    return rows
  }

  // 配置は、本文の版・見せ方・文字の測り方の世代ごとに一度だけ作る。total は絞り込む前のデータの行の数
  const layoutCache = new Map<string, { layout: TableLayout; version: string; total: number }>()
  const layoutOf = (props: TableCardProps) => {
    const content = textOf(props)
    if (!content) return null
    const view: TableView = { header: props.header, wrap: props.wrap === true, thousands: props.thousands !== false, sort: props.sort ?? null, filters: activeFilters(props) }
    const version = `${content.version}|${content.path ?? ''}|${JSON.stringify(view)}|${textMetricsGeneration()}`
    let cached = layoutCache.get(version)
    if (!cached) {
      const rows = rowsOf(content)
      cached = { layout: layoutRows(rows, view), version, total: rows.length - (props.header && rows.length > 0 ? 1 : 0) }
      layoutCache.set(version, cached)
      if (layoutCache.size > 64) layoutCache.delete(layoutCache.keys().next().value!)
    }
    return cached
  }

  // カードのローカル座標の点にある列（表の中、名前の帯より下だけ）
  const columnAt = (node: NodeRecord<TableCardProps>, point: { x: number; y: number }): TableColumnInfo | null => {
    const cached = layoutOf(node.props)
    if (!cached || point.y < HEADER_H || point.y > heightOf(node.props) || point.x > node.props.w) return null
    const { layout } = cached
    const col = columnAtX(layout, point.x)
    if (col === null) return null
    const name = (layout.header ? layout.cells[0]?.[col] : '')?.trim() || `列 ${col + 1}`
    return { col, name, numeric: layout.numeric[col] }
  }

  const contentHeight = (props: TableCardProps) => {
    const cached = layoutOf(props)
    return cached ? Math.max(MIN_HEIGHT, HEADER_H + cached.layout.height) : null
  }
  const heightOf = (props: TableCardProps) => (props.sizing === 'auto' ? (contentHeight(props) ?? props.h) : props.h)

  const def = defineNodeType<TableCardProps>({
    type: 'table-card',
    version: 1,

    defaultProps: () => ({ fileId: '', w: TABLE_CARD_DEFAULT_WIDTH, h: 240, sizing: 'auto', role: 'owner', header: true }),

    getBounds: (node) => ({ x: 0, y: 0, w: node.props.w, h: heightOf(node.props) }),

    hitTest: (node, point, margin) =>
      point.x >= -margin && point.y >= -margin && point.x <= node.props.w + margin && point.y <= heightOf(node.props) + margin,

    render(ctx, node, info) {
      const props = node.props
      const w = props.w
      const h = heightOf(props)
      const doc = info.documents?.get(props.fileId)
      const cached = layoutOf(props)
      ctx.fillStyle = BACKGROUND
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = HEADER_BG
      ctx.fillRect(0, 0, w, HEADER_H)
      ctx.fillStyle = BORDER
      ctx.fillRect(0, HEADER_H - 1 / info.zoom, w, 1 / info.zoom)
      drawHeader(ctx, doc?.title ?? '', props.role === 'shortcut', w, cached)

      const status = doc?.status
      if (!doc || status !== 'ok' || !cached) {
        const message = statusMessage(status)
        if (message) {
          ctx.fillStyle = MUTED
          ctx.font = `14px ${TEXT_FONT_FAMILY}`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(message, w / 2, HEADER_H + (h - HEADER_H) / 2)
          ctx.textAlign = 'left'
        }
      } else {
        drawTable(ctx, node.id, cached.layout, cached.version, w, h, info.zoom, info.devicePixelRatio, info.images)
        // 大きさを固定していて収まらないときは、下端をぼかす
        if (props.sizing === 'fixed' && HEADER_H + cached.layout.height > h) {
          const gradient = ctx.createLinearGradient(0, h - FADE_H, 0, h)
          gradient.addColorStop(0, 'rgba(251, 252, 253, 0)')
          gradient.addColorStop(0.85, BACKGROUND)
          ctx.fillStyle = gradient
          ctx.fillRect(0, h - FADE_H, w, FADE_H)
        }
      }
      // 枠の線（ショートカットは点線）
      ctx.lineWidth = 1 / info.zoom
      ctx.strokeStyle = props.role === 'shortcut' ? '#b4a6d9' : BORDER
      if (props.role === 'shortcut') ctx.setLineDash([6 / info.zoom, 4 / info.zoom])
      ctx.strokeRect(0, 0, w, h)
      ctx.setLineDash([])
    },

    roughColor: () => HEADER_BG,

    // 高さを中身に合わせているカードの高さを、手で変えたら、大きさを固定する
    resize(node, size) {
      const props = node.props
      if (props.sizing === 'auto' && Math.abs(size.h - heightOf(props)) < 1) return { ...props, w: size.w }
      return { ...props, w: size.w, h: size.h, sizing: 'fixed' }
    },
    minSize: { w: 200, h: MIN_HEIGHT },

    reference: (node) => (node.props.fileId ? { targetId: node.props.fileId, role: node.props.role } : null),
    // 貼り付けでショートカットに変わるときは、小さく固定する（#28）
    withRole: (node, role) => (role === 'shortcut' ? { ...node.props, role, sizing: 'fixed', h: SHORTCUT_CARD_HEIGHT } : { ...node.props, role }),
  })
  return Object.assign(def, { columnAt })
}

export type TableCardType = ReturnType<typeof createTableCardType>

// 表のタイルの画像キャッシュのキー。書き出し（サムネイル・PDF に出すスライドの画像）では、これを待ってから描く
export function isTableTileKey(key: string): boolean {
  return key.includes('#table:')
}

// 名前の帯の下に表を描く。見えている範囲だけを、タイルの画像（なければ帯）で描く
function drawTable(
  ctx: CanvasRenderingContext2D,
  nodeId: string,
  layout: TableLayout,
  version: string,
  w: number,
  h: number,
  zoom: number,
  dpr: number,
  images: ImageRequester | undefined,
): void {
  const areaW = Math.min(w, layout.width)
  const areaH = Math.min(h - HEADER_H, layout.height)
  if (areaW <= 0 || areaH <= 0) return
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, HEADER_H, areaW, areaH)
  ctx.clip()
  ctx.translate(0, HEADER_H)
  const visible = visibleLocalRect(ctx, areaW, areaH) ?? { x: 0, y: 0, w: areaW, h: areaH }
  if (visible.w > 0 && visible.h > 0) {
    if (ROW_H * zoom < PLAIN_THRESHOLD_PX) {
      ctx.fillStyle = TABLE_METRICS.stripe
      ctx.fillRect(visible.x, visible.y, visible.w, visible.h)
    } else if (TABLE_METRICS.fontSize * zoom < BAR_THRESHOLD_PX) {
      drawCellBars(ctx, layout, visible)
    } else if (!images) {
      drawCells(ctx, layout, visible, 1 / (zoom * dpr))
    } else {
      const level = pickImageLevel(zoom * dpr)
      // タイルは表全体の座標で切る（カードの大きさによらない）
      for (const tile of tilesInRect(layout.width, layout.height, visible)) {
        const image = images.get(`${nodeId}#table:${tile.col},${tile.row}`, version, level, async () => {
          const width = Math.max(1, Math.round(tile.w * level))
          const height = Math.max(1, Math.round(tile.h * level))
          const canvas = createCanvas(width, height)
          const tileCtx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
          tileCtx.scale(width / tile.w, height / tile.h)
          tileCtx.translate(-tile.x, -tile.y)
          drawCells(tileCtx, layout, tile, 1 / level)
          const bitmap = await createImageBitmap(canvas)
          return { image: bitmap, width, height, level }
        })
        if (image) ctx.drawImage(image.image, tile.x, tile.y, tile.w, tile.h)
        else drawCellBars(ctx, layout, tile)
      }
    }
  }
  ctx.restore()
}

function createCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function statusMessage(status: string | undefined): string | null {
  if (status === 'missing') return 'File が削除されています（リンク切れ）'
  if (status === 'trashed') return 'ゴミ箱の中'
  if (status === 'nofile') return 'ファイルが見つかりません'
  return null
}

// 名前の帯：種類の印・名前・行と列の数
function drawHeader(ctx: CanvasRenderingContext2D, title: string, shortcut: boolean, w: number, table: { layout: TableLayout; total: number } | null): void {
  ctx.fillStyle = 'rgba(26, 127, 55, 0.16)'
  roundedRect(ctx, 12, 11, 28, 15, 4)
  ctx.fill()
  ctx.fillStyle = '#116329'
  ctx.font = `700 10px ${TEXT_FONT_FAMILY}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.fillText('CSV', 26, 18.5)
  ctx.textAlign = 'left'
  let right = w - 12
  if (table) {
    const { layout, total } = table
    const rows = layout.cells.length - (layout.header ? 1 : 0)
    // 絞り込んでいれば「見せている行 / 全体の行」
    const count = rows === total ? total.toLocaleString('ja-JP') : `${rows.toLocaleString('ja-JP')} / ${total.toLocaleString('ja-JP')}`
    const size = `${count} 行 × ${layout.columns} 列`
    ctx.fillStyle = MUTED
    ctx.font = `12px ${TEXT_FONT_FAMILY}`
    const width = ctx.measureText(size).width
    if (width < w - 140) {
      ctx.textAlign = 'right'
      ctx.fillText(size, right, 18.5)
      ctx.textAlign = 'left'
      right -= width + 12
    }
  }
  let x = 48
  if (shortcut) {
    ctx.fillStyle = '#6d43bd'
    ctx.font = `700 11px ${TEXT_FONT_FAMILY}`
    ctx.fillText('↗', x, 18.5)
    x += 14
  }
  ctx.fillStyle = '#1f2328'
  ctx.font = `700 13px ${TEXT_FONT_FAMILY}`
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, 0, Math.max(0, right - x), HEADER_H)
  ctx.clip()
  ctx.fillText(title, x, 18.5)
  ctx.restore()
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
