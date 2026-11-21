import { boxesIntersect, indicesBetween, unionBoxes, type Box, type CanvasRefTarget, type NodeRecord, type PdfRefTarget, type Transaction, type Vec, type WorkspaceRecord } from '@canvcode/core'
import {
  baseFormatOf,
  noteHeight,
  noteStyle,
  noteType,
  paragraphsOf,
  plainTextOf,
  richTextFromMarkdown,
  richTextToMarkdown,
  textStyle,
  textType,
  withoutRemoteImages,
  type NoteProps,
  type TextProps,
  type TextRunFormat,
} from '@canvcode/nodes'
import { makeBinding } from './bindings.ts'
import type { PdfRegionRequest } from './refs.ts'
import { nodeIn, type Editor } from './editor.ts'
import { REMOVE_WITH_ENDS } from './workspace.ts'
import type { IndexEntry } from './nodeIndex.ts'

// キャンバスの AI（付箋で聞き、答えは付箋に持たせる。docs/canvas-answer-panel-plan.md）。
// - 質問は付箋（選んだ付箋を読む順につないだ文字。付箋の Markdown）。答えは、読む順で最初の付箋の meta.ai.answer に持たせる（本文は Markdown）。
//   答えはキャンバスに置かない。付箋の角の三角から開くパネルで見る（画面の側）
// - AI 付箋（meta.ai）は、Claude に添えるもの（contexts）・モデル・effort・届いた答えを持つ
// - 「続けて聞く」：元の付箋の下に AI 付箋を置き、矢印を引く（元の付箋がこの Canvas になければ、渡された所に置く）。
//   置いた付箋には、前の質問と答えの写し（turns）を添える。元の付箋がほかの Canvas にあっても、消えても送れるように
// - 会話の答え（会話のタブの「付箋に切り出す」）も、写しを添えた札（kind: 'chat'）にする。続けて聞くと、写しを引き継ぐ
// - 「Canvasに残す」：答えの本文を、書式付きのテキスト 1 つにして置く（付箋の Markdown で読むので、見出し・太字・箇条書きが残る）
// Claude に頼むのは画面（apps/web/src/claude/answer.ts）。ここは Editor の上で読む・書く・置くだけ
// - AI 付箋は作業の指示にした（docs/ai-note-tasks-plan.md）。サーバーが会話と同じ Claude Code のジョブで動かし（apps/server/src/claude/noteTasks.ts）、
//   作業の間は meta.ai.task、終わったら meta.ai.answer に報告を書く。報告は答えと同じ項目に、会話・ジョブ・状態・変えたものを足したもの。
//   前の Q&A の答え（threadId がない）も、そのまま読める

// 前の質問と答え（続きを聞くときに Claude に渡す。古い方から）。answer は答えの本文（Markdown）
export interface PreviousTurn {
  question: string
  answer: string
}

// 付箋に持たせる答え（meta.ai.answer）
export interface AiAnswer {
  // 本文（Markdown）
  body: string
  // 関連する付箋の id（同じ Canvas。消えたものは画面が出さない）
  related: string[]
  // 答えたモデルと effort
  model: string
  effort?: string
  // 送ったときの質問の文字（付箋の Markdown。付箋の文字と比べて、質問が変わったかを見る。続きを聞くときに前の質問として渡す）
  question: string
  // 付箋を何枚か選んで聞いたときの、ほかの質問の付箋
  questionIds?: string[]
  answeredAt: number
  // 作業の報告なら（前の Q&A の答えにはない）：会話とジョブ、終わり方、誤り、変えたもの
  threadId?: string
  jobId?: string
  status?: 'done' | 'failed' | 'cancelled'
  error?: string
  changes?: AiTaskChanges
}

// 作業の報告の「変えたもの」：その会話の Canvas の編集（古い順。undone は戻したもの）・書いたファイル・動かしたコマンド
export interface AiTaskChanges {
  canvas: { batch: string; label: string; canvasId: string; undone?: true }[]
  files: string[]
  commands: string[]
}

// 作業の途中（meta.ai.task。サーバーが書き、終わったら消す）
export interface AiTask {
  threadId: string
  jobId: string
  startedAt: number
}

