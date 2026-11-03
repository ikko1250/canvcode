import { MAX_LIST_LEVEL, normalizeRichText, type TextParagraph, type TextRunFormat } from '@canvcode/nodes'

// 付箋の文字を箇条書きのメモにする（付箋の右クリックの「箇条書きのメモにする」）。
// サーバーの POST /api/claude/memo（apps/server/src/claude/memo.ts）が Claude（既定は Sonnet）に頼み、項目と深さの並びを返す。
// それを付箋の段落（箇条書き。MAI-78 のリスト）にする

export interface MemoItem {
  text: string
  // 0 が一番外
  level: number
}

export async function requestMemo(text: string, signal?: AbortSignal): Promise<MemoItem[]> {
  const response = await fetch('/api/claude/memo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    ...(signal ? { signal } : {}),
  })
  const body = (await response.json().catch(() => null)) as { items?: MemoItem[]; error?: string } | null
  if (response.status === 404) throw new Error('このサーバーでは使えません（CANVCODE_CLAUDE=0 か、サーバーを再起動していない）')
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
  if (!Array.isArray(body?.items) || body.items.length === 0) throw new Error('箇条書きになりませんでした')
  return body.items
}

// 項目を、付箋の箇条書きの段落にする。format は文字の書式（元の付箋の最初の文字のもの。既定から変えていなければ undefined）
export function memoParagraphs(items: readonly MemoItem[], format?: TextRunFormat): TextParagraph[] {
  return normalizeRichText(
    items.map((item) => ({
      runs: [format ? { text: item.text, format } : { text: item.text }],
      list: { type: 'bullet', level: Math.max(0, Math.min(MAX_LIST_LEVEL, Math.round(item.level))) },
    })),
  )
}
