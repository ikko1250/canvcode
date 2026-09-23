import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { Editor, Workspace } from '@canvcode/canvas'

// Canvas・File のレコード（名前・階層・ゴミ箱）が変わったら、描き直す（サイドバーとパンくずリスト。MAI-29、MAI-30）。
// ノードの変更（ドラッグ中など）では描き直さない
export function useWorkspaceVersion(workspace: Workspace): number {
  const version = useRef(0)
  const subscribe = useCallback(
    (onChange: () => void) =>
      workspace.store.listen((event) => {
        for (const change of event.patch.values()) {
          const kind = change.after?.typeName ?? change.before?.typeName
          if (kind === 'canvas' || kind === 'file') {
            version.current++
            onChange()
            return
          }
        }
      }),
    [workspace],
  )
  return useSyncExternalStore(subscribe, () => version.current)
}

// 選んでいるノードのレコードが変わったら、描き直す（パレットに出す文字の大きさ・揃えなど。MAI-52）。
// 編集中に文字の大きさを変えたときも、その場で表示が変わる。選んでいないノードの変更（ほかの人の編集など）では描き直さない
export function useSelectionVersion(editor: Editor): number {
  const version = useRef(0)
  const subscribe = useCallback(
    (onChange: () => void) =>
      editor.store.listen((event) => {
        const { selectedIds } = editor.session.get()
        for (const id of event.patch.keys()) {
          if (selectedIds.has(id)) {
            version.current++
            onChange()
            return
          }
        }
      }),
    [editor],
  )
  return useSyncExternalStore(subscribe, () => version.current)
}
