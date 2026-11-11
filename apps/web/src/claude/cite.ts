// アイテムの APA の引用を作る（右クリックの「APA の引用を置く」。MAI-98）。
// サーバーの POST /api/claude/cite（apps/server/src/claude/cite.ts）が材料を集めて Claude（既定は Sonnet）に Web で確かめさせ、
// 引用の文（斜体の所の印つき）と、未確認の項目・根拠の URL を返す。それを、元のアイテムの右下に置くテキストの段落にする
import { isFileRecord, type NodeRecord } from '@canvcode/core'
import type { Workspace } from '@canvcode/canvas'
import { normalizeRichText, type LinkCardProps, type PdfPageProps, type PortalProps, type TextParagraph, type TextRun } from '@canvcode/nodes'
import type { MarkdownCardProps } from '@canvcode/nodes/markdown'

export type CiteSource =
  | { kind: 'pdf'; fileId: string }
  | { kind: 'markdown'; fileId: string }
  | { kind: 'link'; url: string; title?: string; description?: string; siteName?: string }

export interface CiteSegment {
  text: string
  italic?: boolean
}

export interface CiteResult {
  citation: CiteSegment[]
  text: string
  type: string
  unverified: { field: string; label: string; candidate?: string }[]
  evidence: { url: string; labels: string[] }[]
  note?: string
  model: string
  costUsd: number
  durationMs: number
}

// 未確認・根拠・メモの行の色（引用の文より薄くする）
export const CITE_NOTE_COLOR = '#6b7280'

// 引用を作れるアイテムなら、サーバーに送る材料の指定。PDF の Portal・PDF のページ・リンクカード・Markdown のカード
export function citeSourceOf(node: NodeRecord, workspace: Pick<Workspace, 'getFile' | 'documents'>): CiteSource | null {
  if (node.type === 'portal') {
    const targetId = (node.props as PortalProps).targetId
    const file = workspace.documents().find((doc) => isFileRecord(doc) && doc.kind === 'pdf' && doc.pagesCanvasId === targetId && doc.deletedAt === null)
    return file ? { kind: 'pdf', fileId: file.id } : null
  }
  if (node.type === 'pdf-page') {
    const file = workspace.getFile((node.props as PdfPageProps).fileId)
    return file?.kind === 'pdf' ? { kind: 'pdf', fileId: file.id } : null
  }
  if (node.type === 'link-card') {
    const props = node.props as LinkCardProps
    if (props.status === 'loading' || !/^https?:\/\//i.test(props.url)) return null
    return {
      kind: 'link',
      url: props.url,
      ...(props.title ? { title: props.title } : {}),
      ...(props.description ? { description: props.description } : {}),
      ...(props.siteName ? { siteName: props.siteName } : {}),
    }
  }
  if (node.type === 'markdown-card') {
    const file = workspace.getFile((node.props as MarkdownCardProps).fileId)
    return file?.kind === 'markdown' && !file.missing ? { kind: 'markdown', fileId: file.id } : null
  }
  return null
}

export async function requestCitation(source: CiteSource, signal?: AbortSignal): Promise<CiteResult> {
  const response = await fetch('/api/claude/cite', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(source),
    ...(signal ? { signal } : {}),
  })
  const body = (await response.json().catch(() => null)) as (Partial<CiteResult> & { error?: string }) | null
  if (response.status === 404 && !body?.error?.includes('見つかりません')) throw new Error('このサーバーでは使えません（CANVCODE_CLAUDE=0 か、サーバーを再起動していない）')
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
  if (!Array.isArray(body?.citation) || body.citation.length === 0) throw new Error('引用が返ってきませんでした')
  return {
    citation: body.citation.filter((s): s is CiteSegment => typeof s?.text === 'string'),
    text: typeof body.text === 'string' ? body.text : '',
    type: typeof body.type === 'string' ? body.type : 'other',
    unverified: Array.isArray(body.unverified) ? body.unverified : [],
    evidence: Array.isArray(body.evidence) ? body.evidence : [],
    ...(typeof body.note === 'string' && body.note ? { note: body.note } : {}),
    model: typeof body.model === 'string' ? body.model : '',
    costUsd: typeof body.costUsd === 'number' ? body.costUsd : 0,
    durationMs: typeof body.durationMs === 'number' ? body.durationMs : 0,
  }
}

// 置くテキストの段落：1 段落目が引用の文（誌名・巻などは斜体）。そのあとに薄い色で、
// 未確認の項目（「未確認：年・巻号（Web で確かめられなかったので、推測で埋めていません）」と、資料にあった候補）、
// 根拠の URL（「根拠（著者・年・題）：https://…」）、Claude のメモを並べる
export function citationParagraphs(result: Pick<CiteResult, 'citation' | 'unverified' | 'evidence' | 'note'>): TextParagraph[] {
  const runs: TextRun[] = result.citation.map((segment) => (segment.italic ? { text: segment.text, format: { italic: true } } : { text: segment.text }))
  const notes: string[] = []
  if (result.unverified.length > 0) {
    notes.push(`未確認：${result.unverified.map((u) => u.label).join('・')}（Web で確かめられなかったので、推測で埋めていません）`)
    const candidates = result.unverified.filter((u) => u.candidate)
    if (candidates.length > 0) notes.push(`資料にあった値（未確認）：${candidates.map((u) => `${u.label} ${u.candidate}`).join('／')}`)
  }
  for (const { url, labels } of result.evidence) notes.push(`根拠（${labels.join('・')}）：${url}`)
  if (result.note) notes.push(`メモ：${result.note}`)
  return normalizeRichText([{ runs }, ...notes.map((text) => ({ runs: [{ text, format: { color: CITE_NOTE_COLOR } }] }))])
}
