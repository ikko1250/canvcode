// 新しいタブで開く（MAI-63）。内部のタブは作らず、ブラウザの新しいタブで URL を開く。
// DOM に依らない URL の組み立てをここに置く（受け取りは App.tsx）。
//
// 気をつけること：
// - 新しいタブは、ワークスペースの記録を読み込み直す、独立した画面になる。Undo / Redo の履歴はタブごとに別
// - 記録の変更は、サーバー経由でほかのタブにも届く（後から書いた方が勝つ）。同じ File を 2 つのタブで
//   同時に編集すると、保存していない編集がある側に、今ある衝突のダイアログ（onConflict）が出る
import type { NodeRecord } from '@canvcode/core'
import type { Workspace } from '@canvcode/canvas'

export function canvasUrl(canvasId: string): string {
  return `/c/${encodeURIComponent(canvasId)}`
}

export function fileUrl(fileId: string): string {
  return `/f/${encodeURIComponent(fileId)}`
}

// スライドエディタ。back は閉じたときに戻る先（キャンバスの URL）
export function slideEditorUrl(deckId: string, back: string): string {
  return `/slide-editor.html?deck=${encodeURIComponent(deckId)}&back=${encodeURIComponent(back)}`
}

// ノードを新しいタブで開くときの URL。開けないもの（参照先がゴミ箱の中・見つからない など）は null。
// canvasId はノードのある Canvas（スライドエディタを閉じたときは、ここに戻る）
export function newTabUrl(workspace: Workspace, node: NodeRecord, canvasId: string): string | null {
  if (node.type === 'portal') {
    const targetId = (node.props as { targetId?: string }).targetId
    return targetId && workspace.targetStatus(targetId) === 'ok' ? canvasUrl(targetId) : null
  }
  if (node.type !== 'markdown-card' && node.type !== 'code-card' && node.type !== 'slide-deck-card') return null
  const fileId = (node.props as { fileId?: string }).fileId
  const file = fileId ? workspace.getFile(fileId) : undefined
  if (!file || workspace.targetStatus(file.id) !== 'ok') return null
  return file.kind === 'slides' ? slideEditorUrl(file.id, canvasUrl(canvasId)) : fileUrl(file.id)
}

// opener を切って、元のタブと結び付かない、独立したタブにする
export function openInNewTab(url: string): void {
  window.open(url, '_blank', 'noopener')
}
