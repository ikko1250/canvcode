import { useEffect, useRef } from 'react'

// 右クリックメニュー（MAI-12、MAI-29）。項目は呼び出し側が、そのときの選択に合わせて決める
export interface MenuItem {
  label: string
  shortcut?: string
  onSelect(): void
  danger?: boolean
}

export function ContextMenu(props: { x: number; y: number; items: (MenuItem | 'separator')[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return
      if (e instanceof PointerEvent && ref.current?.contains(e.target as Node)) return
      props.onClose()
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', close, true)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', close, true)
      window.removeEventListener('blur', close)
    }
  }, [props])
  // 画面の端からはみ出さないようにする
  const style = { left: Math.min(props.x, window.innerWidth - 240), top: Math.min(props.y, window.innerHeight - 40 * props.items.length) }
  return (
    <div ref={ref} className="context-menu" style={style} onContextMenu={(e) => e.preventDefault()}>
      {props.items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="context-menu-separator" />
        ) : (
          <button
            // 同じ名前の項目（名前の同じキャンバスなど）があってもよいように、位置も含める
            key={`${i}:${item.label}`}
            className={item.danger ? 'danger' : ''}
            onClick={() => {
              props.onClose()
              item.onSelect()
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && <kbd>{item.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>
  )
}
