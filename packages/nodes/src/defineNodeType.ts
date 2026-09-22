import type { Box, NodeRecord, Vec } from '@canvcode/core'

// ノードの型の定義（MAI-9）。基本図形も Portal や Markdown カードも、同じ形で定義する。
// 段階 2 で使う項目だけを先に入れている。編集モード・テキストの取り出し・右クリックメニュー・
// props のスキーマ（valibot）などは、それを使う段階で追加する。

export interface RenderInfo {
  // 現在の倍率（ワールド 1 単位が画面上で何 CSS ピクセルか）
  zoom: number
  devicePixelRatio: number
  // 'full' は通常の描画、'rough' はズームアウト時の簡略描画（MAI-14）
  detail: 'full' | 'rough'
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
}

export type AnyNodeTypeDef = NodeTypeDef<any>

export function defineNodeType<P extends object>(def: NodeTypeDef<P>): NodeTypeDef<P> {
  return def
}
