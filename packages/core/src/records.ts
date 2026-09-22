// ワークスペースのレコード（MAI-7）。段階 2 では Node だけを扱う。段階 6 で Asset、段階 8 で Binding、段階 9 で Canvas を加えた。
// File は段階 10 で追加する。

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

// Canvas（MAI-7、MAI-8）。キャンバスを持つのは Canvas だけ。
// 階層は木構造：持ち主の Portal が 1 つだけあり、それが置かれている Canvas が親になる
export interface CanvasRecord {
  typeName: 'canvas'
  id: string
  title: string
  // 持ち主の Portal が置かれている Canvas。ルートと、未配置・ゴミ箱の中のものは null
  parentCanvasId: string | null
  // 持ち主の Portal。ルートと、未配置・ゴミ箱の中のものは null
  ownerPortalId: string | null
  createdAt: number
  updatedAt: number
  // ゴミ箱に入れた時刻。入っていなければ null
  deletedAt: number | null
  // ゴミ箱に一緒に入れたもののまとまり。まとまりの根（持ち主の Portal を消されたもの）は、その Portal の写しを持ち、
  // 元に戻すときに同じ場所へ置き直す
  trash: { batchId: string; portal: NodeRecord | null } | null
}

// ワークスペースのストアに入るレコード（MAI-11：ストアはワークスペースに 1 つ、履歴は Canvas ごと）
export type WorkspaceRecord = NodeRecord | BindingRecord | CanvasRecord

export function isNodeRecord(record: WorkspaceRecord | undefined): record is NodeRecord {
  return record?.typeName === 'node'
}

export function isBindingRecord(record: WorkspaceRecord | undefined): record is BindingRecord {
  return record?.typeName === 'binding'
}

export function isCanvasRecord(record: WorkspaceRecord | undefined): record is CanvasRecord {
  return record?.typeName === 'canvas'
}
