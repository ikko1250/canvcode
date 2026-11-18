import { useEffect, useState } from 'react'
import type { Editor } from '@canvcode/canvas'

// Canvas のノードが変わるたびに増える数（変わったら描き直す部品で使う。付箋の答えが届いた・付箋が消えたなど）
export function useNodesVersion(editor: Editor): number {
  const [version, setVersion] = useState(0)
  useEffect(() => editor.store.listen(() => setVersion((v) => v + 1)), [editor])
  return version
}
