import { boxesIntersect, indicesBetween, unionBoxes, type Box, type CanvasRefTarget, type NodeRecord, type Transaction, type WorkspaceRecord } from '@canvcode/core'
import {
  baseFormatOf,
  buttonInstruction,
  noteHeight,
  noteStyle,
  noteType,
  normalizeRichText,
  paragraphsOf,
  plainTextOf,
  richTextFromMarkdown,
  richTextToMarkdown,
  type ButtonProps,
  type FrameProps,
  type NoteProps,
  type TextParagraph,
  type TextRunFormat,
} from '@canvcode/nodes'
import { makeBinding } from './bindings.ts'
import { nodeIn, type Editor } from './editor.ts'
import { REMOVE_WITH_ENDS } from './workspace.ts'
import type { IndexEntry } from './nodeIndex.ts'

// キャンバスの AI（付箋で聞き、付箋で答える）の置き方。
// - 質問は付箋（選んだ付箋を読む順につないだ文字）。答えは、その下（ほかのノードや、質問を入れたフレームと重なれば、その下）に置く、
//   Canvas 直下の 1 つのフレーム。質問の付箋から答えのフレームへ矢印を引く
// - フレームの中は、上から「前提」の付箋（Claude が質問から決めた前提。あれば）、段落ごとに 1 枚の付箋、ボタンの並び
//   （左右の端に続きの質問を置く「＋」、その間に書き直すためのボタン）、版の帯（版が 2 つ以上のとき）。ボタンと帯は AI が置いたもの（hint）
// - ボタンを押すと、入っているフレームの前提と付箋（読む順）と指示を Claude に送り、返ってきた答えで
//   フレームの付箋と AI が置いたボタンを置き換える（1 回の Undo で戻る）。人が置いたボタンや画像などのほかの子は残し、新しい答えの下へずらす
// - 書き直す前の答えは、版としてフレームの meta.answer.versions に残す（人が書き換えたところも、その印も）。帯を押すと、その版に戻す（Claude は呼ばない）
// - 「＋」を押すと、フレームの横に続きの質問の付箋（AI モード）を置き、フレームから矢印を引く。AI モードの付箋は meta.ai に、
//   Claude に添えるもの（前の答え・選んだ所）とモデルを持つ。送って答えを置いたら、AI モードを解く
// - 付箋の文字は、付箋の Markdown（packages/nodes の richMarkdown.ts。**太字**・`等幅`・[語]{color=…} など）で読み書きする。
//   質問・今の答えは付箋の Markdown にして送り（人が付けた書式も Claude に見える）、答えの段落・前提も付箋の Markdown で受けて、書式付きの段落にする
// - AI が置いた付箋は、meta.answer に置いたときの文字（付箋の Markdown。前提の付箋は前提の項目）を持つ。今の文字と比べて、
//   人が書き換えた・書き足した（書式だけを変えたものも）ところに edited の印を付けて送る。フレームは meta.answer.history に、これまでに当てた指示を持つ
// Claude に頼むのは画面（apps/web/src/claude/answer.ts）。ここは Editor の上で読む・置くだけ

export interface AnswerHint {
  // ボタンに出す文字
  label: string
  // 押したときに Claude に送る、書き直しの指示
  prompt: string
}

export interface CanvasAnswer {
  // フレームの名前（書式なしの文字）
  title: string
  // 質問に書かれていなかったので、Claude が決めた前提（付箋の Markdown。1 項目 1 行）
  assumptions: string[]
  // 段落（1 段落 = 1 枚の付箋。付箋の Markdown）
  paragraphs: string[]
  hints: AnswerHint[]
}

// 今の答えの前提・付箋の文字（付箋の Markdown）。edited は、人が書き換えたか書き足したもの
export interface AnswerItem {
  text: string
  edited: boolean
}

// フレームの今の答え（ボタンを押したときに Claude に送る）
export interface AnswerContent {
  frameId: string
  title: string
  // 前提の付箋の項目。前提の付箋がなければ空
  assumptions: AnswerItem[]
  // 前提の付箋のほかの、直下の付箋の文字（読む順）
  notes: AnswerItem[]
  // フレームに人が置いたボタンの文字（書き直しても残る）
  buttons: string[]
  // これまでにこの答えに当てた指示（古い順）
  history: string[]
  // 待っている間に変わったかを確かめる印（フレームの名前と、直下の付箋と AI が置いたボタン）
  signature: string
}

// 答えの版（フレームの meta.answer.versions）。付箋の文字は付箋の Markdown。
// original は、人が書き換えた・書き足した付箋の、AI が置いたときの文字（書き足したものは空）。版に戻したあとも edited の印が残るように持つ
export interface AnswerVersionItem {
  text: string
  original?: string
}

export interface AnswerVersion {
  title: string
  assumptions: AnswerVersionItem[]
  paragraphs: AnswerVersionItem[]
  hints: AnswerHint[]
  // この版を作ったボタンの文字（最初の版は持たない）
  via?: string
}

