import type { NodeRecord, Vec } from '@canvcode/core'
import { imagePaint, toFill, type Fill } from '@canvcode/nodes'
import type { Editor } from './editor.ts'

// 画像の塗り（MAI-83）を図形に入れる操作。パネル（ファイル・ワークスペースの画像・クリップボード）と、
// キャンバスの操作（Alt を押しながら図形の上へ画像をドロップ、Ctrl（⌘）+Alt+V で選んでいる図形へ貼り付け）が使う。
// 画像ノードを作る既定の操作（ドロップ・Ctrl+V）とは、修飾キーで分ける

// 塗りに画像を持てる型（props.fill が paint.ts の Fill のもの）
const IMAGE_FILL_TYPES: ReadonlySet<string> = new Set(['geo'])

export function canHoldImageFill(node: NodeRecord | undefined): node is NodeRecord {
  return node !== undefined && IMAGE_FILL_TYPES.has(node.type)
}

// 塗りを assetId の画像にしたノード。今が画像の塗りなら、表示のしかた・切り抜き・倍率・不透明度はそのまま（画像だけ差し替える）。
// ほかの塗りからなら、不透明度だけを引き継いで「塗りつぶし（fill）」にする
export function withImageFill(node: NodeRecord, assetId: string): NodeRecord {
  const props = node.props as { fill?: unknown }
  const current: Fill = toFill(props.fill)
  const fill = current?.type === 'image' ? { ...current, assetId } : imagePaint(assetId, { opacity: current?.opacity ?? 1 })
  return { ...node, props: { ...props, fill } }
}

// ids のうち画像の塗りを持てるノードの塗りを、assetId の画像にする（Undo 1 回）。変えたノードの id を返す
export function setImageFill(editor: Editor, ids: Iterable<string>, assetId: string): string[] {
  const nodes = [...ids].map((id) => editor.getNode(id)).filter(canHoldImageFill)
  if (nodes.length === 0) return []
  editor.transact('image fill', (tx) => {
    for (const node of nodes) tx.put(withImageFill(node, assetId))
  })
  return nodes.map((node) => node.id)
}

// ワールド座標の点にある、画像の塗りを持てる最も手前のノード（ドロップ先）。なければ null
export function imageFillTargetAt(editor: Editor, point: Vec): NodeRecord | null {
  const node = editor.hitTest(point, 0)
  return canHoldImageFill(node ?? undefined) ? node : null
}
