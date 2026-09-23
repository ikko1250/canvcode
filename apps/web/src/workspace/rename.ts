// 名前の入力欄で確定したときに、付ける名前。前後の空白は落とす。
// 空（空白だけ）か、元の名前と同じなら null（名前は変えない）
export function renamedTitle(value: string, before: string): string | null {
  const title = value.trim()
  return title && title !== before ? title : null
}
