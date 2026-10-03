import type { Patch, WorkspaceRecord } from '@canvcode/core'
import { builtinNodeTypes, createCodeCardType, createSlideDeckCardType, createSlidePageType, type AnyNodeTypeDef } from '@canvcode/nodes'
import { createMarkdownCardType } from '@canvcode/nodes/markdown'
import { Editor } from '@canvcode/canvas/editor'
import { Workspace } from '@canvcode/canvas/workspace'
import type { FileStore } from '../files.ts'
import type { RecordStore } from '../records.ts'
import type { ChangeListener, SyncHub } from '../sync.ts'

// AI の編集（MCP の edit_canvas）に使う、サーバーの中のワークスペース。
// - ブラウザと同じ Workspace と Editor を使い、ストアのフック（矢印の端・空の group・持ち主とゴミ箱）をそのまま働かせる
// - 最初に編集を頼まれたときに RecordStore から作り、使っている間は SyncHub の変更（ブラウザからの保存など）を当て続ける
// - しばらく（既定 10 分）使わなければ捨てる（次に頼まれたら作り直す）
// - 文字は測れない（OffscreenCanvas がない）ので、テキストの幅は見積もりになる。AI が作るテキストは幅を決めて折り返す
// - カード（Markdown・コード・スライドデッキ）の高さは本文を読まないので、レコードに残っている高さを使う

export const HOST_IDLE_MS = 10 * 60_000
// 同時に持っておく Canvas ごとの Editor の数（空間の索引を持つので、多くは持たない）
const MAX_EDITORS = 8

export interface AgentHostDeps {
  records: RecordStore
  sync?: SyncHub
  files?: FileStore
  idleMs?: number
}

interface HostState {
  workspace: Workspace
  editors: Map<string, Editor>
  unlisten: () => void
}

// サーバーで使うノードの型。描画と計測に使うものは、何もしないものを渡す
function serverNodeTypes(): AnyNodeTypeDef[] {
  const noFiles = { get: () => null }
  return [
    ...builtinNodeTypes,
    createMarkdownCardType({ embedCss: async () => '', measureCss: '', files: noFiles }) as AnyNodeTypeDef,
    createCodeCardType({ files: noFiles }) as AnyNodeTypeDef,
    createSlideDeckCardType(noFiles) as AnyNodeTypeDef,
    createSlidePageType({ load: () => Promise.reject(new Error('no images on the server')) }) as AnyNodeTypeDef,
  ]
}

export class AgentHost {
  readonly records: RecordStore
  readonly sync: SyncHub | undefined
  readonly files: FileStore | undefined
  private readonly idleMs: number
  private state: HostState | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  // SyncHub から届く変更（自分で保存した変更は、broadcast の except で除く）
  readonly listener: ChangeListener = (records, deleted) => this.applyRemote(records as WorkspaceRecord[], deleted)

  constructor(deps: AgentHostDeps) {
    this.records = deps.records
    this.sync = deps.sync
    this.files = deps.files
    this.idleMs = deps.idleMs ?? HOST_IDLE_MS
  }

  get alive(): boolean {
    return this.state !== null
  }

  // ワークスペース（なければ RecordStore から作る）。呼ぶたびに、捨てるまでの時間を延ばす
  workspace(): Workspace {
    this.touch()
    if (this.state) return this.state.workspace
    const loaded = this.records.load()
    const workspace = new Workspace({ rootCanvasId: loaded.rootCanvasId, types: serverNodeTypes() })
    // ブラウザの SyncClient と同じく、履歴に入れず、フックも通さずに当てる。古い版のノードは今の形にする
    workspace.store.transact(
      'load',
      (tx) => {
        for (const record of loaded.records as unknown as WorkspaceRecord[]) tx.put(workspace.upgrade(record))
      },
      { history: 'ignore', source: 'remote' },
    )
    const unlisten = this.sync?.onChange(this.listener) ?? (() => {})
    this.state = { workspace, editors: new Map(), unlisten }
    return workspace
  }

  // Canvas の Editor（空間の索引）。古いものから捨てる
  editor(canvasId: string): Editor {
    const workspace = this.workspace()
    const editors = this.state!.editors
    let editor = editors.get(canvasId)
    if (editor) {
      editors.delete(canvasId)
    } else {
      editor = new Editor({ workspace, canvasId })
      if (editors.size >= MAX_EDITORS) {
        const [oldestId, oldest] = editors.entries().next().value!
        oldest.dispose()
        editors.delete(oldestId)
      }
    }
    editors.set(canvasId, editor)
    return editor
  }

  // ほかから保存された変更を当てる（作っていなければ何もしない。次に作るときに読む）
  applyRemote(records: WorkspaceRecord[], deleted: string[]): void {
    const workspace = this.state?.workspace
    if (!workspace || (records.length === 0 && deleted.length === 0)) return
    workspace.store.transact(
      'remote',
      (tx) => {
        for (const record of records) tx.put(workspace.upgrade(record))
        for (const id of deleted) tx.remove(id)
      },
      { history: 'ignore', source: 'remote' },
    )
  }

  // 確定したが保存できなかった変更を、ワークスペースから戻す
  revert(patch: Patch<WorkspaceRecord>): void {
    const workspace = this.state?.workspace
    if (!workspace || patch.size === 0) return
    workspace.store.transact(
      'revert',
      (tx) => {
        for (const [id, change] of patch) {
          if (change.before) tx.put(change.before)
          else tx.remove(id)
        }
      },
      { history: 'ignore', source: 'remote' },
    )
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (!this.state) return
    this.state.unlisten()
    for (const editor of this.state.editors.values()) editor.dispose()
    this.state = null
  }

  private touch(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.dispose(), this.idleMs)
    this.timer.unref?.()
  }
}
