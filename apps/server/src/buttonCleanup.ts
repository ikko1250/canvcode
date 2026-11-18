import type { Patch, WorkspaceRecord } from '@canvcode/core'
import { Workspace } from '@canvcode/canvas/workspace'
import { defineNodeType, type AnyNodeTypeDef } from '@canvcode/nodes'
import { serverNodeTypes } from './agent/host.ts'
import type { RecordStore, StoredRecord } from './records.ts'

// 付箋で答えるフレームのボタン（button の型。docs/canvas-answer-panel-plan.md の 8）を消したあとの、保存済みのデータの一度きりの片付け。
// サーバーの起動時に呼ぶ。片付けるものがなければ何もしない（何度呼んでもよい）。
// - button のノードを消す。消し方はブラウザの削除と同じ（サーバーの中の Workspace のフックを通す）：つながっている矢印は、端をその場に固定して
//   Binding を外す（付箋で答えた答えの矢印のように、端と一緒に消す印のある矢印は消す）。子がいなくなった group も消す。
//   型はもう無いので、箱だけを持つ代わりの型（legacyType）を Workspace に渡す
// - AI の編集の記録のうち、button のノードを含むものを消す（取り消しで、そのノードを戻さないように）
// レコードを変えるときは、先に workspace.db の写しを作る（records.ts の backupBefore）

export const REMOVED_BUTTON_TYPES: readonly string[] = ['button']

export interface ButtonCleanup {
  // 消したノード（ボタンと、一緒に消えた矢印・空の group）と、外した Binding
  removedNodes: number
  removedBindings: number
  removedAgentOps: number
  // 片付ける前の workspace.db の写し（レコードを変えなければ null）
  backup: string | null
}

export function cleanupButtons(records: RecordStore): ButtonCleanup | null {
  const nodeIds = records.nodeIdsOfTypes(REMOVED_BUTTON_TYPES)
  const result: ButtonCleanup = { removedNodes: 0, removedBindings: 0, removedAgentOps: 0, backup: null }
  if (nodeIds.length > 0) {
    const puts: StoredRecord[] = []
    const deletes: string[] = []
    for (const [id, change] of removeInWorkspace(records, nodeIds)) {
      if (change.after) puts.push(change.after as unknown as StoredRecord)
      else if (change.before) deletes.push(id)
    }
    result.removedNodes = deletes.filter((id) => id.startsWith('node:')).length
    result.removedBindings = deletes.filter((id) => id.startsWith('binding:')).length
    result.backup = records.backupBefore('button-removal')
    records.apply(puts, deletes)
  }
  result.removedAgentOps = records.deleteAgentOpsWithNodeTypes(REMOVED_BUTTON_TYPES)
  if (nodeIds.length === 0 && result.removedAgentOps === 0) return null
  return result
}

// 片付けたことのログの文
export function describeButtonCleanup(result: ButtonCleanup): string {
  const parts = [`ノード ${result.removedNodes} 個（Binding ${result.removedBindings} 個）を消した`]
  if (result.removedAgentOps > 0) parts.push(`AI の編集の記録 ${result.removedAgentOps} 件を消した`)
  return `付箋で答えるフレームのボタンを片付けた：${parts.join('、')}${result.backup ? `。片付ける前の写し：${result.backup}` : ''}`
}

// 消した型の代わりに、箱（props の w・h。なければボタンの既定の大きさ）だけを持つ型。描かない
function legacyType(type: string): AnyNodeTypeDef {
  return defineNodeType<{ w?: unknown; h?: unknown }>({
    type,
    version: 1,
    defaultProps: () => ({}),
    getBounds: (node) => ({ x: 0, y: 0, w: Number(node.props.w) || 120, h: Number(node.props.h) || 32 }),
    hitTest: () => false,
    render: () => {},
  })
}

// 全レコードをサーバーの中の Workspace に読み、ブラウザの削除と同じフックを通して 1 つのトランザクションで消し、その差分を返す
function removeInWorkspace(records: RecordStore, nodeIds: readonly string[]): Patch<WorkspaceRecord> {
  const loaded = records.load()
  const workspace = new Workspace({ rootCanvasId: loaded.rootCanvasId, types: [...serverNodeTypes(), ...REMOVED_BUTTON_TYPES.map(legacyType)] })
  workspace.store.transact(
    'load',
    (tx) => {
      for (const record of loaded.records as unknown as WorkspaceRecord[]) tx.put(workspace.upgrade(record))
    },
    { history: 'ignore', source: 'remote' },
  )
  const tx = workspace.store.begin('remove buttons', { history: 'ignore', source: 'user' })
  try {
    for (const id of nodeIds) if (tx.get(id)) tx.remove(id)
    return tx.commit()
  } catch (error) {
    if (!tx.isDone) tx.cancel()
    throw error
  }
}
