// 並んだボタンから 1 つを選ぶ切り替え（タブと同じ形。docs/work-canvas-filter-plan.md）。会話の入力欄の「会話｜質問」（ChatComposer）と、
// 作業のタブの「Canvas current｜all」（QuestionPanel）で使う。見た目は styles.css の .claude-mode
// - 入れ物は role="radiogroup"（aria-label で何を選ぶか）、ボタンは role="radio" と aria-checked。読み上げの名前は見えている文字のまま、
//   説明は title に書く。英語の文字（current・all）は lang="en" にして、英語の声で読ませる
// - 選んでいるボタンは太字になる。切り替えても幅が変わらないよう、data-label の文字を太字で見えない所に置き、幅を取っておく（styles.css）
// - 選んでいる方だけ Tab で止まる（roving tabIndex）。←→↑↓ で隣に切り替え（端からは反対の端へ）、フォーカスも移す

export interface Choice<T extends string> {
  value: T
  label: string
  title: string
  // label の言葉（ページの ja と違うときだけ）
  lang?: string
}

// onChange は NoInfer（useState の set を渡したとき、T をその引数の型から推さない）
export function ChoiceSwitch<T extends string>(props: { label: string; choices: readonly Choice<T>[]; value: T; onChange(value: NoInfer<T>): void }) {
  const { label, choices, value, onChange } = props
  return (
    <div
      className="claude-mode"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
        if (step === 0) return
        e.preventDefault()
        const at = choices.findIndex((choice) => choice.value === value)
        const next = (at + step + choices.length) % choices.length
        onChange(choices[next]!.value)
        e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus()
      }}
    >
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          role="radio"
          aria-checked={choice.value === value}
          tabIndex={choice.value === value ? 0 : -1}
          onClick={() => onChange(choice.value)}
          title={choice.title}
          lang={choice.lang}
          data-label={choice.label}
        >
          {choice.label}
        </button>
      ))}
    </div>
  )
}
