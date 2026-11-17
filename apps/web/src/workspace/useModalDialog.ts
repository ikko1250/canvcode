import { useLayoutEffect, useRef, type RefObject } from 'react'

// モーダルのダイアログ（背後に暗い面があり、閉じるまでダイアログの中しか操作できないもの）のフォーカスとキー（MAI-108）。
// 確認のダイアログ（ConfirmDialog.tsx）と、CSV からグラフを作るダイアログ（plot/PlotDialog.tsx）で使う。
// - 開いたら initialFocus の要素（なければダイアログ自体）にフォーカスを移す
// - 閉じたら、開く前にフォーカスのあった要素へ戻す。ただし、閉じるときに呼んだ側がフォーカスをダイアログの外へ移していたら、
//   そちらを優先して戻さない（グラフのダイアログを閉じてキャンバスにフォーカスを移すときなど）
// - Tab / Shift+Tab はダイアログの中で回り、外へは出ない（最後の次は最初へ、最初の前は最後へ）
// - キーは window の capture で受け、Tab 以外は onKeyDown に渡す。表示される前に登録する（useEffect だと、
//   表示の直後に押されたキーがキャンバスまで届くことがある）
// - ダイアログが重なったときは、いちばん上（あとから開いたもの）だけがキーを受ける
// - openKey が変わったら、閉じて開き直したものとして扱う（同じダイアログのまま、別のことを尋ねるとき）

export interface ModalDialogOptions {
  initialFocus?(): HTMLElement | null
  onKeyDown?(e: KeyboardEvent): void
}

// 開いているモーダルのダイアログ。最後のものがいちばん上
const openDialogs: object[] = []

// Tab で移れる要素（見えていて、使えるもの）
const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]'

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && !el.closest('[inert]') && el.getClientRects().length > 0,
  )
}

// Tab / Shift+Tab をダイアログの中で回す。端でなければ、ブラウザの順に任せる（ダイアログの中の次の要素へ移る）
function trapTab(e: KeyboardEvent, root: HTMLElement): void {
  const items = focusables(root)
  const active = document.activeElement
  const inside = active instanceof Node && root.contains(active)
  const first = items[0]
  const last = items[items.length - 1]
  let next: HTMLElement | undefined
  if (!first || !last) next = root
  else if (e.shiftKey) next = !inside || active === first || active === root ? last : undefined
  else next = !inside || active === last ? first : undefined
  if (!next) return
  e.preventDefault()
  e.stopPropagation()
  next.focus({ preventScroll: true })
}

export function useModalDialog(ref: RefObject<HTMLElement | null>, options: ModalDialogOptions, openKey?: unknown): void {
  // 毎回の描画で変わる関数を、登録し直さずに呼べるようにする
  const latest = useRef(options)
  useLayoutEffect(() => {
    latest.current = options
  })
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const previous = document.activeElement
    const self = {}
    openDialogs.push(self)
    ;(latest.current.initialFocus?.() ?? root).focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== self || e.isComposing) return
      if (e.key === 'Tab') trapTab(e, root)
      else latest.current.onKeyDown?.(e)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      openDialogs.splice(openDialogs.indexOf(self), 1)
      // （ここではまだダイアログは画面にある）
      const active = document.activeElement
      const lost = !active || active === document.body || root.contains(active)
      if (lost && previous instanceof HTMLElement && previous !== document.body && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [ref, openKey])
}
