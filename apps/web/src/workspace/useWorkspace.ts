import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { Workspace } from '@canvcode/canvas'

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
