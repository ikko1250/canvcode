import { useLayoutEffect } from 'react'

// 確認のダイアログ。選択肢の最初のものが既定（Enter）。Esc はやめる
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
  // 表示される前に登録する（useEffect だと、表示の直後に押された Enter がキャンバスまで届くことがある）
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onChoose(null)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        onChoose(choices[0].value)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [choices, onChoose])
  return (
    <div className="dialog-backdrop" onPointerDown={() => onChoose(null)}>
      <div className="dialog" role="dialog" aria-label={props.title} onPointerDown={(e) => e.stopPropagation()}>
        <h2>{props.title}</h2>
        <p>{props.message}</p>
        <div className="dialog-buttons">
          {choices.map((choice, i) => (
            <button
              key={choice.label}
              className={[i === 0 ? 'primary' : '', choice.danger ? 'danger' : ''].join(' ')}
              autoFocus={i === 0}
              onClick={() => onChoose(choice.value)}
            >
              {choice.label}
            </button>
          ))}
          <button onClick={() => onChoose(null)}>やめる</button>
        </div>
      </div>
    </div>
  )
}
