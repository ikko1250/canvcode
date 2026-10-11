import type { NodeRecord, Vec } from '@canvcode/core'
import { defineNodeType } from './defineNodeType.ts'
import { TEXT_FONT_FAMILY } from './text/fonts.ts'

// 子を持つノード（MAI-7、MAI-25）。子は parentId で親を指し、位置は親のローカル座標で持つ。

// ---- group ----
// 見た目は持たない。大きさは子から計算する（NodeIndex）。直接は当たらず、子に当たると group が選ばれる
export type GroupProps = Record<string, never>

export const groupType = defineNodeType<GroupProps>({
  type: 'group',
  version: 1,
  defaultProps: () => ({}),
  // 大きさは NodeIndex が子から計算する
  getBounds: () => ({ x: 0, y: 0, w: 0, h: 0 }),
  hitTest: () => false,
  render: () => {},
  container: 'group',
  canBind: false,
})

// ---- frame ----
// 名前を持ち、子を枠で切り抜いて描く。名前の部分と、枠の中のどこでも当たる
// （子は手前にあるので子が先に当たる。枠の中で範囲選択するときは Ctrl（⌘）+ドラッグ）
export interface FrameProps {
  w: number
  h: number
  name: string
}

export type FrameNode = NodeRecord<FrameProps>

// 名前の文字の大きさと、名前と枠の間（どちらも画面上の CSS ピクセル）
const LABEL_FONT_PX = 12
const LABEL_GAP_PX = 4

// 以下の 3 つは、frame と同じ枠を持つ型（スライド）でも使う。name には名前の部分に描く文字列を渡す（スライドは番号を付けたもの）

// 名前の部分と、枠の中（枠の線の近くを含む）で当たる
export function frameHitTest(w: number, h: number, name: string, point: Vec, margin: number, zoom: number): boolean {
  // 名前の部分（枠の左上の上）
  const labelH = (LABEL_FONT_PX + LABEL_GAP_PX * 2) / zoom
  const labelW = Math.min(w, (name.length * LABEL_FONT_PX + LABEL_GAP_PX * 2) / zoom)
  if (point.x >= 0 && point.x <= labelW && point.y >= -labelH && point.y <= 0) return true
  return point.x >= -margin && point.y >= -margin && point.x <= w + margin && point.y <= h + margin
}

// 白い地と細い枠の線を描く。線の太さは倍率によらず画面上で 1 ピクセル
export function drawFrameBox(ctx: CanvasRenderingContext2D, w: number, h: number, zoom: number): void {
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.lineWidth = 1 / zoom
  ctx.strokeStyle = '#c9ced6'
  ctx.strokeRect(0, 0, w, h)
}

// 名前は、倍率によらず画面上で同じ大きさで、枠の左上の上に描く。color は文字の色（スライドの警告で変える）
export function drawFrameLabel(ctx: CanvasRenderingContext2D, name: string, zoom: number, color = '#656d76'): void {
  ctx.font = `500 ${LABEL_FONT_PX / zoom}px ${TEXT_FONT_FAMILY}`
  ctx.fillStyle = color
  ctx.textBaseline = 'bottom'
  ctx.textAlign = 'left'
  ctx.fillText(name, 0, -LABEL_GAP_PX / zoom)
}

export const frameType = defineNodeType<FrameProps>({
  type: 'frame',
  version: 1,

  defaultProps: () => ({ w: 320, h: 240, name: 'フレーム' }),

  getBounds: (node) => ({ x: 0, y: 0, w: node.props.w, h: node.props.h }),

  hitTest: (node, point, margin, zoom) => frameHitTest(node.props.w, node.props.h, node.props.name, point, margin, zoom),

  render(ctx, node, info) {
    drawFrameBox(ctx, node.props.w, node.props.h, info.zoom)
    drawFrameLabel(ctx, node.props.name, info.zoom)
  },

  roughColor: () => '#ffffff',

  // フレームのリサイズは、枠の大きさだけを変える（子は伸ばさない。Figma と同じ）
  resize: (node, size) => ({ ...node.props, w: size.w, h: size.h }),
  minSize: { w: 40, h: 40 },
  container: 'frame',
})
