import { useEffect, useLayoutEffect, useRef } from 'react'

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
  // 画面の端からはみ出さないようにする。メニューの幅と高さは項目の名前と数で変わるので、描いたあと（画面に出す前）に測って寄せる
  // （MAI-112。もとは幅 240px・項目ごとに 40px と見積もっていたが、文字を 14px にして、240px より広いメニューができた）
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const { width, height } = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(0, Math.min(props.x, window.innerWidth - width))}px`
    menu.style.top = `${Math.max(0, Math.min(props.y, window.innerHeight - height))}px`
  })
  return (
    <div ref={ref} className="context-menu" onContextMenu={(e) => e.preventDefault()}>
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