// AI モードの付箋（meta.ai）に添えるもの。answer は前の答え（続きの質問）、canvas は選んだ所（送るときに ref にする。ref は 3 日で消えるので、範囲を持っておく）
export type AiContext = { kind: 'answer'; frameId: string; label: string } | { kind: 'canvas'; label: string; target: CanvasRefTarget }

export interface AiNoteMeta {
  contexts: AiContext[]
  // この付箋で使うモデルと effort（なければ、最後に選んだもの）
  model?: string
  effort?: string
}

// 前の答え（続きの質問のときに Claude に渡す。古い方から）
export interface PreviousTurn {
  question: string
  title: string
  paragraphs: string[]
}

// 付箋の meta.answer（AI が置いたときの文字）と、フレームの meta.answer（これまでの指示・版・前の答え）
interface NoteAnswerMeta {
  role: 'assumptions' | 'paragraph'
  // 段落：置いたときの文字。前提：置いたときの項目（どちらも付箋の Markdown。answerContent が読むのと同じ形）
  text?: string
  items?: string[]
}

interface FrameAnswerMeta {
  history: string[]
  versions?: AnswerVersion[]
  // 今出している版（versions の位置）
  current?: number
  // 続きの質問なら、前の答えのフレーム
  followUpOf?: string
}

export const ANSWER_COLUMN_WIDTH = 670
export const ANSWER_PADDING = 24
// 質問の付箋と答えのフレームの間（矢印を引く）
export const ANSWER_GAP = 96
// 答えのフレームと、続きの質問の付箋の間
export const FOLLOW_UP_GAP = 64
const NOTE_GAP = 12
const BUTTON_GAP = 8
// 「＋」（続きの質問を置く）の幅と色
const PLUS_WIDTH = 28
export const PLUS_COLOR = '#fff3bf'
// 版の帯の大きさと色（今の版は濃くする）
const VERSION_BAR_WIDTH = 48
const VERSION_BAR_HEIGHT = 10
const VERSION_BAR_GAP = 6
export const VERSION_BAR_COLOR = '#e8eefc'
export const VERSION_BAR_CURRENT_COLOR = '#3b5bdb'
// 最後の付箋とボタンの並びの間（残した子との間も）
const SECTION_GAP = 16
export const ANSWER_FONT_SIZE = 14
export const ASSUMPTION_COLOR = '#eef1f5'
// 前提の付箋の 1 行目。meta を持たない付箋（写したものなど）は、これで始まる 1 行目で前提の付箋と見なす
export const ASSUMPTION_HEADING = 'この答えの前提'
// 送るこれまでの指示（新しい方から）と人が置いたボタンの、数と 1 つの長さ（サーバーの本文の上限に収まるように）
const SENT_HISTORY = 5
const SENT_HISTORY_LENGTH = 100
const SENT_BUTTONS = 12
const SENT_BUTTON_LENGTH = 40
// フレームに覚えておく指示の数と、版の数（古いものから落とす）
const KEPT_HISTORY = 8
export const KEPT_VERSIONS = 8
// 続きの質問で渡す、前の答えの数
const PREVIOUS_TURNS = 3

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

// ボタンを押したときに書き直すフレーム（いちばん近い祖先のフレーム）と、送る指示・質問の付箋。フレームの中になければ null。
// 質問の付箋は、ボタンが持っていなければ（人が置いたボタン）、同じフレームの AI のボタンのものを使う
export function buttonTarget(editor: Editor, buttonId: string): { frameId: string; instruction: string; questionIds: string[] } | null {
  const node = editor.getNode(buttonId)
  if (node?.type !== 'button') return null
  const props = node.props as ButtonProps
  const frameId = editor.index.ancestorsOf(buttonId).find((id) => editor.getNode(id)?.type === 'frame')
  if (!frameId) return null
  const questionIds = props.questionIds?.length ? props.questionIds : answerQuestionIds(editor, frameId)
  return { frameId, instruction: buttonInstruction(props), questionIds }
}

// 答えのフレームの質問の付箋（AI が置いたボタンが持っている）
export function answerQuestionIds(editor: Editor, frameId: string): string[] {
  const ids = editor.index.childrenOf(frameId).flatMap((id) => {
    const node = editor.getNode(id)
    return node?.type === 'button' ? ((node.props as ButtonProps).questionIds ?? []) : []
  })
  return [...new Set(ids)]
}

// 質問の付箋の今の文字（消えた付箋は飛ばす）
export function questionText(editor: Editor, questionIds: readonly string[]): string {
  return questionOf(editor, questionIds)?.question ?? ''
}

