import { useId, useRef } from 'react'
import { useModalDialog } from './useModalDialog.ts'

// 確認のダイアログ（MAI-108）。選択肢の最初のものが主な選択肢で、右端に出す（右ほど重要。「やめる」は左端）。
// - Enter は、フォーカスのあるボタンを押したことにする。ボタンにフォーカスがなければ何もしない
//   （どれを選ぶか見えないまま選ばない）。押し続けた Enter（キーのリピート）と、修飾キー付きの Enter でも選ばない
// - 初めのフォーカスは主な選択肢。危ない選択肢（danger）が 1 つでもあれば「やめる」にする（うっかり Enter で消さない）
// - Esc か、背後の暗い所を押すとやめる（null）
// - フォーカスの扱い（外へ出ない・閉じたら戻す）は useModalDialog
export interface DialogChoice<T> {
  label: string
  value: T
  danger?: boolean
}

export function ConfirmDialog<T>(props: {
  title: string
  message: string
  choices: DialogChoice<T>[]
  onChoose(value: T | null): void
}) {
  const { choices, onChoose } = props
  const rootRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const id = useId()
  const cautious = choices.some((choice) => choice.danger)
  // 新しく尋ねると（choices が変わると）、初めのフォーカスから始め直す
  useModalDialog(
    rootRef,
    {
      initialFocus: () => (cautious ? cancelRef.current : primaryRef.current),
      onKeyDown: (e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onChoose(null)
        } else if (e.key === 'Enter') {
          // ボタンの既定の動き（押す）にも任せず、ここで押す。キャンバスにも渡さない
          e.preventDefault()
          e.stopPropagation()
          const button = document.activeElement
          if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
          if (button instanceof HTMLButtonElement && !button.disabled && rootRef.current?.contains(button)) button.click()
        }
      },
    },
    choices,
  )
  return (
    <div className="dialog-backdrop" onPointerDown={() => onChoose(null)}>
      <div
        ref={rootRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-message`}
        // 本文などを押しても、フォーカスがダイアログの外（ページ）へ移らないように
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h2 id={`${id}-title`}>{props.title}</h2>
        <p id={`${id}-message`}>{props.message}</p>
        <div className="dialog-buttons">
          <button ref={cancelRef} type="button" className="dialog-cancel" onClick={() => onChoose(null)}>
            やめる
          </button>
          {choices
            .map((choice, i) => (
              <button
                key={choice.label}
                ref={i === 0 ? primaryRef : undefined}
                type="button"
                className={[i === 0 ? 'primary' : '', choice.danger ? 'danger' : ''].join(' ')}
                onClick={() => onChoose(choice.value)}
              >
                {choice.label}
              </button>
            ))
            .reverse()}
        </div>
      </div>
    </div>
  )
}
