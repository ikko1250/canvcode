import type { NodeRecord } from '@canvcode/core'
import { defineNodeType } from './defineNodeType.ts'
import { TEXT_FONT_FAMILY } from './text/fonts.ts'
import { TEXT_BAR_THRESHOLD_PX } from './text/layout.ts'

// どんなファイルでも置けるカード（MAI-100）。Markdown・表・画像・PDF のように中身を開いて見せられない種類
// （docx・xlsx・pptx・zip など）のファイルを Canvas に落とすと、これを置く。
// - 実体は PDF と同じく Asset（<ワークスペース>/.canvcode/assets/<ハッシュ>.<拡張子>）にあり、ノードは assetId で参照する。
//   同じファイルを 2 回落としても、中身は 1 つにまとまる。ファイルの名前・種類・大きさは、ノードの props に持つ
// - カードには、種類の札（拡張子）・名前・種類の名前と大きさを出す
// - Ctrl（⌘）+クリック（linkAt）と右クリックの「開く」で、新しいタブで開く（ブラウザが開けない種類はダウンロードになる）。
//   右クリックの「ダウンロード」は、元の名前で保存する
// - docx は Markdown に、xlsx はシートごとに表（CSV）に変換できる（右クリック。apps/server の fileConvert.ts）。
//   変換したものは写しで、元のファイル（このカード）はそのまま残る
// - 高さは決まっている（幅だけを変えられる）
export interface AttachmentProps {
  assetId: string
  // 元のファイルの名前（拡張子を含む）
  name: string
  // ブラウザが付けた種類（分からなければ application/octet-stream）
  mime: string
  // 大きさ（バイト）
  size: number
  w: number
}

export type AttachmentNode = NodeRecord<AttachmentProps>

export const ATTACHMENT_DEFAULT_WIDTH = 300
export const ATTACHMENT_HEIGHT = 72
// 原本を配る口（apps/server の AssetStore）
const ASSET_URL = '/api/assets/'

// 寸法（ワールド座標）
const PADDING = 12
const BADGE_W = 44
const BADGE_H = 48
const NAME_FONT = 14
const DETAIL_FONT = 12
const BORDER = 'rgba(31, 35, 40, 0.16)'

export interface AttachmentKind {
  // 種類の名前（カードの 2 行目に出す）
  label: string
  // 札の色
  color: string
}

