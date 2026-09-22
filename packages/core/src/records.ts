// キャンバス内のレコード（MAI-7）。段階 2 では Node だけを扱う。段階 6 で Asset、段階 8 で Binding を加えた。
// Canvas・File などは、必要になる段階で追加する。

export interface NodeRecord<P extends object = object> {
  typeName: 'node'
  id: string
  type: string
  // 所属する Canvas の id、または親の group / frame の id
  parentId: string
  // 親のローカル座標（MAI-6）
  x: number
  y: number
  rotation: number
  // 親ごとの重なり順（fractional index）
  index: string
  opacity: number
  locked: boolean
  props: P
  meta: Record<string, unknown>
}

// 画像や PDF の実体への参照（MAI-7、MAI-10）。キャンバスではなくワークスペースに属する。
// id は中身の SHA-256 から作る（`asset:<ハッシュ>`）。同じファイルを 2 回取り込んでも 1 つにまとまる
export interface AssetRecord {
  typeName: 'asset'
  id: string
  mime: string
  size: number
  // 中身の SHA-256（16 進数）
  hash: string
  // 画像の場合の大きさ（画素）
  width: number
  height: number
  // 作ってある縮小版の長辺（画素）。縮小版より小さい画像には作らない（MAI-14）
  variants: number[]
}

export function assetIdFromHash(hash: string): string {
  return `asset:${hash}`
}

// 矢印の端がどのノードのどこにつながっているか（MAI-7、MAI-28）
export interface BindingRecord {
  typeName: 'binding'
  id: string
  type: 'arrow'
  // 矢印のノード
  fromId: string
  // つながっている先のノード
  toId: string
  props: ArrowBindingProps
}

export interface ArrowBindingProps {
  terminal: 'start' | 'end'
  // つながっている先のノードの箱の中での位置（0〜1）
  normalizedAnchor: { x: number; y: number }
  // true なら矢印は anchor を向く。false なら箱の中心を向く（tldraw と同じ）
  isPrecise: boolean
}

// 1 つの Canvas のストアに入るレコード
export type CanvasRecord = NodeRecord | BindingRecord

export function isNodeRecord(record: CanvasRecord | undefined): record is NodeRecord {
  return record?.typeName === 'node'
}

export function isBindingRecord(record: CanvasRecord | undefined): record is BindingRecord {
  return record?.typeName === 'binding'
}

export type WorkspaceRecord = CanvasRecord
