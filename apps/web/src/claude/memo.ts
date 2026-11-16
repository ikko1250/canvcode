import { cleanFormat, MAX_LIST_LEVEL, normalizeRichText, richTextToMarkdown, type TextParagraph, type TextRun, type TextRunFormat } from '@canvcode/nodes'

// 付箋の文字を箇条書きのメモにする（付箋の右クリックの「箇条書きのメモにする」）。
// 付箋の文字を書式付きの Markdown（richMarkdown.ts）にして、サーバーの POST /api/claude/memo（apps/server/src/claude/memo.ts）に渡す。
// サーバーは Claude（既定は Sonnet）に頼み、答えの Markdown を書式付きの箇条書きの段落にして返す（言い換えた語の書式が残る）。
// すべての文字に共通の書式（付箋全体の色・大きさなど）は、Claude に任せると落ちやすいので Markdown に書かず、答えの段落に重ねる

// text は前のサーバー（markdown を読まない）に渡すプレーンテキスト（書式の記号をそのまま項目に写さないように）
export async function requestMemo(markdown: string, text: string, signal?: AbortSignal): Promise<TextParagraph[]> {
  const response = await fetch('/api/claude/memo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ markdown, text }),
    ...(signal ? { signal } : {}),
  })
  const body = (await response.json().catch(() => null)) as { paragraphs?: unknown; items?: unknown; error?: string } | null
  if (response.status === 404) throw new Error('このサーバーでは使えません（CANVCODE_CLAUDE=0 か、サーバーを再起動していない）')
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
  // 前のサーバーは items（文字と深さ）だけを返す
  const raw = Array.isArray(body?.paragraphs) ? body.paragraphs : Array.isArray(body?.items) ? body.items.map(itemParagraph) : []
  const paragraphs = raw.flatMap(paragraphOf)
  if (paragraphs.length === 0) throw new Error('箇条書きになりませんでした')
  return paragraphs
}

function itemParagraph(item: unknown): unknown {
  const { text, level } = (item ?? {}) as { text?: unknown; level?: unknown }
  return { runs: [{ text }], list: { type: 'bullet', level } }
}

// サーバーの答えの段落（形の崩れたものは捨てる。書式は知っている項目と型だけ、文字の中の改行は空白にする）
function paragraphOf(value: unknown): TextParagraph[] {
  const runs = (value as { runs?: unknown } | null)?.runs
  if (!Array.isArray(runs)) return []
  const valid = runs.flatMap((run): TextRun[] => {
    const { text, format } = (run ?? {}) as { text?: unknown; format?: unknown }
    if (typeof text !== 'string') return []
    const clean = formatOf(format)
    const line = text.replace(/[\r\n]/g, ' ')
    return clean ? [{ text: line, format: clean }] : [{ text: line }]
  })
  if (valid.length === 0) return []
  const level = (value as { list?: { level?: unknown } }).list?.level
  return [{ runs: valid, list: { type: 'bullet', level: typeof level === 'number' && Number.isFinite(level) ? Math.max(0, Math.min(MAX_LIST_LEVEL, Math.round(level))) : 0 } }]
}

function formatOf(value: unknown): TextRunFormat | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const out: TextRunFormat = {}
  if (typeof v.color === 'string') out.color = v.color
  if (typeof v.fontSize === 'number' && Number.isFinite(v.fontSize) && v.fontSize > 0) out.fontSize = v.fontSize
  if (typeof v.fontFamily === 'string') out.fontFamily = v.fontFamily
  if (typeof v.fontWeight === 'number' && Number.isFinite(v.fontWeight)) out.fontWeight = v.fontWeight
  for (const key of ['italic', 'underline', 'strikethrough'] as const) if (typeof v[key] === 'boolean') out[key] = v[key]
  return Object.keys(out).length > 0 ? out : undefined
}

// 頼む文章：付箋の段落の Markdown と、すべての文字に共通の書式（Markdown には書かない）。base は付箋の既定の書式（baseFormatOf）
export function memoSource(paragraphs: readonly TextParagraph[], base: TextRunFormat): { markdown: string; common?: TextRunFormat } {
  const common = commonFormat(normalizeRichText(paragraphs, base))
  return { markdown: richTextToMarkdown(paragraphs, { base: { ...base, ...common } }), ...(common ? { common } : {}) }
}

// 答えの段落を、付箋の段落にする（共通の書式を重ね、付箋の既定と同じ値は持たない）
export function memoParagraphs(answer: readonly TextParagraph[], base: TextRunFormat, common?: TextRunFormat): TextParagraph[] {
  const merged = answer.map((paragraph) => ({
    ...paragraph,
    runs: paragraph.runs.map((run) => {
      const format = cleanFormat({ ...common, ...run.format })
      return format ? { text: run.text, format } : { text: run.text }
    }),
  }))
  return normalizeRichText(merged, base)
}

// 空でない run のすべてが同じ値で持つ書式（なければ undefined）
function commonFormat(paragraphs: readonly TextParagraph[]): TextRunFormat | undefined {
  const runs = paragraphs.flatMap((paragraph) => paragraph.runs).filter((run) => run.text !== '')
  const first = runs[0]?.format
  if (!first) return undefined
  const common: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(first)) {
    if (runs.every((run) => Object.is((run.format as Record<string, unknown> | undefined)?.[key], value))) common[key] = value
  }
  return Object.keys(common).length > 0 ? (common as TextRunFormat) : undefined
}