const KINDS: { label: string; color: string; extensions: string[] }[] = [
  { label: 'Word 文書', color: '#2b579a', extensions: ['doc', 'docx', 'docm', 'dot', 'dotx', 'odt', 'rtf'] },
  { label: 'Excel ブック', color: '#217346', extensions: ['xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'ods'] },
  { label: 'PowerPoint', color: '#c43e1c', extensions: ['ppt', 'pptx', 'pptm', 'pot', 'potx', 'odp', 'key'] },
  { label: '圧縮ファイル', color: '#7d4e00', extensions: ['zip', '7z', 'rar', 'gz', 'tgz', 'tar', 'xz', 'bz2', 'zst', 'lzh'] },
  { label: 'テキスト', color: '#57606a', extensions: ['txt', 'log', 'rst', 'tex', 'bib'] },
  { label: 'データ', color: '#0969da', extensions: ['json', 'jsonl', 'ndjson', 'xml', 'yaml', 'yml', 'toml', 'ini', 'sql', 'sqlite', 'db', 'parquet', 'ipynb'] },
  { label: '画像', color: '#1a7f37', extensions: ['svg', 'tif', 'tiff', 'heic', 'heif', 'psd', 'ai', 'eps', 'emf', 'wmf', 'ico', 'raw', 'dng'] },
  { label: '音声', color: '#8250df', extensions: ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac'] },
  { label: '動画', color: '#bf3989', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'] },
  { label: 'Web ページ', color: '#bc4c00', extensions: ['html', 'htm', 'mhtml'] },
]
const KIND_BY_EXTENSION = new Map(KINDS.flatMap((kind) => kind.extensions.map((ext) => [ext, { label: kind.label, color: kind.color }] as const)))
const OTHER_KIND: AttachmentKind = { label: 'ファイル', color: '#6e7781' }

// ファイルの名前の拡張子（小文字。. は付けない）。なければ ''
export function attachmentExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : ''
}

export function attachmentKind(name: string): AttachmentKind {
  return KIND_BY_EXTENSION.get(attachmentExtension(name)) ?? OTHER_KIND
}

// 大きさを読みやすくする（1000 未満はバイト、そこから KB・MB・GB。1024 で割る）
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1000) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

// 原本の URL。download なら、元の名前で保存させる（サーバーが Content-Disposition を attachment にする）
export function attachmentUrl(props: Pick<AttachmentProps, 'assetId' | 'name'>, options: { download?: boolean } = {}): string | null {
  const hash = props.assetId.startsWith('asset:') ? props.assetId.slice('asset:'.length) : ''
  if (!/^[0-9a-f]{64}$/.test(hash)) return null
  const query = new URLSearchParams({ name: props.name })
  if (options.download) query.set('download', '1')
  return `${ASSET_URL}${hash}?${query}`
}

// 札に書く文字（拡張子を大文字で。長いものは 4 文字まで）
function badgeText(name: string): string {
  const ext = attachmentExtension(name).toUpperCase()
  return ext ? ext.slice(0, 4) : 'FILE'
}

export const attachmentType = defineNodeType<AttachmentProps>({
  type: 'attachment',
  version: 1,

  defaultProps: () => ({ assetId: '', name: '', mime: 'application/octet-stream', size: 0, w: ATTACHMENT_DEFAULT_WIDTH }),

  getBounds: (node) => ({ x: 0, y: 0, w: node.props.w, h: ATTACHMENT_HEIGHT }),

  hitTest(node, point, margin) {
    return point.x >= -margin && point.y >= -margin && point.x <= node.props.w + margin && point.y <= ATTACHMENT_HEIGHT + margin
  },

  render(ctx, node, info) {
    const { w, name, size } = node.props
    const h = ATTACHMENT_HEIGHT
    const kind = attachmentKind(name)
    ctx.fillStyle = 'rgba(40, 40, 40, 0.08)'
    ctx.fillRect(2, 3, w, h)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.lineWidth = 1 / info.zoom
    ctx.strokeStyle = BORDER
    ctx.strokeRect(0, 0, w, h)

    // 種類の札（右上の角を折った紙の形）
    const bx = PADDING
    const by = (h - BADGE_H) / 2
    const fold = 10
    ctx.fillStyle = kind.color
    ctx.beginPath()
    ctx.moveTo(bx, by)
    ctx.lineTo(bx + BADGE_W - fold, by)
    ctx.lineTo(bx + BADGE_W, by + fold)
    ctx.lineTo(bx + BADGE_W, by + BADGE_H)
    ctx.lineTo(bx, by + BADGE_H)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)'
    ctx.beginPath()
    ctx.moveTo(bx + BADGE_W - fold, by)
    ctx.lineTo(bx + BADGE_W, by + fold)
    ctx.lineTo(bx + BADGE_W - fold, by + fold)
    ctx.closePath()
    ctx.fill()

    const textX = bx + BADGE_W + PADDING
    const textW = Math.max(0, w - textX - PADDING)
    const nameY = h / 2 - NAME_FONT * 1.15
    const detailY = h / 2 + 4
    // 小さく見えているときは、文字の代わりに帯を描く（ほかのカードと同じ）
    if (DETAIL_FONT * info.zoom < TEXT_BAR_THRESHOLD_PX) {
      ctx.fillStyle = 'rgba(31, 35, 40, 0.25)'
      ctx.fillRect(textX, nameY + 2, textW * 0.8, NAME_FONT * 0.8)
      ctx.fillStyle = 'rgba(31, 35, 40, 0.12)'
      ctx.fillRect(textX, detailY + 2, textW * 0.5, DETAIL_FONT * 0.8)
      return
    }
    ctx.textBaseline = 'top'
    ctx.textAlign = 'center'
    ctx.font = `700 11px ${TEXT_FONT_FAMILY}`
    ctx.fillStyle = '#ffffff'
    ctx.fillText(fit(ctx, badgeText(name), BADGE_W - 6), bx + BADGE_W / 2, by + BADGE_H - 18)

    ctx.textAlign = 'left'
    ctx.font = `600 ${NAME_FONT}px ${TEXT_FONT_FAMILY}`
    ctx.fillStyle = '#1f2328'
    ctx.fillText(fit(ctx, name || '（名前なし）', textW), textX, nameY)
    ctx.font = `400 ${DETAIL_FONT}px ${TEXT_FONT_FAMILY}`
    ctx.fillStyle = '#656d76'
    ctx.fillText(fit(ctx, [kind.label, formatFileSize(size)].filter(Boolean).join(' ・ '), textW), textX, detailY)
  },

  roughColor: () => '#ffffff',

  // 幅だけを変える（高さは決まっている）
  resize: (node, size) => ({ ...node.props, w: size.w }),
  minSize: { w: 160, h: ATTACHMENT_HEIGHT },

  assets: (node) => (node.props.assetId ? [node.props.assetId] : []),

  // カードのどこでも、Ctrl（⌘）+クリックで開く
  linkAt: (node) => attachmentUrl(node.props),
})

// 幅に収まらなければ、末尾を … にして縮める
function fit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (ctx.measureText(text).width <= maxWidth) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + '…'
}