// AI 付箋に添えるもの。answer は前の答え（続き。turns は「続けて聞く」を押したときの写し）、
// canvas は選んだ所（送るときに ref にする。ref は 3 日で消えるので、範囲を持っておく）。target は、範囲（矩形）かノードなら Canvas の範囲、
// PDF のページの上でなぞった文字なら PDF の範囲（docs/ai-note-pick-text-plan.md）。regions は、範囲（矩形）がかかった PDF のページの、
// ページの中の範囲（ほぼ全体ならページ全体）。送るときに、その範囲の文字を PDF から読んで ref のノードに付ける（付箋で答える Claude はファイルを読めない）、
// chat は会話の答え（会話のタブの「付箋に切り出す」。turns は、切り出したときの頼んだ文と答えの写し。docs/claude-chat-tab-plan.md の 5）。
// 会話の質問（会話に入れずに聞いたもの）の「続けて聞く」も chat にする（jobId の代わりに questionId。会話の外で聞いたものは threadId もない）
export type AiContext =
  | { kind: 'answer'; noteId: string; canvasId: string; label: string; turns: PreviousTurn[] }
  | { kind: 'canvas'; label: string; target: CanvasRefTarget | PdfRefTarget; regions?: PdfRegionRequest[] }
  | { kind: 'chat'; threadId?: string; jobId?: string; questionId?: string; label: string; turns: PreviousTurn[] }

export interface AiNoteMeta {
  contexts: AiContext[]
  // この付箋で使うモデルと effort（なければ、最後に選んだもの）
  model?: string
  effort?: string
  // 届いた答え（新しいもの 1 つ。作業なら報告）
  answer?: AiAnswer
  // 作業の途中なら、その会話とジョブ
  task?: AiTask
}

// 続きを聞くときに渡す前の答えの数と、文字の合計（サーバーの上限と同じ。超えたら古いものから落とし、1 つでも長ければ答えを切る）
export const FOLLOW_UP_TURNS = 3
export const FOLLOW_UP_LENGTH = 12_000
// AI 付箋に添えられる所（kind: 'canvas'）の数（サーバーの上限 MAX_REFS と同じ。超えて送ると 400 で断られる）
export const MAX_AI_PLACES = 5
// 元の付箋と、続きの付箋の間（矢印を引く）
export const FOLLOW_UP_GAP = 64
// 付箋と、Canvas に残した答えのテキストの間（矢印を引く）
export const ANSWER_TEXT_GAP = 64
// Canvas に残す答えのテキストの幅と文字の大きさ
export const ANSWER_TEXT_WIDTH = 480
export const ANSWER_TEXT_FONT_SIZE = 14
// 前の答えの札の名前（質問の 1 行目）の長さと、会話の答えの札の名前に入れる会話の題の長さ
const CONTEXT_LABEL_LENGTH = 30
const CHAT_TITLE_LENGTH = 20
// 関連する付箋の候補の数と、1 枚の文字の長さ（サーバーの上限と同じ）
export const ANSWER_CANDIDATES = 30
export const ANSWER_CANDIDATE_LENGTH = 200

// 選んだ付箋の文字（付箋の Markdown。読む順に、空の行を挟んでつなぐ）と、文字のある付箋の id。付箋がなければ null
export function questionOf(editor: Editor, ids: Iterable<string>): { question: string; questionIds: string[] } | null {
  const notes = readingOrder(
    [...ids].flatMap((id) => {
      const entry = editor.index.get(id)
      return entry?.node.type === 'note' && noteText(entry.node) ? [entry] : []
    }),
  )
  if (notes.length === 0) return null
  return { question: notes.map((entry) => noteMarkdown(entry.node)).join('\n\n'), questionIds: notes.map((entry) => entry.node.id) }
}

// 質問の付箋の今の文字（消えた付箋は飛ばす）
export function questionText(editor: Editor, questionIds: readonly string[]): string {
  return questionOf(editor, questionIds)?.question ?? ''
}

