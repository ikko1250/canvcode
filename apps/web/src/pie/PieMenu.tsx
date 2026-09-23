import { useEffect, useRef, useState } from 'react'
import { isEditableKeyboardTarget, isImeEvent } from '@canvcode/canvas'
import {
  PIE_IDLE,
  cancelPie,
  commitPie,
  hidePie,
  isSubmenu,
  movePie,
  pressPie,
  resolveLevel,
  slicePosition,
  type PieMenuDef,
  type PieState,
} from './pieMenu.ts'

// パイメニュー（MAI-39）。キーを押している間だけ、ポインタの位置に出す。
// 決まりごと（階層の覚え方など）は pieMenu.ts。ここではキーとポインタを受け取って、それを描く

// 項目を並べる輪の半径と、中心を画面の端からどれだけ離すか（CSS ピクセル）
const RADIUS = 100
const EDGE_MARGIN = RADIUS + 60

export function PieMenus(props: { menus: PieMenuDef[]; enabled: boolean }) {
  const [state, setState] = useState<PieState>(PIE_IDLE)
  // キーのハンドラから今の値を読むために、ref にも持つ
  const stateRef = useRef(state)
  const menusRef = useRef(props.menus)
  const enabledRef = useRef(props.enabled)
  useEffect(() => {
    menusRef.current = props.menus
    enabledRef.current = props.enabled
  }, [props.menus, props.enabled])

  useEffect(() => {
    const update = (next: PieState) => {
      stateRef.current = next
      setState(next)
    }
    // 押しているキー（離したことを e.code で知る。Shift などで e.key が変わっても困らないように）
    let pressed: string | null = null
    let pointer: { x: number; y: number } | null = null

    const commit = (keepOpen: boolean) => {
      const { state: next, run } = commitPie(stateRef.current, menusRef.current, { keepOpen })
      update(next)
      run?.onSelect()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 出していれば、キャンバスの Esc（選択の解除など）より先に受け取る
        if (stateRef.current.open) {
          e.preventDefault()
          e.stopPropagation()
        }
        pressed = null
        update(cancelPie(stateRef.current))
        return
      }
      // CapsLock で 'O' になることがあるので、文字のキーは大文字小文字を区別しない（MAI-57）
      const key = e.key.toLowerCase()
      const menu = menusRef.current.find((m) => m.key === key)
      if (!menu || e.ctrlKey || e.metaKey || e.altKey) return
      // 文字を入力しているところ（カードの編集、名前の入力欄など）やダイアログでは、ただの文字として扱う
      if (!enabledRef.current || isImeEvent(e) || isEditableKeyboardTarget(e.target)) return
      if (e.target instanceof Element && e.target.closest('[role="dialog"]')) return
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat || pressed !== null) return
      pressed = e.code
      const at = pointer ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 }
      update(pressPie(stateRef.current, menu.id, clampToViewport(at)))
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (pressed === null || e.code !== pressed) return
      e.preventDefault()
      pressed = null
      commit(false)
    }
    const onPointerMove = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY }
      if (stateRef.current.open) update(movePie(stateRef.current, menusRef.current, pointer))
    }
    // 出している間のクリックは、キャンバスには渡さず、向けている項目を選ぶ（サブメニューなら、出したまま中に入る）
    const onPointerDown = (e: PointerEvent) => {
      if (!stateRef.current.open) return
      e.preventDefault()
      e.stopPropagation()
      pointer = { x: e.clientX, y: e.clientY }
      update(movePie(stateRef.current, menusRef.current, pointer))
      commit(true)
    }
    const onBlur = () => {
      pressed = null
      update(hidePie(stateRef.current))
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('pointermove', onPointerMove, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('pointermove', onPointerMove, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  const menu = state.open && props.menus.find((m) => m.id === state.menuId)
  if (!state.open || !menu) return null
  const { items, trail } = resolveLevel(menu, state.path)
  return (
    <div className="pie-menu" style={{ left: state.open.x, top: state.open.y }} onContextMenu={(e) => e.preventDefault()}>
      <div className="pie-hub">
        {state.highlight !== null && (
          <div className="pie-pointer" style={{ transform: `rotate(${(state.highlight / items.length) * 360}deg)` }} />
        )}
        <span>{[menu.label, ...trail].join(' › ')}</span>
      </div>
      {items.map((entry, i) => {
        const { x, y } = slicePosition(i, items.length, RADIUS)
        // 左右の項目は、中心から外へ向かって伸ばす（長い名前が中心に重ならないように）
        const shiftX = x > 10 ? '-20%' : x < -10 ? '-80%' : '-50%'
        const submenu = isSubmenu(entry)
        const classes = ['pie-item']
        if (i === state.highlight) classes.push('highlight')
        if (!submenu && entry.active) classes.push('active')
        if (!submenu && entry.disabled) classes.push('disabled')
        return (
          <div key={i} className={classes.join(' ')} style={{ left: x, top: y, transform: `translate(${shiftX}, -50%)` }}>
            {entry.label}
            {submenu && <span className="pie-more">›</span>}
          </div>
        )
      })}
    </div>
  )
}

function clampToViewport(at: { x: number; y: number }): { x: number; y: number } {
  const clamp = (v: number, size: number) => (size <= EDGE_MARGIN * 2 ? size / 2 : Math.min(Math.max(v, EDGE_MARGIN), size - EDGE_MARGIN))
  return { x: clamp(at.x, window.innerWidth), y: clamp(at.y, window.innerHeight) }
}