export function answerContent(editor: Editor, frameId: string): AnswerContent | null {
  const frame = editor.getNode(frameId)
  if (frame?.type !== 'frame') return null
  const children = answerChildren(editor, frameId)
  const notes = readingOrder(children.filter((entry) => entry.node.type === 'note'))
  const premise = notes.find((entry) => isAssumptionNote(entry.node))
  const buttons = editor.index.childrenOf(frameId).flatMap((id) => {
    const node = editor.getNode(id)
    const props = node?.type === 'button' ? (node.props as ButtonProps) : null
    return props && !props.hint && props.label.trim() ? [clip(props.label.trim(), SENT_BUTTON_LENGTH)] : []
  })
  return {
    frameId,
    title: (frame.props as FrameProps).name,
    assumptions: premise ? assumptionItems(premise.node) : [],
    notes: notes.filter((entry) => entry !== premise).flatMap((entry) => {
      if (!noteText(entry.node)) return []
      const text = noteMarkdown(entry.node)
      return [{ text, edited: noteMeta(entry.node)?.text !== text }]
    }),
    buttons: buttons.slice(0, SENT_BUTTONS),
    history: (frameMeta(frame)?.history ?? []).slice(-SENT_HISTORY).map((item) => clip(item, SENT_HISTORY_LENGTH)),
    signature: JSON.stringify([(frame.props as FrameProps).name, ...children.map((entry) => [entry.node.id, entry.node.type, entry.node.props])]),
  }
}

// 答えをフレームにして、質問の付箋の下（ほかのノードと重なれば、さらに下）に置き、いちばん下の質問の付箋から矢印を引く。
// 質問の付箋の AI モードは解く。followUpOf は、続きの質問なら前の答えのフレーム。1 回の Undo で消える。選択は変えない
export function placeAnswer(
  editor: Editor,
  questionIds: readonly string[],
  answer: CanvasAnswer,
  options: { label?: string; followUpOf?: string } = {},
): string | null {
  const sources = questionIds.flatMap((id) => editor.index.get(id) ?? [])
  const around = unionBoxes(sources.map((entry) => entry.worldBounds))
  if (!around) return null
  const version = versionOf(answer)
  const layout = layoutAnswer(editor, version, questionIds, ANSWER_COLUMN_WIDTH, [version], 0)
  const height = layout.bottom + ANSWER_PADDING
  const box: Box = { x: around.x, y: around.y + around.h + ANSWER_GAP, w: ANSWER_COLUMN_WIDTH + ANSWER_PADDING * 2, h: height }
  const sourceIds = new Set(questionIds)
  for (let guard = 0; guard < 100; guard++) {
    // 質問の付箋を入れたフレーム・スライドもよける（答えは Canvas 直下に置くので、その上に重ねない）
    const blocking = editor.index.search(box).flatMap((id) => {
      const entry = editor.index.get(id)
      return entry && !sourceIds.has(id) && boxesIntersect(entry.worldBounds, box) ? [entry] : []
    })
    if (blocking.length === 0) break
    box.y = Math.max(...blocking.map((entry) => entry.worldBounds.y + entry.worldBounds.h)) + ANSWER_GAP / 2
  }
  // 矢印の始まり（いちばん下の質問の付箋。同じ高さなら左）
  const from = [...sources].sort((a, b) => b.worldBounds.y + b.worldBounds.h - (a.worldBounds.y + a.worldBounds.h) || a.worldBounds.x - b.worldBounds.x)[0]!
  return editor.transact(options.label ?? 'place answer', (tx) => {
    // フレームの切り抜きを受けないよう、Canvas 直下に置く
    const parentId = editor.canvasId
    const local = editor.worldToParent(parentId, box)
    const [frameIndex, arrowIndex] = indicesBetween(editor.index.topmost(parentId)?.index ?? null, null, 2)
    const frame = editor.makeNode('frame', { x: local.x, y: local.y, parentId, props: { w: box.w, h: height, name: answerTitle(version.title) } })
    const meta: FrameAnswerMeta = { history: [], versions: [version], current: 0, ...(options.followUpOf ? { followUpOf: options.followUpOf } : {}) }
    tx.put({ ...frame, index: frameIndex!, meta: { ...frame.meta, answer: meta } })
    const indices = indicesBetween(null, null, layout.children.length)
    layout.children.forEach((child, i) => tx.put({ ...child, parentId: frame.id, index: indices[i]! }))
    // 質問の付箋の下の辺の中ほどから、フレームの上の辺へ（付箋の真下に向ける）
    const start = { x: from.worldBounds.x + from.worldBounds.w / 2, y: from.worldBounds.y + from.worldBounds.h }
    const anchorX = Math.min(0.95, Math.max(0.05, (start.x - box.x) / box.w))
    putArrow(
      editor,
      tx,
      arrowIndex!,
      { id: from.node.id, point: start, anchor: { x: 0.5, y: 1 } },
      { id: frame.id, point: { x: box.x + anchorX * box.w, y: box.y }, anchor: { x: anchorX, y: 0 } },
    )
    for (const id of questionIds) {
      const node = nodeIn(tx, id)
      if (node && node.meta?.ai !== undefined) tx.put({ ...node, meta: withoutKey(node.meta, 'ai') })
    }
    return frame.id
  })
}

