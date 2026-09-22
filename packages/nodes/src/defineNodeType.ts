import type { Box, NodeRecord, Vec } from '@canvcode/core'
import type { TextStyle } from './text/layout.ts'

// ノードの型の定義（MAI-9）。基本図形も Portal や Markdown カードも、同じ形で定義する。
// 段階 2 で使う項目だけを先に入れている。編集モード・テキストの取り出し・右クリックメニュー・
// props のスキーマ（valibot）などは、それを使う段階で追加する。

export interface RenderInfo {
  // 現在の倍率（ワールド 1 単位が画面上で何 CSS ピクセルか）
  zoom: number
  devicePixelRatio: number
  // 'full' は通常の描画、'rough' はズームアウト時の簡略描画（MAI-14）
  detail: 'full' | 'rough'
  // 時間のかかる画像（Markdown を画像にしたものなど）を頼む先（MAI-9 の「3. 時間のかかる素材の扱い」）
  images?: ImageRequester
  // 文字を編集中のノードか（MAI-24）。編集中は textarea が文字を見せるので、型は文字だけを描かない
  editing?: boolean
}

// 作ってある画像。level は解像度の倍率（CSS ピクセル 1 つあたりの画素数）
export interface RasterImage {
  image: CanvasImageSource
  width: number
  height: number
  level: number
}

export interface ImageRequester {
  // key の画像を、version の中身・level の解像度で欲しいと頼む。手元にあるいちばん近い解像度のものを返し、
  // 頼んだものがなければ、あとで作る（できたら描き直される）。
  // 中身が変わった（version が違う）ときも、新しいものができるまでは古いものを返す（リサイズ中の引き伸ばしなど）。
  // 何もなければ null。
  get(key: string, version: string, level: number, produce: () => Promise<RasterImage>): RasterImage | null
}

export interface NodeTypeDef<P extends object> {
  type: string
  version: number
  defaultProps(): P
  // ノードのローカル座標でのバウンディングボックス
  getBounds(node: NodeRecord<P>): Box
  // ローカル座標の点が当たっているか。margin はローカル座標での余裕（細い線を当てやすくするため）
  hitTest(node: NodeRecord<P>, point: Vec, margin: number): boolean
  // ctx はノードのローカル座標に合わせてある。1 単位 = ワールド 1 単位。
  render(ctx: CanvasRenderingContext2D, node: NodeRecord<P>, info: RenderInfo): void
  // ズームアウト時の簡略描画。定義しなければ基盤がバウンディングボックスを塗りつぶす。
  renderRough?(ctx: CanvasRenderingContext2D, node: NodeRecord<P>, info: RenderInfo): void
  // 簡略描画に使う色
  roughColor?(node: NodeRecord<P>): string
  // リサイズしたときの新しい props（MAI-23）。定義しなければリサイズできない。
  // リサイズできる型は、getBounds の箱の原点を (0, 0) にする
  resize?(node: NodeRecord<P>, size: { w: number; h: number }): P
  // リサイズで小さくできる限度（既定は 1×1）
  minSize?: { w: number; h: number }
  // 回転できるか（既定は true）
  canRotate?: boolean
  // 文字を編集できる型は、編集のしかたを返す（MAI-24）。編集モードでは、これに合わせて textarea を重ねる
  editText?(node: NodeRecord<P>): TextEditSpec<P>
}

export interface TextEditSpec<P> {
  text: string
  style: TextStyle
  // 文字を置く箱（ローカル座標）。autoWidth のときは、幅は文字に合わせて伸びる
  box: Box
  autoWidth: boolean
  verticalAlign: 'top' | 'middle'
  // 文字を変えたときの新しい props
  update(text: string): P
  // 空のまま編集を終えたら、ノードを消すか（テキストは消し、付箋や図形のラベルは残す）
  deleteIfEmpty: boolean
}

export type AnyNodeTypeDef = NodeTypeDef<any>

export function defineNodeType<P extends object>(def: NodeTypeDef<P>): NodeTypeDef<P> {
  return def
}

// 画像の解像度の段階（MAI-22）。段階をまたいだときだけ作り直す
export const IMAGE_LEVELS = [0.25, 0.5, 1, 2, 4] as const

// 表示に必要な倍率（CSS ピクセル 1 つあたりの画素数）以上で、最も小さい段階
export function pickImageLevel(pixelsPerUnit: number): number {
  for (const level of IMAGE_LEVELS) if (level >= pixelsPerUnit) return level
  return IMAGE_LEVELS[IMAGE_LEVELS.length - 1]
}
