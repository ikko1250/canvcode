import type { NodeRecord } from '@canvcode/core'
import { defineNodeType } from './defineNodeType.ts'
import { TEXT_FONT_FAMILY } from './text/layout.ts'

// Portal（MAI-7 の `portal`、MAI-8、MAI-29）。別の Canvas への入口。
// - role が 'owner' なら持ち主の Portal。参照先の Canvas は、この Portal が置かれた Canvas の子になる（木構造）
// - 'shortcut' はショートカット。いくつ置いてもよく、木には含めない
// 見た目は、名前の帯と、参照先のサムネイル。参照先の名前や状態は描画のたびに引く（ノードは名前のコピーを持たない）
export interface PortalProps {
  targetId: string
  role: 'owner' | 'shortcut'
  w: number
  h: number
}

export type PortalNode = NodeRecord<PortalProps>

export const PORTAL_DEFAULT_SIZE = { w: 240, h: 170 }

// 名前の帯の寸法（ワールド座標）。名前を変える入力欄を、帯にぴったり重ねるためにも使う
export const PORTAL_HEADER = { height: 30, padding: 10, fontSize: 14 } as const

const HEADER_H = PORTAL_HEADER.height
const RADIUS = 8
const PADDING = PORTAL_HEADER.padding
const TITLE_FONT = PORTAL_HEADER.fontSize
const BORDER = '#c9ced6'

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

// 幅に収まらない名前は、末尾を「…」にする
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
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

export const portalType = defineNodeType<PortalProps>({
  type: 'portal',
  version: 1,

  defaultProps: () => ({ targetId: '', role: 'owner', ...PORTAL_DEFAULT_SIZE }),

  getBounds: (node) => ({ x: 0, y: 0, w: node.props.w, h: node.props.h }),

  hitTest(node, point, margin) {
    const { w, h } = node.props
    return point.x >= -margin && point.y >= -margin && point.x <= w + margin && point.y <= h + margin
  },

  render(ctx, node, info) {
    const { w, h, role, targetId } = node.props
    const doc = info.documents?.get(targetId) ?? { title: '', kind: 'canvas', status: 'missing' }
    // 枠と背景
    roundRect(ctx, 0, 0, w, h, RADIUS)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.save()
    ctx.clip()
    // 中身：サムネイル（なければ淡い背景）
    const body = { x: 0, y: HEADER_H, w, h: h - HEADER_H }
    ctx.fillStyle = '#f6f7f9'
    ctx.fillRect(body.x, body.y, body.w, body.h)
    const thumb = doc.status === 'ok' ? info.documents?.thumbnail(targetId) : null
    if (thumb && body.h > 0) {
      const s = Math.min((body.w - PADDING * 2) / thumb.width, (body.h - PADDING * 2) / thumb.height)
      if (s > 0) {
        const tw = thumb.width * s
        const th = thumb.height * s
        ctx.imageSmoothingEnabled = true
        ctx.drawImage(thumb.image, body.x + (body.w - tw) / 2, body.y + (body.h - th) / 2, tw, th)
      }
    }
    // 名前の帯
    ctx.fillStyle = role === 'owner' ? '#eef3fd' : '#f3f0fb'
    ctx.fillRect(0, 0, w, HEADER_H)
    ctx.fillStyle = BORDER
    ctx.fillRect(0, HEADER_H - 1 / info.zoom, w, 1 / info.zoom)
    ctx.font = `500 ${TITLE_FONT}px ${TEXT_FONT_FAMILY}`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.fillStyle = doc.status === 'ok' ? '#1f2328' : '#8c959f'
    // ショートカットは、名前の前に ↗ を付ける
    const prefix = role === 'shortcut' ? '↗ ' : ''
    const title = doc.status === 'missing' ? 'リンク切れ' : doc.title
    ctx.fillText(fitText(ctx, prefix + title, w - PADDING * 2), PADDING, HEADER_H / 2)
    // ゴミ箱の中・リンク切れの表示
    if (doc.status !== 'ok' && body.h > TITLE_FONT * 2) {
      ctx.textAlign = 'center'
      ctx.fillStyle = doc.status === 'missing' ? '#cf222e' : '#8c959f'
      ctx.fillText(doc.status === 'missing' ? '参照先が削除されています' : 'ゴミ箱の中', w / 2, body.y + body.h / 2)
      ctx.textAlign = 'left'
    }
    ctx.restore()
    // 枠の線（ショートカットは点線）
    roundRect(ctx, 0, 0, w, h, RADIUS)
    ctx.lineWidth = 1.5 / info.zoom
    ctx.strokeStyle = role === 'owner' ? '#8aa8e8' : '#b4a6d9'
    if (role === 'shortcut') ctx.setLineDash([6 / info.zoom, 4 / info.zoom])
    ctx.stroke()
    ctx.setLineDash([])
  },

  roughColor: (node) => (node.props.role === 'owner' ? '#c9d6f5' : '#dcd3f0'),

  resize: (node, size) => ({ ...node.props, w: size.w, h: size.h }),
  minSize: { w: 80, h: 60 },
  reference: (node) => ({ targetId: node.props.targetId, role: node.props.role }),
  withRole: (node, role) => ({ ...node.props, role }),
})