// フレームの付箋と AI が置いたボタンを、答えで置き換える。ほかの子（人が置いたボタン・画像など）は、並びを保ったまま新しい答えの下へずらす。
// フレームの高さを中身に合わせ、名前を答えの題にし、当てた指示（instruction）をこれまでの指示に足す。
// 今の中身（人が書き換えたところも）は今の版に書き戻し、新しい答えを最後の版にする（via は、押したボタンの文字）。1 回の Undo で戻る
export function replaceAnswer(
  editor: Editor,
  frameId: string,
  answer: CanvasAnswer,
  questionIds: readonly string[],
  options: { label?: string; instruction?: string; via?: string } = {},
): boolean {
  const frame = editor.getNode(frameId)
  if (frame?.type !== 'frame') return false
  const meta = frameMeta(frame) ?? { history: [] }
  const via = options.via?.trim()
  const versions = [...savedVersions(editor, frameId, meta).versions, { ...versionOf(answer), ...(via ? { via } : {}) }].slice(-KEPT_VERSIONS)
  const history = [...meta.history, ...(options.instruction?.trim() ? [options.instruction.trim()] : [])].slice(-KEPT_HISTORY)
  rebuildAnswer(editor, frameId, versions, versions.length - 1, questionIds, { ...meta, history }, options.label ?? 'rewrite answer')
  return true
}

// 版 index の答えに戻す（進む）。今の中身は今の版に書き戻す。Claude は呼ばない。1 回の Undo で戻る。戻せなければ false
export function restoreAnswerVersion(editor: Editor, frameId: string, index: number, options: { label?: string } = {}): boolean {
  const frame = editor.getNode(frameId)
  if (frame?.type !== 'frame') return false
  const meta = frameMeta(frame)
  if (!meta?.versions || index < 0 || index >= meta.versions.length || index === (meta.current ?? meta.versions.length - 1)) return false
  const { versions } = savedVersions(editor, frameId, meta)
  rebuildAnswer(editor, frameId, versions, index, answerQuestionIds(editor, frameId), meta, options.label ?? 'restore answer')
  return true
}

// フレームの版の一覧（今の中身を今の版に書き戻したもの）。版を持たない古いフレームは、今の中身を最初の版にする
function savedVersions(editor: Editor, frameId: string, meta: FrameAnswerMeta): { versions: AnswerVersion[]; current: number } {
  const versions = [...(meta.versions ?? [])]
  const current = meta.current ?? versions.length - 1
  const via = versions[current]?.via
  const shown = { ...currentVersion(editor, frameId), ...(via ? { via } : {}) }
  if (current < 0) return { versions: [shown], current: 0 }
  versions[current] = shown
  return { versions, current }
}

// 版 current の答えでフレームの中身を置き換える（replaceAnswer と restoreAnswerVersion の共通部分）
function rebuildAnswer(
  editor: Editor,
  frameId: string,
  versions: AnswerVersion[],
  current: number,
  questionIds: readonly string[],
  meta: FrameAnswerMeta,
  label: string,
): void {
  const frame = editor.getNode(frameId)!
  const props = frame.props as FrameProps
  const version = versions[current]!
  const replaced = new Set(answerChildren(editor, frameId).map((entry) => entry.node.id))
  const kept = editor.index.childrenOf(frameId).flatMap((id) => (replaced.has(id) ? [] : (editor.getNode(id) ?? [])))
  // フレームの今の幅に合わせる（広げてあれば付箋もその幅に。前の幅で置いたフレームを勝手に広げない）
  const width = Math.max(PLUS_WIDTH * 2 + BUTTON_GAP * 2 + VERSION_BAR_WIDTH, props.w - ANSWER_PADDING * 2)
  const layout = layoutAnswer(editor, version, questionIds, width, versions, current)
  // 残す子の上端・下端（フレームのローカル座標。回したものは回す前の箱で見る）
  const span = kept.map((node) => {
    const bounds = editor.getType(node).getBounds(node)
    return { top: node.y + bounds.y, bottom: node.y + bounds.y + bounds.h }
  })
  const keptTop = Math.min(...span.map((s) => s.top))
  const dy = kept.length > 0 ? layout.bottom + SECTION_GAP - keptTop : 0
  const bottom = Math.max(layout.bottom, ...span.map((s) => s.bottom + dy))
  editor.transact(label, (tx) => {
    for (const id of replaced) tx.remove(id)
    // 消した付箋につながっていた矢印は、消したときに端が止まる（unbind）。その後の形から動かす
    for (const { id } of kept) {
      const node = nodeIn(tx, id)
      if (node && dy !== 0) tx.put({ ...node, y: node.y + dy })
    }
    tx.put({
      ...frame,
      props: { ...props, w: width + ANSWER_PADDING * 2, h: bottom + ANSWER_PADDING, name: answerTitle(version.title) },
      meta: { ...frame.meta, answer: { ...meta, versions, current } satisfies FrameAnswerMeta },
    })
    const indices = indicesBetween(editor.index.topmost(frameId)?.index ?? null, null, layout.children.length)
    layout.children.forEach((child, i) => tx.put({ ...child, parentId: frameId, index: indices[i]! }))
  })
}

