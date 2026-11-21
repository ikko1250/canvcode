// 入力欄の文に、頼み方の下書きを足す（「Claude におまかせ」）。閉じても書きかけは残るので、上書きせずに足す。
// - 空か、前に入れた下書き（inserted）のまま手を入れていない（前後の空白を除いて同じ）なら、新しい下書きに置き換える
//   （表の「おまかせ」を何もせずに閉じ、グラフの「おまかせ」をしたとき、2 つの頼みが並ばないように）
// - 同じ下書きがもう入っていれば、そのまま（2 回押して同じ文が並ばないように）
// - それ以外（書きかけ）は、空行を挟んで後ろに足す
export function withDraft(prompt: string, text: string, inserted: readonly string[]): string {
  const written = prompt.trim()
  if (!written || inserted.some((draft) => draft.trim() === written)) return text
  if (prompt.includes(text)) return prompt
  return `${prompt.trimEnd()}\n\n${text}`
}
