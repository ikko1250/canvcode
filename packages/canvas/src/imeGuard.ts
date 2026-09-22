// 日本語 IME 入力中のショートカット誤発火を防ぐ（MAI-12）。
// 旧実装（recursive-infinite-canvas）の imeGuard.ts を流用している。
// IME で変換している間・変換を確定した直後の Enter・keyCode 229 / 'Process' をすべて IME 由来として扱う。

let lastCompositionEndTime = 0
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
    () => {
      isGloballyComposing = false
      lastCompositionEndTime = performance.now()
    },
    { capture: true },
  )
}

export function isImeEvent(event: KeyboardEvent, options?: { enterGuardThresholdMs?: number }): boolean {
  const enterGuardThresholdMs = options?.enterGuardThresholdMs ?? 80
  if (event.isComposing) return true
  if (event.keyCode === 229 || event.key === 'Process') return true
  if (isGloballyComposing) return true
  // WebKit では、変換を確定した直後に Enter の keydown が届くことがある
  if (event.key === 'Enter' && performance.now() - lastCompositionEndTime < enterGuardThresholdMs) {
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