// 今のフレームの中身を版にする（人が書き換えた付箋は original に AI の文字を持つ。via は付けない）
function currentVersion(editor: Editor, frameId: string): AnswerVersion {
  const frame = editor.getNode(frameId)!
  const children = answerChildren(editor, frameId)
  const notes = readingOrder(children.filter((entry) => entry.node.type === 'note'))
  const premise = notes.find((entry) => isAssumptionNote(entry.node))
  const hints = children.flatMap((entry) => {
    const props = entry.node.type === 'button' ? (entry.node.props as ButtonProps) : null
    return props && !props.action && props.label.trim() ? [{ label: props.label.trim(), prompt: props.prompt.trim() }] : []
  })
  return {
    title: (frame.props as FrameProps).name,
    assumptions: premise ? assumptionItems(premise.node).map((item) => (item.edited ? { text: item.text, original: '' } : { text: item.text })) : [],
    paragraphs: notes
      .filter((entry) => entry !== premise && noteText(entry.node))
      .map((entry) => {
        const text = noteMarkdown(entry.node)
        const original = noteMeta(entry.node)?.text ?? ''
        return original === text ? { text } : { text, original }
      }),
    hints,
  }
}

// Claude の答えを版にする
function versionOf(answer: CanvasAnswer): AnswerVersion {
  return {
    title: answer.title,
    assumptions: answer.assumptions.map((text) => ({ text })),
    paragraphs: answer.paragraphs.map((text) => ({ text })),
    hints: answer.hints.map((hint) => ({ label: hint.label, prompt: hint.prompt })),
  }
}

// 「＋」を押したとき：答えのフレームの横（side）に、続きの質問の付箋（AI モード。前の答えを添える）を置き、フレームから矢印を引く。
// 付箋の高さは、答えの質問の付箋の上端にそろえる（なければフレームの上端）。ほかのノードと重なれば、さらに外へずらす。
// tx の中で置く（呼ぶ側が、置いたあとに文字の編集を始めて、1 回の Undo にまとめる）。置いた付箋の id を返す
export function placeFollowUp(editor: Editor, tx: Transaction<WorkspaceRecord>, frameId: string, side: 'left' | 'right'): string | null {
  const frameEntry = editor.index.get(frameId)
  if (frameEntry?.node.type !== 'frame') return null
  const frameBox = frameEntry.worldBounds
  const questions = answerQuestionIds(editor, frameId).flatMap((id) => editor.index.get(id) ?? [])
  const top = questions.length > 0 ? Math.min(...questions.map((entry) => entry.worldBounds.y)) : frameBox.y
  const draft = editor.makeNode('note', { x: 0, y: 0, parentId: editor.canvasId }) as NodeRecord<NoteProps>
  const size = { w: draft.props.w, h: noteHeight(draft.props) }
  const box: Box = { x: side === 'right' ? frameBox.x + frameBox.w + FOLLOW_UP_GAP : frameBox.x - FOLLOW_UP_GAP - size.w, y: top, ...size }
  for (let guard = 0; guard < 100; guard++) {
    const blocking = editor.index.search(box).flatMap((id) => {
      const entry = editor.index.get(id)
      return entry && boxesIntersect(entry.worldBounds, box) ? [entry] : []
    })
    if (blocking.length === 0) break
    box.x =
      side === 'right'
        ? Math.max(...blocking.map((entry) => entry.worldBounds.x + entry.worldBounds.w)) + FOLLOW_UP_GAP
        : Math.min(...blocking.map((entry) => entry.worldBounds.x)) - FOLLOW_UP_GAP - size.w
  }
  const local = editor.worldToParent(editor.canvasId, box)
  const [noteIndex, arrowIndex] = indicesBetween(editor.index.topmost(editor.canvasId)?.index ?? null, null, 2)
  const ai: AiNoteMeta = { contexts: [{ kind: 'answer', frameId, label: (frameEntry.node.props as FrameProps).name }] }
  tx.put({ ...draft, x: local.x, y: local.y, index: noteIndex!, meta: { ...draft.meta, ai } })
  // フレームの上の辺の端（付箋がフレームの上端より上にあるとき）か横の辺から、付箋の向かい合う辺の中ほどへ
  const noteMid = { x: side === 'right' ? box.x : box.x + box.w, y: box.y + box.h / 2 }
  const startAnchor =
    noteMid.y < frameBox.y + 24
      ? { x: side === 'right' ? 0.9 : 0.1, y: 0 }
      : { x: side === 'right' ? 1 : 0, y: Math.min(1, (noteMid.y - frameBox.y) / Math.max(1, frameBox.h)) }
  putArrow(
    editor,
    tx,
    arrowIndex!,
    { id: frameId, point: { x: frameBox.x + startAnchor.x * frameBox.w, y: frameBox.y + startAnchor.y * frameBox.h }, anchor: startAnchor },
    { id: draft.id, point: noteMid, anchor: { x: side === 'right' ? 0 : 1, y: 0.5 } },
  )
  return draft.id
}

