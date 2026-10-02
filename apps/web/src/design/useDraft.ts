import { useRef, useState } from 'react'

// 入力欄に打っている途中の文字。確定（Enter・フォーカスを外す）までは値を変えない。
// Esc のあとフォーカスを外したときに、古い文字で確定しないよう、ref でも持つ
export function useDraft() {
  const [draft, setState] = useState<string | null>(null)
  const ref = useRef<string | null>(null)
  const setDraft = (next: string | null) => {
    ref.current = next
    setState(next)
  }
  // 打っている文字を取り出して、空にする
  const take = (): string | null => {
    const text = ref.current
    setDraft(null)
    return text
  }
  return { draft, setDraft, take }
}
