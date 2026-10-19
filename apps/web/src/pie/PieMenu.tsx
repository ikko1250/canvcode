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
  type PieEntry,
  type PieMenuDef,
  type PieState,
} from './pieMenu.ts'

// パイメニュー（MAI-39）。キーを押している間だけ、ポインタの位置に出す。
// 決まりごと（階層の覚え方など）は pieMenu.ts。ここではキーとポインタを受け取って、それを描く。
// キーボードのない端末（スマホ）向けに、メニューごとのボタンを左下に出す（buttons。指で触れたことがあるか、
// 粗いポインタのある端末だけ）。ボタンを押すとそのメニューを出し、指をずらした向きの項目を選んで、離すと実行する。
// サブメニューで離すと、そのサブメニューを出したままにする（項目を叩くか、また中心からずらして選ぶ）。
// ボタンを叩いただけなら出したままにして、項目を叩いて選ぶ

// 項目を並べる輪の半径と、中心を画面の端からどれだけ離すか（CSS ピクセル）
const RADIUS = 100
const EDGE_MARGIN = RADIUS + 60
// ボタンからこれだけ指をずらしたら、叩いたのではなく、ずらして選んだとみなす
const DRAG_SLOP = 8

// onOpen：出すときに、開いた位置（ポインタの位置。画面の端に寄せる前の、ウィンドウの座標）を知らせる。
// その位置にものを置く項目（図形 › スライドなど）が使う。
// menusAt：開く位置で項目が変わるとき（表のカードの列など）に、キーを押したときの位置のメニューを作る
// （次の描画を待つと、その位置にしかない項目が出ず、項目のないメニューは出さないので）
export function PieMenus(props: {
  menus: PieMenuDef[]
  enabled: boolean
  onOpen?: (at: { x: number; y: number }) => void
  menusAt?: (at: { x: number; y: number }) => PieMenuDef[]
  // 左下に出すボタン（メニューの id と名前）
  buttons?: { id: string; label: string }[]
}) {
  const [state, setState] = useState<PieState>(PIE_IDLE)
  const touchUi = useTouchUi()
  // キーのハンドラから今の値を読むために、ref にも持つ
  const stateRef = useRef(state)
  const menusRef = useRef(props.menus)
  const enabledRef = useRef(props.enabled)
  const onOpenRef = useRef(props.onOpen)
  const menusAtRef = useRef(props.menusAt)
  useEffect(() => {
    menusRef.current = props.menus
    enabledRef.current = props.enabled
    onOpenRef.current = props.onOpen
    menusAtRef.current = props.menusAt
  }, [props.menus, props.enabled, props.onOpen, props.menusAt])

  useEffect(() => {
    const update = (next: PieState) => {
      stateRef.current = next
      setState(next)
    }
    // 押しているキー（離したことを e.code で知る。Shift などで e.key が変わっても困らないように）
    let pressed: string | null = null
    let pointer: { x: number; y: number } | null = null
    // ボタンでメニューを開いた位置にする、キャンバスで最後に触れた（押した）位置
    let canvasPointer: { x: number; y: number } | null = null
    // ボタン（または出している中心の近く）から指をずらして選んでいる最中：その指と、押し始めた位置
    // fromHub：出している中心の近くから始めた（ずらさずに離したら消す）
    let drag: { id: number; start: { x: number; y: number }; moved: boolean; fromHub?: boolean } | null = null

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
      if (e.ctrlKey || e.metaKey || e.altKey) return
      // 文字を入力しているところ（カードの編集、名前の入力欄など）やダイアログでは、ただの文字として扱う
      if (!enabledRef.current || isImeEvent(e) || isEditableKeyboardTarget(e.target)) return
      if (e.target instanceof Element && e.target.closest('[role="dialog"]')) return
      const at = pointer ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 }
      // 出していないときは、押した位置のメニューにする（出している間は、そのまま）
      if (!stateRef.current.open && pressed === null && menusAtRef.current) menusRef.current = menusAtRef.current(at)
      const menu = menusRef.current.find((m) => m.key === key)
      if (!menu) return
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat || pressed !== null) return
      pressed = e.code
      if (!stateRef.current.open) onOpenRef.current?.(at)
      update(pressPie(stateRef.current, menu.id, clampToViewport(at)))
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (pressed === null || e.code !== pressed) return
      e.preventDefault()
      pressed = null
      commit(false)
    }
    const onPointerMove = (e: PointerEvent) => {
      const open = stateRef.current.open
      if (drag && e.pointerId === drag.id && open) {
        // 押し始めた位置からずらした向きで選ぶ（指の位置そのものではなく、中心からその分だけずらした位置）
        const dx = e.clientX - drag.start.x
        const dy = e.clientY - drag.start.y
        if (Math.hypot(dx, dy) >= DRAG_SLOP) drag.moved = true
        update(movePie(stateRef.current, menusRef.current, { x: open.x + dx, y: open.y + dy }))
        return
      }
      pointer = { x: e.clientX, y: e.clientY }
      if (stateRef.current.open) update(movePie(stateRef.current, menusRef.current, pointer))
    }
    // 出している間のクリックは、キャンバスには渡さず、向けている項目を選ぶ（サブメニューなら、出したまま中に入る）
    const onPointerDown = (e: PointerEvent) => {
      const button = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-pie-button]') : null
      if (button) {
        e.preventDefault()
        e.stopPropagation()
        openFromButton(e, button)
        return
      }
      if (!stateRef.current.open) {
        canvasPointer = { x: e.clientX, y: e.clientY }
        return
      }
      e.preventDefault()
      e.stopPropagation()
      pointer = { x: e.clientX, y: e.clientY }
      if (e.pointerType !== 'mouse') {
        const open = stateRef.current.open
        // 指で輪から遠くを叩いたら、何も選ばずに消す（階層は覚えたまま）
        if (Math.hypot(pointer.x - open.x, pointer.y - open.y) > RADIUS * 2) {
          update(hidePie(stateRef.current))
          return
        }
        update(movePie(stateRef.current, menusRef.current, pointer))
        // 中心の近くに触れたら、そこからずらして選べるようにする
        if (stateRef.current.highlight === null) {
          drag = { id: e.pointerId, start: pointer, moved: false, fromHub: true }
          return
        }
        commit(true)
        return
      }
      update(movePie(stateRef.current, menusRef.current, pointer))
      commit(true)
    }
    const openFromButton = (e: PointerEvent, button: HTMLElement) => {
      const id = button.dataset.pieButton
      const shown = stateRef.current.open ? stateRef.current.menuId : null
      drag = null
      // 出しているときにボタンを押したら、いったん消す（同じボタンなら消すだけ）
      if (shown) update(hidePie(stateRef.current))
      if (shown === id || !enabledRef.current) return
      const at = canvasPointer ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 }
      if (menusAtRef.current) menusRef.current = menusAtRef.current(at)
      const menu = menusRef.current.find((m) => m.id === id)
      if (!menu) return
      pressed = null
      onOpenRef.current?.(at)
      // 輪の下の項目がボタンに重ならないよう、ボタンより上に出す
      const rect = button.getBoundingClientRect()
      update(pressPie(stateRef.current, menu.id, clampToViewport({ x: rect.left + rect.width / 2, y: rect.top - RADIUS - 40 })))
      drag = { id: e.pointerId, start: { x: e.clientX, y: e.clientY }, moved: false }
    }
    const onPointerUp = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return
      const { moved, fromHub } = drag
      drag = null
      if (!stateRef.current.open) return
      e.preventDefault()
      e.stopPropagation()
      if (e.type === 'pointercancel') return update(hidePie(stateRef.current))
      // ボタンを叩いただけなら出したまま（項目を叩いて選ぶ）。ずらしたなら、選んでいる項目を実行する（サブメニューなら出したまま中に入る）。
      // 何も選んでいなければ消す
      if (moved || fromHub) commit(true)
    }
    const onBlur = () => {
      pressed = null
      drag = null
      update(hidePie(stateRef.current))
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('pointermove', onPointerMove, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('pointermove', onPointerMove, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', onPointerUp, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  const menu = state.open && props.menus.find((m) => m.id === state.menuId)
  const buttons = touchUi && props.enabled && props.buttons && (
    <div className="pie-buttons" onContextMenu={(e) => e.preventDefault()}>
      {props.buttons.map((b) => (
        <button key={b.id} type="button" data-pie-button={b.id} className={state.open && state.menuId === b.id ? 'open' : undefined}>
          {b.label}
        </button>
      ))}
    </div>
  )
  const level = menu ? resolveLevel(menu, state.path) : null
  return (
    <>
      {buttons}
      {state.open && menu && level && (
        <PieRing open={state.open} label={menu.label} highlight={state.highlight} items={level.items} trail={level.trail} />
      )}
    </>
  )
}

function PieRing({ open, label, highlight, items, trail }: {
  open: { x: number; y: number }
  label: string
  highlight: number | null
  items: PieEntry[]
  trail: string[]
}) {
  return (
    <div className="pie-menu" style={{ left: open.x, top: open.y }} onContextMenu={(e) => e.preventDefault()}>
      <div className="pie-hub">
        {highlight !== null && (
          <div className="pie-pointer" style={{ transform: `rotate(${(highlight / items.length) * 360}deg)` }} />
        )}
        <span>{[label, ...trail].join(' › ')}</span>
      </div>
      {items.map((entry, i) => {
        const { x, y } = slicePosition(i, items.length, RADIUS)
        // 左右の項目は、中心から外へ向かって伸ばす（長い名前が中心に重ならないように）
        const shiftX = x > 10 ? '-20%' : x < -10 ? '-80%' : '-50%'
        const submenu = isSubmenu(entry)
        const classes = ['pie-item']
        if (i === highlight) classes.push('highlight')
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

// 指で触れたことがあるか、粗いポインタ（指）のある端末か
function useTouchUi(): boolean {
  const [touch, setTouch] = useState(() => typeof matchMedia === 'function' && matchMedia('(any-pointer: coarse)').matches)
  useEffect(() => {
    if (touch) return
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch') setTouch(true)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [touch])
  return touch
}

function clampToViewport(at: { x: number; y: number }): { x: number; y: number } {
  const clamp = (v: number, size: number) => (size <= EDGE_MARGIN * 2 ? size / 2 : Math.min(Math.max(v, EDGE_MARGIN), size - EDGE_MARGIN))
  return { x: clamp(at.x, window.innerWidth), y: clamp(at.y, window.innerHeight) }
}