// AI モードの付箋の meta.ai（AI モードでなければ null）
export function aiNoteMeta(node: NodeRecord | undefined): AiNoteMeta | null {
  const meta = node?.type === 'note' ? (node.meta?.ai as AiNoteMeta | undefined) : undefined
  if (!meta || typeof meta !== 'object') return null
  const contexts = Array.isArray(meta.contexts)
    ? meta.contexts.filter((context): context is AiContext => typeof context === 'object' && context !== null && (context.kind === 'answer' || context.kind === 'canvas'))
    : []
  return {
    contexts,
    ...(typeof meta.model === 'string' ? { model: meta.model } : {}),
    ...(typeof meta.effort === 'string' ? { effort: meta.effort } : {}),
  }
}

// 付箋の AI モードを変える。meta が null なら解く。付箋でなければ false
export function setAiNote(editor: Editor, noteId: string, meta: AiNoteMeta | null, label = meta ? 'AI mode' : 'end AI mode'): boolean {
  const node = editor.getNode(noteId)
  if (node?.type !== 'note') return false
  editor.transact(label, (tx) => {
    const current = nodeIn(tx, noteId)!
    tx.put({ ...current, meta: meta ? { ...current.meta, ai: meta } : withoutKey(current.meta, 'ai') })
  })
  return true
}

// 続きの質問で Claude に渡す前の答え（frameId の答えから、その前の答えへさかのぼる。古い方から、max 個まで）
export function previousTurns(editor: Editor, frameId: string, max = PREVIOUS_TURNS): PreviousTurn[] {
  const turns: PreviousTurn[] = []
  const seen = new Set<string>()
  let id: string | undefined = frameId
  while (id && turns.length < max && !seen.has(id)) {
    seen.add(id)
    const frame = editor.getNode(id)
    const content = answerContent(editor, id)
    if (!frame || !content) break
    turns.unshift({ question: questionText(editor, answerQuestionIds(editor, id)), title: content.title, paragraphs: content.notes.map((note) => note.text) })
    id = frameMeta(frame)?.followUpOf
  }
  return turns
}

// 続きの質問の答えなら、前の答えのフレーム
export function answerFollowUpOf(editor: Editor, frameId: string): string | undefined {
  const frame = editor.getNode(frameId)
  return frame?.type === 'frame' ? frameMeta(frame)?.followUpOf : undefined
}

// 版の帯の説明（ホバーで出す）
export function versionTooltip(versions: readonly Pick<AnswerVersion, 'via'>[], index: number, current: number): string {
  if (index === current) return versions[index]?.via ? `今の回答（「${versions[index]!.via}」）` : '今の回答'
  const steps = Math.abs(index - current)
  const count = steps === 1 ? 'ひとつ' : `${steps} つ`
  if (index < current) {
    const next = versions[index + 1]?.via
    return `${count}前の回答に戻る${next ? `（「${next}」を押す前）` : ''}`
  }
  const via = versions[index]?.via
  return `${count}後の回答に進む${via ? `（「${via}」）` : ''}`
}