// 関連する付箋の候補：この Canvas の、文字のある付箋（質問の付箋は除く）を、質問の付箋に近いものから max 枚。
// 近さは箱どうしの隙間（重なっていれば 0）。文字は 1 行にして切る
export function answerCandidates(editor: Editor, questionIds: readonly string[], max = ANSWER_CANDIDATES): { id: string; text: string }[] {
  const around = unionBoxes(questionIds.flatMap((id) => editor.index.get(id)?.worldBounds ?? []))
  if (!around) return []
  const skip = new Set(questionIds)
  return [...editor.index.nodeIds()]
    .flatMap((id) => {
      const entry = editor.index.get(id)
      const text = entry?.node.type === 'note' && !skip.has(id) ? noteText(entry.node) : ''
      return entry && text ? [{ id, text, gap: boxGap(around, entry.worldBounds) }] : []
    })
    .sort((a, b) => a.gap - b.gap)
    .slice(0, max)
    .map(({ id, text }) => ({ id, text: clip(text.replace(/\s+/g, ' '), ANSWER_CANDIDATE_LENGTH) }))
}

// AI 付箋の meta.ai（AI 付箋でなければ null）。形の合わない添えもの・答えは落とす
export function aiNoteMeta(node: NodeRecord | undefined): AiNoteMeta | null {
  const meta = node?.type === 'note' ? (node.meta?.ai as Partial<AiNoteMeta> | undefined) : undefined
  if (!meta || typeof meta !== 'object') return null
  const contexts = Array.isArray(meta.contexts) ? meta.contexts.flatMap((context) => contextOf(context)) : []
  const answer = answerOf(meta.answer)
  const task = taskOf(meta.task)
  return {
    contexts,
    ...(typeof meta.model === 'string' ? { model: meta.model } : {}),
    ...(typeof meta.effort === 'string' ? { effort: meta.effort } : {}),
    ...(answer ? { answer } : {}),
    ...(task ? { task } : {}),
  }
}

// 付箋の AI モードを変える。meta が null なら解く（答えも消える）。付箋でなければ false
export function setAiNote(editor: Editor, noteId: string, meta: AiNoteMeta | null, label = meta ? 'AI mode' : 'end AI mode'): boolean {
  const node = editor.getNode(noteId)
  if (node?.type !== 'note') return false
  editor.transact(label, (tx) => {
    const current = nodeIn(tx, noteId)!
    tx.put({ ...current, meta: meta ? { ...current.meta, ai: meta } : withoutKey(current.meta, 'ai') })
  })
  return true
}

// 付箋に答えを書く（AI 付箋でなければ AI 付箋にする。添えもの・モデルは残す）。1 回の Undo で戻る。付箋でなければ false
export function setAiAnswer(editor: Editor, noteId: string, answer: AiAnswer, label = 'Claude の答え'): boolean {
  const node = editor.getNode(noteId)
  if (node?.type !== 'note') return false
  editor.transact(label, (tx) => {
    const current = nodeIn(tx, noteId)!
    const ai: AiNoteMeta = { ...(aiNoteMeta(current) ?? { contexts: [] }), answer }
    tx.put({ ...current, meta: { ...current.meta, ai } })
  })
  return true
}

// 前の答え（続き）・会話の答えの札に添えた、前の質問と答え（古い方から）。札がなければ空。
// 両方あれば（ふつうはない）、会話の答えを先にして、上限に収める
export function previousTurnsOf(meta: AiNoteMeta | null): PreviousTurn[] {
  const contexts = meta?.contexts ?? []
  const chat = contexts.find((context) => context.kind === 'chat')?.turns ?? []
  const answer = contexts.find((context) => context.kind === 'answer')?.turns ?? []
  return chat.length > 0 && answer.length > 0 ? fitTurns([...chat, ...answer]) : chat.length > 0 ? chat : answer
}

