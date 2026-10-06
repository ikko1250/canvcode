import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isDocumentRecord, isFileRecord, type DocumentRecord, type FileRecord, type Patch, type WorkspaceRecord } from '@canvcode/core'
import { Workspace } from '@canvcode/canvas/workspace'
import { defineNodeType, type AnyNodeTypeDef } from '@canvcode/nodes'
import { serverNodeTypes } from './agent/host.ts'
import { titleOf } from './files.ts'
import type { RecordStore, StoredRecord } from './records.ts'

// v1 のスライド（デッキのエディタ・slide-deck-card・slide-page・提案 B の図）を消したあとの、保存済みのデータの一度きりの片付け。
// サーバーの起動時に呼ぶ。片付けるものがなければ何もしない（何度呼んでもよい）。
// - slide-deck-card と slide-page のノードを消す。消し方はブラウザの削除と同じ（サーバーの中の Workspace のフックを通す）：
//   子孫も消し、つながっている矢印は端をその場に固定して Binding を外し、子がいなくなった group も消す。
//   消したデッキのカードが持ち主だった File は、持ち主を消したときの既定（'unplace'）と同じく持ち主を外す（ゴミ箱の中の File はゴミ箱に残る）。
//   型はもう無いので、箱と参照先だけを持つ代わりの型（legacyType）を Workspace に渡す
// - kind が slides の File：.slide.md は Markdown として扱う（kind と名前を直す）。.slide.json は扱わないので、レコードを消す。
//   実ファイルは消さない
// - ゴミ箱のまとまりの根が、消した型の持ち主の写し（trash.portal）を持っていれば外す（元に戻すと未配置に戻る）
// - AI の編集の記録のうち、消した型のノードを含むものを消す（取り消しで、そのノードを戻さないように）
// - v1 のキャッシュ（.canvcode/slide-pages/ のスライドの画像と、.canvcode/figures/ の図の画像）を消す
// レコードを変えるときは、先に workspace.db の写しを作る（移行と同じ。records.ts の migrate）

export const SLIDES_V1_NODE_TYPES: readonly string[] = ['slide-deck-card', 'slide-page']
const SLIDES_V1_DIRS = ['slide-pages', 'figures']

export interface SlidesV1Cleanup {
  // 消したノード（子孫も含む）と、外した Binding
  removedNodes: number
  removedBindings: number
  // 持ち主のカードを外した File
  unplacedFiles: number
  // Markdown にした File・レコードを消した File（.slide.json）
  markdownFiles: number
  removedFiles: number
  // trash.portal を外したゴミ箱のまとまりの根
  trashPortals: number
  removedAgentOps: number
  removedDirs: string[]
  // 片付ける前の workspace.db の写し（レコードを変えなければ null）
  backup: string | null
  rev: number | null
}

export async function cleanupSlidesV1(records: RecordStore, dataDir: string): Promise<SlidesV1Cleanup | null> {
  const nodeIds = records.nodeIdsOfTypes(SLIDES_V1_NODE_TYPES)
  const documents = [...records.ofTypeName('canvas'), ...records.ofTypeName('file')] as unknown as DocumentRecord[]
  const slideFiles = documents.filter((doc): doc is FileRecord => isFileRecord(doc) && (doc.kind as string) === 'slides')
  const trashPortals = documents.filter((doc) => doc.trash?.portal && SLIDES_V1_NODE_TYPES.includes(doc.trash.portal.type))
  const dirs: string[] = []
  for (const name of SLIDES_V1_DIRS) if (await exists(join(dataDir, name))) dirs.push(name)

  const result: SlidesV1Cleanup = {
    removedNodes: 0,
    removedBindings: 0,
    unplacedFiles: 0,
    markdownFiles: 0,
    removedFiles: 0,
    trashPortals: trashPortals.length,
    removedAgentOps: 0,
    removedDirs: dirs,
    backup: null,
    rev: null,
  }
  const changesRecords = nodeIds.length > 0 || slideFiles.length > 0 || trashPortals.length > 0
  if (changesRecords) {
    const patch = removeInWorkspace(records, nodeIds, result)
    const puts: StoredRecord[] = []
    const deletes: string[] = []
    for (const [id, change] of patch) {
      if (change.after) puts.push(change.after as unknown as StoredRecord)
      else if (change.before) deletes.push(id)
    }
    result.removedNodes = deletes.filter((id) => id.startsWith('node:')).length
    result.removedBindings = deletes.filter((id) => id.startsWith('binding:')).length
    result.backup = `${records.path}.before-slides-v1-removal-${Date.now()}.bak`
    records.snapshot(result.backup)
    result.rev = records.apply(puts, deletes)
  }
  result.removedAgentOps = records.deleteAgentOpsWithNodeTypes(SLIDES_V1_NODE_TYPES)
  for (const name of dirs) await rm(join(dataDir, name), { recursive: true, force: true })
  if (!changesRecords && result.removedAgentOps === 0 && dirs.length === 0) return null
  return result
}