// 2 つのノード（フレームも）を矢印でつなぐ。端は anchor（ノードの箱の中の割合）に向ける。どちらかの端を消したら、矢印も一緒に消える（REMOVE_WITH_ENDS）
function putArrow(
  editor: Editor,
  tx: Transaction<WorkspaceRecord>,
  index: string,
  from: { id: string; point: { x: number; y: number }; anchor: { x: number; y: number } },
  to: { id: string; point: { x: number; y: number }; anchor: { x: number; y: number } },
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

function withoutKey(meta: Record<string, unknown> | undefined, key: string): Record<string, unknown> {
  const rest = { ...meta }
  delete rest[key]
  return rest
}

// ドラッグ・文字の編集などのトランザクションが開いている間は書けない（Store.begin が投げる）ので、閉じるまで待つ。
// signal で止めたら、閉じていなくても戻る（呼ぶ側が signal を見る）
export async function waitUntilIdle(editor: Editor, signal?: AbortSignal, intervalMs = 200): Promise<void> {
  while (editor.store.activeTransaction && !signal?.aborted) await new Promise((resolve) => setTimeout(resolve, intervalMs))
}

// 前提の付箋の段落（見出しを太字にし、前提を箇条書きにする）。前提は付箋の Markdown（1 項目の中の改行は空白にする）。base は付箋の既定の書式
export function assumptionParagraphs(assumptions: readonly string[], base?: TextRunFormat): TextParagraph[] {
  const items = assumptions.flatMap((item): TextParagraph[] => {
    const runs = richTextFromMarkdown(item.replace(/\s*\n\s*/g, ' '), { ...(base ? { base } : {}), inlineFirstLine: true })[0]?.runs ?? []
    return runs.some((run) => run.text.trim() !== '') ? [{ runs, list: { type: 'bullet', level: 0 } }] : []
  })
  return normalizeRichText([{ runs: [{ text: ASSUMPTION_HEADING, format: { fontWeight: 700 } }] }, ...items], base)
}

function noteMeta(node: NodeRecord): NoteAnswerMeta | null {
  const meta = node.meta?.answer as NoteAnswerMeta | undefined
  return meta && (meta.role === 'assumptions' || meta.role === 'paragraph') ? meta : null
}

function frameMeta(node: NodeRecord): FrameAnswerMeta | null {
  const meta = node.meta?.answer as FrameAnswerMeta | undefined
  if (!meta || !Array.isArray(meta.history)) return null
  const versions = Array.isArray(meta.versions) ? meta.versions.filter(isVersion) : []
  return {
    history: meta.history.filter((item): item is string => typeof item === 'string'),
    ...(versions.length > 0 ? { versions } : {}),
    ...(versions.length > 0 && typeof meta.current === 'number' && meta.current >= 0 && meta.current < versions.length ? { current: meta.current } : {}),
    ...(typeof meta.followUpOf === 'string' ? { followUpOf: meta.followUpOf } : {}),
  }
}

function isVersion(value: unknown): value is AnswerVersion {
  if (typeof value !== 'object' || value === null) return false
  const version = value as AnswerVersion
  const items = (list: unknown) => Array.isArray(list) && list.every((item) => typeof item === 'object' && item !== null && typeof (item as AnswerVersionItem).text === 'string')
  return typeof version.title === 'string' && items(version.assumptions) && items(version.paragraphs) && Array.isArray(version.hints)
}

// 前提の付箋か（AI が前提として置いたもの。meta がなければ、1 行目が見出しで始まるもの）
function isAssumptionNote(node: NodeRecord): boolean {
  const meta = noteMeta(node)
  if (meta) return meta.role === 'assumptions'
  return noteLines(node)[0]?.startsWith(ASSUMPTION_HEADING) ?? false
}

// 前提の付箋の項目（見出しの行を除いた、空でない行の付箋の Markdown）。置いたときの項目にないもの（書式だけを変えたものも）に edited の印を付ける
function assumptionItems(node: NodeRecord): AnswerItem[] {
  const original = new Set(noteMeta(node)?.items ?? [])
  return premiseLines(paragraphsOf(node.props as NoteProps), noteBase(node.props as NoteProps)).map((text) => ({ text, edited: !original.has(text) }))
}

// 前提の付箋の段落から、項目の付箋の Markdown（見出しの行と空の行を除き、箇条書きの記号は書かない）
function premiseLines(paragraphs: readonly TextParagraph[], base: TextRunFormat): string[] {
  const body = plainTextOf(paragraphs.slice(0, 1)).trim().startsWith(ASSUMPTION_HEADING) ? paragraphs.slice(1) : paragraphs
  return body.filter((paragraph) => plainTextOf([paragraph]).trim() !== '').map((paragraph) => richTextToMarkdown([{ runs: paragraph.runs }], { base }).trim())
}

// 付箋の文字の付箋の Markdown（付箋の既定の書式と同じ値は書かない）
function noteMarkdown(node: NodeRecord): string {
  const props = node.props as NoteProps
  return richTextToMarkdown(paragraphsOf(props), { base: noteBase(props) }).trim()
}

// 付箋の既定の書式（Markdown に書かない値。見出しの大きさの基準）
function noteBase(props: NoteProps): TextRunFormat {
  return baseFormatOf(noteStyle({ ...noteType.defaultProps(), ...props }))
}

function noteLines(node: NodeRecord): string[] {
  return paragraphsOf(node.props as NoteProps).map((paragraph) => plainTextOf([paragraph]).trim())
}

// フレームの中身（フレームのローカル座標。parentId と index はまだ決めない）と、中身の下端。width は付箋の幅。
// versions と current は版の帯に使う（版が 2 つ以上のときだけ置く）
function layoutAnswer(
  editor: Editor,
  version: AnswerVersion,
  questionIds: readonly string[],
  width: number,
  versions: readonly AnswerVersion[],
  current: number,
): { children: NodeRecord[]; bottom: number } {
  const children: NodeRecord[] = []
  let bottom = 0
  // 答えの付箋の props（文字のほか）と、その既定の書式（付箋の Markdown を読むときの基準）
  const shape = (color?: string): NoteProps => ({ ...noteType.defaultProps(), w: width, fontSize: ANSWER_FONT_SIZE, sizing: 'auto', ...(color ? { color } : {}) })
  const addNote = (paragraphs: TextParagraph[], meta: NoteAnswerMeta, props: NoteProps) => {
    const y = bottom + (children.length > 0 ? NOTE_GAP : ANSWER_PADDING)
    const node = editor.makeNode('note', { x: ANSWER_PADDING, y, props: { ...props, paragraphs } })
    children.push({ ...node, meta: { ...node.meta, answer: meta } })
    bottom = y + noteHeight(node.props as NoteProps)
  }
  // 置いたときの文字は、付箋から読み戻したとき（answerContent）と同じ形で覚える（比べて、人が書き換えたかを見る）。
  // 人が書き換えた版の付箋は、AI が置いたときの文字（original）を覚える（書き換えた印が残る）
  const premise = shape(ASSUMPTION_COLOR)
  const premiseBase = noteBase(premise)
  const premiseParagraphs = assumptionParagraphs(
    version.assumptions.map((item) => item.text),
    premiseBase,
  )
  if (premiseParagraphs.length > 1) {
    const items = version.assumptions.flatMap((item) => (item.original === undefined ? premiseLines(assumptionParagraphs([item.text], premiseBase), premiseBase) : []))
    addNote(premiseParagraphs, { role: 'assumptions', items }, premise)
  }
  for (const item of version.paragraphs) {
    const props = shape()
    const base = noteBase(props)
    const paragraphs = richTextFromMarkdown(item.text.trim(), { base })
    if (plainTextOf(paragraphs).trim()) addNote(paragraphs, { role: 'paragraph', text: item.original ?? richTextToMarkdown(paragraphs, { base }).trim() }, props)
  }
  const button = (props: Partial<ButtonProps>, x: number, y: number): NodeRecord => {
    const node = editor.makeNode('button', { x: 0, y: 0, props: { hint: true, questionIds: [...questionIds], ...props } })
    return { ...node, x, y }
  }
  const sizeOf = (node: NodeRecord) => editor.getType(node).getBounds(node)
  // ボタンの並び：左右の端に「＋」、その間に書き直すボタンを左から並べ、幅に収まらなければ次の行へ
  const rowTop = bottom + (children.length > 0 ? SECTION_GAP : ANSWER_PADDING)
  const innerLeft = PLUS_WIDTH + BUTTON_GAP
  const innerWidth = Math.max(1, width - (PLUS_WIDTH + BUTTON_GAP) * 2)
  const hints = version.hints.filter((hint) => hint.label.trim() !== '')
  let x = 0
  let y = rowTop
  let rowBottom = rowTop
  for (const hint of hints) {
    const node = button({ label: hint.label.trim(), prompt: hint.prompt.trim() }, 0, 0)
    const size = sizeOf(node)
    if (x > 0 && x + size.w > innerWidth) {
      x = 0
      y = rowBottom + BUTTON_GAP
    }
    children.push({ ...node, x: ANSWER_PADDING + innerLeft + x, y })
    x += size.w + BUTTON_GAP
    rowBottom = Math.max(rowBottom, y + size.h)
  }
  // ボタンがなくても、「＋」は 1 行ぶんの高さにする
  if (rowBottom === rowTop) rowBottom = rowTop + sizeOf(button({ label: '＋' }, 0, 0)).h
  const plus = (side: 'left' | 'right') =>
    button(
      {
        label: '＋',
        prompt: '',
        color: PLUS_COLOR,
        w: PLUS_WIDTH,
        h: rowBottom - rowTop,
        sizing: 'fixed',
        action: side === 'left' ? 'ask-left' : 'ask-right',
        tooltip: side === 'left' ? '左に続きの質問を置く' : '右に続きの質問を置く',
      },
      side === 'left' ? ANSWER_PADDING : ANSWER_PADDING + width - PLUS_WIDTH,
      rowTop,
    )
  children.push(plus('left'), plus('right'))
  bottom = rowBottom
  // 版の帯（古い版から。今の版は濃く）
  if (versions.length > 1) {
    let barX = 0
    let barY = bottom + BUTTON_GAP + 4
    versions.forEach((_, index) => {
      if (barX > 0 && barX + VERSION_BAR_WIDTH > width) {
        barX = 0
        barY += VERSION_BAR_HEIGHT + VERSION_BAR_GAP
      }
      children.push(
        button(
          {
            label: '',
            prompt: '',
            color: index === current ? VERSION_BAR_CURRENT_COLOR : VERSION_BAR_COLOR,
            w: VERSION_BAR_WIDTH,
            h: VERSION_BAR_HEIGHT,
            sizing: 'fixed',
            action: 'version',
            version: index,
            tooltip: versionTooltip(versions, index, current),
          },
          ANSWER_PADDING + barX,
          barY,
        ),
      )
      barX += VERSION_BAR_WIDTH + VERSION_BAR_GAP
    })
    bottom = barY + VERSION_BAR_HEIGHT
  }
  return { children, bottom: Math.max(bottom, ANSWER_PADDING) }
}

function answerTitle(title: string): string {
  return title.trim() || '答え'
}

// フレームの直下の付箋と、AI が置いたボタン（答えとして置き換えるもの）
function answerChildren(editor: Editor, frameId: string): IndexEntry[] {
  return editor.index.childrenOf(frameId).flatMap((id) => {
    const entry = editor.index.get(id)
    if (!entry) return []
    const answerPart = entry.node.type === 'note' || (entry.node.type === 'button' && (entry.node.props as ButtonProps).hint === true)
    return answerPart ? [entry] : []
  })
}

function noteText(node: NodeRecord): string {
  return plainTextOf((node.props as NoteProps).paragraphs).trim()
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