// 会話の答えの札（会話のタブの「付箋に切り出す」・会話の質問の「続けて聞く」）。title は会話の題、question と answer は頼んだ文と答え（Markdown）、
// previous はその前の質問と答え（会話の質問に添えた前の答え）。名前は「会話「題」の答え」（会話がなければ「「質問」の答え」）、
// 写しは FOLLOW_UP_TURNS 個・FOLLOW_UP_LENGTH 文字に収める。答えの写しからは、外の画像を除く（写しの答え）
export function chatContext(chat: {
  threadId?: string
  jobId?: string
  questionId?: string
  title?: string
  question: string
  answer: string
  previous?: readonly PreviousTurn[]
}): Extract<AiContext, { kind: 'chat' }> {
  const title = chat.title?.replace(/\s+/g, ' ').trim()
  return {
    kind: 'chat',
    ...(chat.threadId ? { threadId: chat.threadId } : {}),
    ...(chat.jobId ? { jobId: chat.jobId } : {}),
    ...(chat.questionId ? { questionId: chat.questionId } : {}),
    label: title ? `会話「${clip(title, CHAT_TITLE_LENGTH)}」の答え` : `「${firstLine(chat.question, CONTEXT_LABEL_LENGTH)}」の答え`,
    turns: fitTurns(copiedTurns([...(chat.previous ?? []), { question: chat.question, answer: chat.answer }])),
  }
}

// 答えの写し：AI が書いた答えから、外の画像を除く（画像の説明と URL の文字にする。withoutRemoteImages）。
// 写しは付箋に添えて Claude に渡し、また描くこともあるので、写す所で外す（docs/question-canvas-tools-plan.md の「レビューで見つかったこと」の B）
function copiedTurns(turns: readonly PreviousTurn[]): PreviousTurn[] {
  return turns.map((turn) => ({ question: turn.question, answer: withoutRemoteImages(turn.answer) }))
}

// 「続けて聞く」で、続きの付箋に添える札。元の付箋（noteId。canvasId はその Canvas）の前の答えの札の写しに、元の付箋の質問と答えを足す。
// 答えがなければ null
export function followUpContext(noteId: string, canvasId: string, meta: AiNoteMeta | null): Extract<AiContext, { kind: 'answer' }> | null {
  const answer = meta?.answer
  if (!answer) return null
  const turns = fitTurns(copiedTurns([...previousTurnsOf(meta), { question: answer.question, answer: answer.body }]))
  return { kind: 'answer', noteId, canvasId, label: firstLine(answer.question, CONTEXT_LABEL_LENGTH), turns }
}

// 前の質問と答えを、max 個・maxLength 文字に収める（古いものから落とす。それでも長ければ、残った 1 つの答えの後ろを切る）
export function fitTurns(turns: readonly PreviousTurn[], max = FOLLOW_UP_TURNS, maxLength = FOLLOW_UP_LENGTH): PreviousTurn[] {
  const size = (turn: PreviousTurn) => turn.question.length + turn.answer.length
  const kept = turns.slice(-max).map((turn) => ({ ...turn }))
  while (kept.length > 1 && kept.reduce((sum, turn) => sum + size(turn), 0) > maxLength) kept.shift()
  const last = kept[0]
  if (last && size(last) > maxLength) {
    last.question = clip(last.question, Math.max(1, Math.floor(maxLength / 2)))
    last.answer = clip(last.answer, Math.max(1, maxLength - last.question.length))
  }
  return kept
}

// 「続けて聞く」：元の付箋（noteId）の下（重なれば、さらに下の空いている所）に AI 付箋を置き、context を添え、元の付箋から矢印を引く。
// 幅は元の付箋にそろえる。tx の中で置く（呼ぶ側が、置いたあとに文字の編集を始めて、1 回の Undo にまとめる）。置いた付箋の id を返す
export function placeFollowUpNote(editor: Editor, tx: Transaction<WorkspaceRecord>, noteId: string, context: AiContext): string | null {
  const source = editor.index.get(noteId)
  if (source?.node.type !== 'note') return null
  const from = source.worldBounds
  const draft = editor.makeNode('note', { x: 0, y: 0, parentId: editor.canvasId }) as NodeRecord<NoteProps>
  const props = { ...draft.props, w: (source.node.props as NoteProps).w }
  const box: Box = { x: from.x, y: from.y + from.h + FOLLOW_UP_GAP, w: props.w, h: noteHeight(props) }
  moveDownPastOthers(editor, box, new Set([noteId]))
  const local = editor.worldToParent(editor.canvasId, box)
  const [noteIndex, arrowIndex] = indicesBetween(editor.index.topmost(editor.canvasId)?.index ?? null, null, 2)
  const ai: AiNoteMeta = { contexts: [context] }
  tx.put({ ...draft, x: local.x, y: local.y, props, index: noteIndex!, meta: { ...draft.meta, ai } })
  // 元の付箋の下の辺の中ほどから、続きの付箋の上の辺の中ほどへ
  putArrow(
    editor,
    tx,
    arrowIndex!,
    { id: noteId, point: { x: from.x + from.w / 2, y: from.y + from.h }, anchor: { x: 0.5, y: 1 } },
    { id: draft.id, point: { x: box.x + box.w / 2, y: box.y }, anchor: { x: 0.5, y: 0 } },
  )
  return draft.id
}

