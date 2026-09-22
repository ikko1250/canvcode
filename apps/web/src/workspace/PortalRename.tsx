import { useRef, useState } from 'react'
import { PORTAL_HEADER, TEXT_FONT_FAMILY } from '@canvcode/nodes'

// Portal やカードの名前の帯に重ねる入力欄（右クリックメニューの「名前を変更」。MAI-29、MAI-30）。
// 変えるのは参照先の Canvas・File の名前（Portal やカードは名前のコピーを持たない）
export interface PortalRenameTarget {
  documentId: string
  title: string
  // 名前の帯の寸法（ワールド座標）。既定は Portal のもの
  header?: { height: number; padding: number; fontSize: number }
  // 名前の帯の位置（キャンバスの要素に対する画面の座標）と、倍率
  x: number
  y: number
  width: number
  zoom: number
}

export function PortalRename(props: { target: PortalRenameTarget; onCommit(title: string): void; onCancel(): void }) {
  const { target } = props
  const [value, setValue] = useState(target.title)
  // 閉じると blur も起きるので、2 回目は何もしない（Esc のあとの blur で確定してしまわないように）。
  // 同じイベントの中で読むので、state ではなく ref で持つ
  const done = useRef(false)
  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    const title = value.trim()
    if (commit && title && title !== target.title) props.onCommit(title)
    else props.onCancel()
  }
  // 小さく表示しているときでも入力しやすいよう、文字は 12px より小さくしない
  const header = target.header ?? PORTAL_HEADER
  const scale = Math.max(target.zoom, 12 / header.fontSize)
  return (
    <input
      className="portal-rename"
      autoFocus
      value={value}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        // IME で変換を確定する Enter では、名前を確定しない
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter') finish(true)
        if (e.key === 'Escape') finish(false)
      }}
      style={{
        left: target.x,
        top: target.y,
        width: Math.max(target.width, 120),
        height: header.height * scale,
        padding: `0 ${header.padding * scale}px`,
        font: `500 ${header.fontSize * scale}px ${TEXT_FONT_FAMILY}`,
      }}
    />
  )
}