// 片付けたことのログの文
export function describeSlidesV1Cleanup(result: SlidesV1Cleanup): string {
  const parts = [
    `ノード ${result.removedNodes} 個（Binding ${result.removedBindings} 個）を消した`,
    `File ${result.markdownFiles} 個を Markdown にした`,
  ]
  if (result.removedFiles > 0) parts.push(`.slide.json の File ${result.removedFiles} 個を一覧から外した`)
  if (result.unplacedFiles > 0) parts.push(`File ${result.unplacedFiles} 個からデッキのカード（持ち主）を外した`)
  if (result.trashPortals > 0) parts.push(`ゴミ箱の ${result.trashPortals} 個から消した型の持ち主の写しを外した`)
  if (result.removedAgentOps > 0) parts.push(`AI の編集の記録 ${result.removedAgentOps} 件を消した`)
  if (result.removedDirs.length > 0) parts.push(`キャッシュ（${result.removedDirs.map((name) => `.canvcode/${name}/`).join('・')}）を消した`)
  return `v1 のスライドを片付けた：${parts.join('、')}${result.backup ? `。片付ける前の写し：${result.backup}` : ''}`
}

// 消した型の代わりに、箱（props の w・h）と、デッキのカードの参照先（持ち主の File）だけを持つ型。描かない。
// 片付けの Workspace で、つながっている矢印の端を求め、持ち主を消したときの File の扱いをフックに任せるために使う
function legacyType(type: string): AnyNodeTypeDef {
  return defineNodeType<{ w?: unknown; h?: unknown; fileId?: unknown; role?: unknown }>({
    type,
    version: 1,
    defaultProps: () => ({}),
    getBounds: (node) => ({ x: 0, y: 0, w: Number(node.props.w) || 0, h: Number(node.props.h) || 0 }),
    hitTest: () => false,
    render: () => {},
    reference: (node) =>
      type === 'slide-deck-card' && typeof node.props.fileId === 'string' && node.props.fileId
        ? { targetId: node.props.fileId, role: node.props.role === 'shortcut' ? 'shortcut' : 'owner' }
        : null,
  })
}

// 全レコードをサーバーの中の Workspace に読み、ブラウザの削除と同じフックを通して 1 つのトランザクションで片付け、その差分を返す
function removeInWorkspace(records: RecordStore, nodeIds: string[], result: SlidesV1Cleanup): Patch<WorkspaceRecord> {
  const loaded = records.load()
  const workspace = new Workspace({ rootCanvasId: loaded.rootCanvasId, types: [...serverNodeTypes(), ...SLIDES_V1_NODE_TYPES.map(legacyType)] })
  workspace.store.transact(
    'load',
    (tx) => {
      for (const record of loaded.records as unknown as WorkspaceRecord[]) tx.put(workspace.upgrade(record))
    },
    { history: 'ignore', source: 'remote' },
  )
  // 片付ける前の持ち主（Canvas・File の id → 持ち主のノードの id）
  const owners = new Map<string, string>()
  for (const record of workspace.store.values()) if (isDocumentRecord(record) && record.ownerNodeId) owners.set(record.id, record.ownerNodeId)
  const tx = workspace.store.begin('remove slides v1', { history: 'ignore', source: 'user' })
  try {
    const now = Date.now()
    const removed = new Set(nodeIds)
    for (const id of nodeIds) if (tx.get(id)) tx.remove(id)
    for (const record of [...workspace.store.values()]) {
      if (!isDocumentRecord(record)) continue
      let next: DocumentRecord = record
      // 消したデッキのカードが持ち主だったもの（持ち主はフックが外した）を数える
      const owner = owners.get(record.id)
      if (owner && removed.has(owner) && next.ownerNodeId === null) result.unplacedFiles++
      if (next.trash?.portal && SLIDES_V1_NODE_TYPES.includes(next.trash.portal.type)) {
        next = { ...next, trash: { ...next.trash, portal: null } }
      }
      if (isFileRecord(next) && (next.kind as string) === 'slides') {
        if (!next.path.toLowerCase().endsWith('.md')) {
          tx.remove(next.id)
          result.removedFiles++
          continue
        }
        next = { ...next, kind: 'markdown', title: titleOf(next.path), updatedAt: now }
        result.markdownFiles++
      }
      if (next !== record) tx.put(next)
    }
    return tx.commit()
  } catch (error) {
    if (!tx.isDone) tx.cancel()
    throw error
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}