// 「続けて聞く」で、元の付箋がこの Canvas にないとき：center（ワールド座標）を真ん中にして AI 付箋を置く（矢印は引かない）。置いた付箋の id
export function placeFollowUpAt(editor: Editor, tx: Transaction<WorkspaceRecord>, center: Vec, context: AiContext): string {
  const draft = editor.makeNode('note', { x: 0, y: 0, parentId: editor.canvasId }) as NodeRecord<NoteProps>
  const h = noteHeight(draft.props)
  const local = editor.worldToParent(editor.canvasId, { x: center.x - draft.props.w / 2, y: center.y - h / 2 })
  const index = indicesBetween(editor.index.topmost(editor.canvasId)?.index ?? null, null, 1)[0]!
  tx.put({ ...draft, x: local.x, y: local.y, index, meta: { ...draft.meta, ai: { contexts: [context] } satisfies AiNoteMeta } })
  return draft.id
}

// 「Canvasに残す」：答えの本文（Markdown）を書式付きのテキストにして置く。外の画像は、説明と URL の文字にする（withoutRemoteImages）。
// 1 回の Undo で消える。置いたテキストの id（置けなければ null）。
// at が付箋なら、その右（重なれば、さらに右の空いている所）に置き、付箋から矢印を引く。点なら、そこを真ん中にして置く（矢印は引かない）
export function placeAnswerText(editor: Editor, body: string, at: { noteId: string } | { center: Vec }, options: { label?: string } = {}): string | null {
  const draft = editor.makeNode('text', { x: 0, y: 0, parentId: editor.canvasId }) as NodeRecord<TextProps>
  const style = { ...draft.props, fontSize: ANSWER_TEXT_FONT_SIZE, w: ANSWER_TEXT_WIDTH, autoWidth: false }
  const paragraphs = richTextFromMarkdown(withoutRemoteImages(body.replace(/\r\n?/g, '\n').trim()), { base: textBase(style) })
  const text: NodeRecord<TextProps> = { ...draft, props: { ...style, paragraphs } }
  const size = textType.getBounds(text)
  const source = 'noteId' in at ? editor.index.get(at.noteId) : undefined
  if ('noteId' in at && source?.node.type !== 'note') return null
  const box: Box = source
    ? { x: source.worldBounds.x + source.worldBounds.w + ANSWER_TEXT_GAP, y: source.worldBounds.y, w: size.w, h: size.h }
    : { x: (at as { center: Vec }).center.x - size.w / 2, y: (at as { center: Vec }).center.y - size.h / 2, w: size.w, h: size.h }
  if (source) moveRightPastOthers(editor, box, new Set([source.node.id]))
  return editor.transact(options.label ?? 'Canvas に答えを残す', (tx) => {
    const local = editor.worldToParent(editor.canvasId, box)
    const [textIndex, arrowIndex] = indicesBetween(editor.index.topmost(editor.canvasId)?.index ?? null, null, 2)
    tx.put({ ...text, x: local.x, y: local.y, index: textIndex! })
    if (source) {
      // 付箋の右の辺の中ほどから、テキストの左の辺へ（テキストの上の方に向ける）
      const from = source.worldBounds
      const startY = from.y + from.h / 2
      const anchorY = Math.min(0.95, Math.max(0.05, (startY - box.y) / Math.max(1, box.h)))
      putArrow(
        editor,
        tx,
        arrowIndex!,
        { id: source.node.id, point: { x: from.x + from.w, y: startY }, anchor: { x: 1, y: 0.5 } },
        { id: text.id, point: { x: box.x, y: box.y + anchorY * box.h }, anchor: { x: 0, y: anchorY } },
      )
    }
    return text.id
  })
}

