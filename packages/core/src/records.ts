// ワークスペースのレコード（MAI-7）。段階 2 では Node だけを扱う。段階 6 で Asset、段階 8 で Binding、段階 9 で Canvas、
// 段階 10 で File と SourceAnchor を加えた。

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
  // 持ち主のノード（Portal）。ルートと、未配置・ゴミ箱の中のものは null
  ownerNodeId: string | null
  createdAt: number
  updatedAt: number
  // ゴミ箱に入れた時刻。入っていなければ null
  deletedAt: number | null
  // ゴミ箱に一緒に入れたもののまとまり。まとまりの根（持ち主を消されたもの）は、その持ち主（Portal やカード）の写しを持ち、
  // 元に戻すときに同じ場所へ置き直す
  trash: { batchId: string; portal: NodeRecord | null } | null
}

// Markdown / Python などの本文を持つもの（MAI-7、MAI-10、MAI-30）。本文はワークスペースのフォルダの実ファイルにある。
// キャンバスには、これを参照するカード（markdown-card など）として置く。Canvas と同じく持ち主（カード）を 1 つだけ持つ
export interface FileRecord {
  typeName: 'file'
  id: string
  // pdf は、本文を Asset に持ち、ページを並べた Canvas（pagesCanvasId）で表示する（MAI-7、MAI-32）
  kind: 'markdown' | 'code' | 'slides' | 'pdf'
  // 名前はファイル名（拡張子を除く）と同じ。名前を変えるとファイル名も変わる
  title: string
  // ワークスペースのフォルダからの相対パス
  path: string
  size: number
  mtime: number
  // 中身の SHA-256
  hash: string
  // 実ファイルが見つからない（外で削除された）。ノードは消さず、カードにそのことを表示する
  missing: boolean
  // PDF のとき：原本の Asset、ページを並べた Canvas、ページ数
  assetId?: string
  pagesCanvasId?: string
  pageCount?: number
  // ここから下は Canvas と同じ（階層とゴミ箱）
  parentCanvasId: string | null
  ownerNodeId: string | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  trash: { batchId: string; portal: NodeRecord | null } | null
}

// 階層に入るもの（Portal やカードの参照先）
export type DocumentRecord = CanvasRecord | FileRecord

// 引用の出典（MAI-7、MAI-10、MAI-33）。引用ノート（quote-card）がこれを参照する。同じ範囲を複数のノートが引用してよい。
// 引用しているノートがすべて消えたら、一緒に消す（ワークスペースのフック）
export interface SourceAnchorRecord {
  typeName: 'anchor'
  id: string
  // 出典の File（PDF・Markdown）
  fileId: string
  locator: SourceLocator
  // 引用した文字列（変えない）。Markdown では、行番号を付け直すときの手がかりにもする
  quote: string
  createdAt: number
}

// 出典の中の位置。
// - pdf：ページ（0 から）と、ページの中の矩形（ページ全体を 0〜1 とした割合）。PDF の中身は変わらないので、ずれない
// - markdown：引用を始めた行（1 から）。ファイルが変わったら quote を探して付け直す。見つからなければ「位置不明」
// - canvas：Canvas のノード（旧データの取り込み用。初版では作る操作を用意しない）
export type SourceLocator =
  | { kind: 'pdf'; pageIndex: number; rect: { x: number; y: number; w: number; h: number } }
  | { kind: 'markdown'; line: number }
  | { kind: 'canvas'; canvasId: string; nodeIds: string[] }

// ワークスペースのストアに入るレコード（MAI-11：ストアはワークスペースに 1 つ、履歴は Canvas ごと）
export type WorkspaceRecord = NodeRecord | BindingRecord | CanvasRecord | FileRecord | SourceAnchorRecord

export function isNodeRecord(record: WorkspaceRecord | undefined): record is NodeRecord {
  return record?.typeName === 'node'
}

export function isBindingRecord(record: WorkspaceRecord | undefined): record is BindingRecord {
  return record?.typeName === 'binding'
}

export function isCanvasRecord(record: WorkspaceRecord | undefined): record is CanvasRecord {
  return record?.typeName === 'canvas'
}

export function isFileRecord(record: WorkspaceRecord | undefined): record is FileRecord {
  return record?.typeName === 'file'
}

export function isAnchorRecord(record: WorkspaceRecord | undefined): record is SourceAnchorRecord {
  return record?.typeName === 'anchor'
}

export function isDocumentRecord(record: WorkspaceRecord | undefined): record is DocumentRecord {
  return record?.typeName === 'canvas' || record?.typeName === 'file'
}
