// キャンバス内のレコード（MAI-7）。段階 2 では Node だけを扱う。
// Binding・Asset・Canvas・File などは、必要になる段階で追加する。

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

export type WorkspaceRecord = NodeRecord