// ドラッグ・文字の編集などのトランザクションが開いている間は書けない（Store.begin が投げる）ので、閉じるまで待つ。
// signal で止めたら、閉じていなくても戻る（呼ぶ側が signal を見る）
export async function waitUntilIdle(editor: Editor, signal?: AbortSignal, intervalMs = 200): Promise<void> {
  while (editor.store.activeTransaction && !signal?.aborted) await new Promise((resolve) => setTimeout(resolve, intervalMs))
}

// 質問の 1 行目（書式の記号を外す。長ければ切る）
export function firstLine(markdown: string, length = 60): string {
  const line = plainTextOf(richTextFromMarkdown(markdown)).split('\n').find((part) => part.trim() !== '')?.trim() ?? ''
  return clip(line, length) || '（質問）'
}

// 箱に重なるノード（skip のほか。元の付箋を入れたフレームも、よける。置くのは Canvas 直下なので、その上に重ねない）があれば、その下へずらす
function moveDownPastOthers(editor: Editor, box: Box, skip: ReadonlySet<string>): void {
  for (let guard = 0; guard < 100; guard++) {
    const blocking = overlapping(editor, box, skip)
    if (blocking.length === 0) return
    box.y = Math.max(...blocking.map((entry) => entry.worldBounds.y + entry.worldBounds.h)) + FOLLOW_UP_GAP / 2
  }
}

// 箱に重なるノードがあれば、その右へずらす
function moveRightPastOthers(editor: Editor, box: Box, skip: ReadonlySet<string>): void {
  for (let guard = 0; guard < 100; guard++) {
    const blocking = overlapping(editor, box, skip)
    if (blocking.length === 0) return
    box.x = Math.max(...blocking.map((entry) => entry.worldBounds.x + entry.worldBounds.w)) + ANSWER_TEXT_GAP / 2
  }
}

function overlapping(editor: Editor, box: Box, skip: ReadonlySet<string>): IndexEntry[] {
  return editor.index.search(box).flatMap((id) => {
    const entry = editor.index.get(id)
    return entry && !skip.has(id) && boxesIntersect(entry.worldBounds, box) ? [entry] : []
  })
}

// 2 つのノードを矢印でつなぐ。端は anchor（ノードの箱の中の割合）に向ける。どちらかの端を消したら、矢印も一緒に消える（REMOVE_WITH_ENDS）
function putArrow(
  editor: Editor,
  tx: Transaction<WorkspaceRecord>,
  index: string,
  from: { id: string; point: Vec; anchor: Vec },
  to: { id: string; point: Vec; anchor: Vec },
): void {
  const parentId = editor.canvasId
  const local = editor.worldToParent(parentId, from.point)
  const arrow = editor.makeNode('arrow', {
    x: local.x,
    y: local.y,
    parentId,
    props: { start: { x: 0, y: 0 }, end: { x: to.point.x - from.point.x, y: to.point.y - from.point.y }, bend: 0 },
  })
  tx.put({ ...arrow, index, meta: { ...arrow.meta, [REMOVE_WITH_ENDS]: true } })
  tx.put(makeBinding(arrow.id, from.id, { terminal: 'start', normalizedAnchor: from.anchor, isPrecise: true }))
  tx.put(makeBinding(arrow.id, to.id, { terminal: 'end', normalizedAnchor: to.anchor, isPrecise: true }))
}

