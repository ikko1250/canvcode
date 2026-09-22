// 日本語 IME 入力中のショートカット誤発火を防ぐ（MAI-12）。
// 旧実装（recursive-infinite-canvas）の imeGuard.ts を流用している。
// IME で変換している間・変換を確定した直後の Enter・keyCode 229 / 'Process' をすべて IME 由来として扱う。

let lastCompositionEndTime = 0
// 変換を確定した入力欄。確定直後の Enter の対策は、この入力欄で押された Enter だけに当てる
let lastCompositionTarget: EventTarget | null = null
let isGloballyComposing = false

if (typeof window !== 'undefined') {
  window.addEventListener(
    'compositionstart',
    () => {
      isGloballyComposing = true
    },
    { capture: true },
  )
  window.addEventListener(
    'compositionend',
    (e) => {
      isGloballyComposing = false
      lastCompositionEndTime = performance.now()
      lastCompositionTarget = e.target
    },
    { capture: true },
  )
  // 変換の途中で入力欄が消えたり、フォーカスが外れたりすると、compositionend が届かないことがある。
  // そのままだと「変換中」のままになり、ショートカットがすべて効かなくなるので、ここで戻す
  window.addEventListener(
    'focusout',
    () => {
      isGloballyComposing = false
    },
    { capture: true },
  )
}

export function isImeEvent(event: KeyboardEvent, options?: { enterGuardThresholdMs?: number }): boolean {
  const enterGuardThresholdMs = options?.enterGuardThresholdMs ?? 80
  if (event.isComposing) return true
  if (event.keyCode === 229 || event.key === 'Process') return true
  if (isGloballyComposing) return true
  // WebKit では、変換を確定した直後に、同じ入力欄へ Enter の keydown が届くことがある。
  // 別の場所（キャンバスなど）で押された Enter は、確定とは関係ないので対象にしない
  if (
    event.key === 'Enter' &&
    event.target === lastCompositionTarget &&
    performance.now() - lastCompositionEndTime < enterGuardThresholdMs
  ) {
    return true
  }
  return false
}

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tagName = target.tagName.toLowerCase()
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return true
  if (target.isContentEditable) return true
  return Boolean(target.closest('.cm-editor'))
}