function contextOf(value: unknown): AiContext[] {
  if (typeof value !== 'object' || value === null) return []
  const context = value as Record<string, unknown>
  const label = typeof context.label === 'string' ? context.label : ''
  if (context.kind === 'canvas' && typeof context.target === 'object' && context.target !== null) {
    const target = context.target as Record<string, unknown>
    if (target.kind !== 'pdf') {
      const regions = regionsOf(context.regions)
      return [{ kind: 'canvas', label, target: context.target as CanvasRefTarget, ...(regions.length > 0 ? { regions } : {}) }]
    }
    const { fileId, pageIndex, rect, text } = target
    if (typeof fileId !== 'string' || typeof pageIndex !== 'number' || typeof rect !== 'object' || rect === null || typeof text !== 'string') return []
    return [{ kind: 'canvas', label, target: context.target as PdfRefTarget }]
  }
  if (context.kind === 'answer' && typeof context.noteId === 'string' && typeof context.canvasId === 'string') {
    const turns = turnsOf(context.turns)
    return [{ kind: 'answer', noteId: context.noteId, canvasId: context.canvasId, label, turns }]
  }
  if (context.kind === 'chat') {
    const id = (key: string) => (typeof context[key] === 'string' ? { [key]: context[key] as string } : {})
    return [{ kind: 'chat', ...id('threadId'), ...id('jobId'), ...id('questionId'), label, turns: turnsOf(context.turns) }]
  }
  return []
}

// 選んだ所の regions（範囲がかかった PDF のページ）。形の合わないものは落とす
function regionsOf(value: unknown): PdfRegionRequest[] {
  return (Array.isArray(value) ? value : []).flatMap((item): PdfRegionRequest[] => {
    const { nodeId, assetId, fileId, pageIndex, rect } = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    const box = (typeof rect === 'object' && rect !== null ? rect : {}) as Record<string, unknown>
    const fits = ['x', 'y', 'w', 'h'].every((key) => typeof box[key] === 'number')
    if (typeof nodeId !== 'string' || typeof assetId !== 'string' || typeof fileId !== 'string' || typeof pageIndex !== 'number' || !fits) return []
    return [{ nodeId, assetId, fileId, pageIndex, rect: { x: box.x as number, y: box.y as number, w: box.w as number, h: box.h as number } }]
  })
}

// PDF のページの上でなぞった文字を添えるときの名前（「Claude に頼む…」の名前と同じ書き方）
export function pdfPlaceLabel(target: Pick<PdfRefTarget, 'pageIndex' | 'text'>): string {
  const line = target.text.replace(/\s+/g, ' ').trim()
  return `PDF の ${target.pageIndex + 1} ページ「${line.length > PLACE_LABEL_LENGTH ? `${line.slice(0, PLACE_LABEL_LENGTH)}…` : line}」`
}

const PLACE_LABEL_LENGTH = 16

// 添えるものが同じか（前の答え・会話の答えは同じ答え、選んだ所は同じノードと範囲か、同じ PDF の同じ文字）
export function sameAiContext(a: AiContext, b: AiContext): boolean {
  if (a.kind === 'answer' && b.kind === 'answer') return a.noteId === b.noteId
  if (a.kind === 'chat' && b.kind === 'chat') return a.jobId === b.jobId && a.questionId === b.questionId
  if (a.kind !== 'canvas' || b.kind !== 'canvas') return false
  const x = a.target
  const y = b.target
  if (x.kind === 'pdf' || y.kind === 'pdf') {
    return x.kind === 'pdf' && y.kind === 'pdf' && x.fileId === y.fileId && x.pageIndex === y.pageIndex && x.text === y.text && JSON.stringify(x.rect) === JSON.stringify(y.rect)
  }
  const ids = (target: CanvasRefTarget) => target.nodes.map((node) => node.id).sort().join(',')
  return ids(x) === ids(y) && JSON.stringify(x.rect) === JSON.stringify(y.rect)
}

function turnsOf(value: unknown): PreviousTurn[] {
  return (Array.isArray(value) ? value : []).flatMap((turn): PreviousTurn[] => {
    const { question, answer } = (typeof turn === 'object' && turn !== null ? turn : {}) as Record<string, unknown>
    return typeof question === 'string' && typeof answer === 'string' ? [{ question, answer }] : []
  })
}

function answerOf(value: unknown): AiAnswer | null {
  if (typeof value !== 'object' || value === null) return null
  const answer = value as Record<string, unknown>
  if (typeof answer.body !== 'string' || typeof answer.question !== 'string') return null
  const ids = (list: unknown) => (Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [])
  const questionIds = ids(answer.questionIds)
  return {
    body: answer.body,
    related: ids(answer.related),
    model: typeof answer.model === 'string' ? answer.model : '',
    ...(typeof answer.effort === 'string' ? { effort: answer.effort } : {}),
    question: answer.question,
    ...(questionIds.length > 0 ? { questionIds } : {}),
    answeredAt: typeof answer.answeredAt === 'number' ? answer.answeredAt : 0,
    ...(typeof answer.threadId === 'string' ? { threadId: answer.threadId } : {}),
    ...(typeof answer.jobId === 'string' ? { jobId: answer.jobId } : {}),
    ...(answer.status === 'done' || answer.status === 'failed' || answer.status === 'cancelled' ? { status: answer.status } : {}),
    ...(typeof answer.error === 'string' ? { error: answer.error } : {}),
    ...(changesOf(answer.changes) ? { changes: changesOf(answer.changes)! } : {}),
  }
}

function changesOf(value: unknown): AiTaskChanges | null {
  if (typeof value !== 'object' || value === null) return null
  const { canvas, files, commands } = value as Record<string, unknown>
  const strings = (list: unknown) => (Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [])
  return {
    canvas: (Array.isArray(canvas) ? canvas : []).flatMap((edit): AiTaskChanges['canvas'] => {
      const { batch, label, canvasId, undone } = (typeof edit === 'object' && edit !== null ? edit : {}) as Record<string, unknown>
      if (typeof batch !== 'string' || typeof label !== 'string' || typeof canvasId !== 'string') return []
      return [{ batch, label, canvasId, ...(undone === true ? { undone: true as const } : {}) }]
    }),
    files: strings(files),
    commands: strings(commands),
  }
}

function taskOf(value: unknown): AiTask | null {
  if (typeof value !== 'object' || value === null) return null
  const { threadId, jobId, startedAt } = value as Record<string, unknown>
  if (typeof threadId !== 'string' || typeof jobId !== 'string') return null
  return { threadId, jobId, startedAt: typeof startedAt === 'number' ? startedAt : 0 }
}

// 前の作業で、まだ戻していない Canvas の編集があるか（「前の変更を戻してから送る」を出すか）
export function hasUndoableChanges(answer: AiAnswer | undefined): boolean {
  return Boolean(answer?.threadId && answer.changes?.canvas.some((edit) => !edit.undone))
}

function withoutKey(meta: Record<string, unknown> | undefined, key: string): Record<string, unknown> {
  const rest = { ...meta }
  delete rest[key]
  return rest
}

// 付箋の文字の付箋の Markdown（付箋の既定の書式と同じ値は書かない）
function noteMarkdown(node: NodeRecord): string {
  const props = node.props as NoteProps
  return richTextToMarkdown(paragraphsOf(props), { base: baseFormatOf(noteStyle({ ...noteType.defaultProps(), ...props })) }).trim()
}

// テキストの既定の書式（見出しの大きさの基準）
function textBase(props: TextProps): TextRunFormat {
  return baseFormatOf(textStyle({ ...textType.defaultProps(), ...props }))
}

function noteText(node: NodeRecord): string {
  return plainTextOf((node.props as NoteProps).paragraphs).trim()
}

// 2 つの箱の隙間（重なっていれば 0）
function boxGap(a: Box, b: Box): number {
  const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w))
  const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h))
  return Math.hypot(dx, dy)
}

// 長い文字を切る（サロゲートペアを分けない）
function clip(text: string, length: number): string {
  const chars = Array.from(text)
  return chars.length > length ? `${chars.slice(0, length - 1).join('')}…` : text
}

// 読む順（上から、同じ高さなら左から）
function readingOrder(entries: IndexEntry[]): IndexEntry[] {
  return [...entries].sort((a, b) => a.worldBounds.y - b.worldBounds.y || a.worldBounds.x - b.worldBounds.x)
}
