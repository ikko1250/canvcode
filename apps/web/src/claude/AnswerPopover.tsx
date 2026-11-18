import { useEffect, useRef, type KeyboardEvent } from 'react'
import type { Camera } from '@canvcode/core'
import { OWN_KEYS_ATTRIBUTE, aiNoteMeta, firstLine, questionText, type CanvasView, type Editor } from '@canvcode/canvas'
import { AnswerView, type AnswerProgress, type RelatedNote } from './AnswerView.tsx'
import type { Effort, ModelCatalog } from './claudeClient.ts'
import { settingLabel } from './modelChoice.ts'
import { useNodesVersion } from './useNodesVersion.ts'

// 付箋の横の答えのパネル（docs/canvas-answer-panel-plan.md の 4）。付箋の角の三角を押すと開く。
// - 付箋の右上に合わせて、付箋の右に出す（右に入らなければ左）。カメラに付いて動くが、大きさは倍率によらない（幅 POPOVER_WIDTH、高さは中身に合わせて
//   POPOVER_MAX_HEIGHT まで。本文は中でスクロール）。キャンバスの端からはみ出さない
// - 上に「回答」とモデルの札。その下は AnswerView（本文・関連する付箋・「続けて聞く」「Canvasに残す」。答えを作っている間は進み具合）
// - 閉じる：同じ三角をもう一度押す（App）・Esc・パネルの外のキャンバスを押す（左ボタン。付箋の下の欄の上は除く）・付箋が消えた
// - 開いたらパネルにフォーカスする。フォーカスがある間は、付箋の下の欄を出す（onFocusChange）。パネルの中のキー入力は、キャンバスに渡さない

export const POPOVER_WIDTH = 360
export const POPOVER_MAX_HEIGHT = 480
// 付箋とパネルの間・キャンバスの端との間（画面の CSS ピクセル）
const GAP = 12
const EDGE = 8
// 関連する付箋の名前の長さ
const RELATED_LABEL_LENGTH = 30

export function AnswerPopover(props: {
  editor: Editor
  view: CanvasView
  camera: Camera
  noteId: string
  catalog: ModelCatalog | undefined
  // 答えを作っている間の進み具合と、そのモデル
  progress: AnswerProgress | null
  runningModel?: { model?: string; effort?: string }
  error?: string
  onClose(): void
  // 答えを見た（質問のタブの青い点を消す）
  onSeen(noteId: string, answeredAt: number): void
  onFocusChange(focused: boolean): void
  onRelated(id: string): void
  onContinue(): void
  onKeep(): void
  onStop?(): void
  // 会話で続ける（Claude を使えないときは渡さない）。chatTitle は、いま会話のタブで選んでいる会話の題
  onChat?(newThread: boolean): void
  chatTitle?: string | null
}) {
  const { editor, view, camera, noteId, catalog, progress, runningModel, error, onClose, onSeen, onFocusChange, onRelated, onContinue, onKeep, onStop, onChat, chatTitle } = props
  const rootRef = useRef<HTMLElement>(null)
  // 付箋（と関連する付箋）が変わったら読み直す
  useNodesVersion(editor)
  const node = editor.getNode(noteId)
  const box = editor.index.get(noteId)?.worldBounds
  const answer = aiNoteMeta(node)?.answer ?? null

  // 付箋が消えたら閉じる
  const gone = !node || !box
  useEffect(() => {
    if (gone) onClose()
  }, [gone, onClose])

  // 答えを見たことにする
  const answeredAt = answer?.answeredAt
  useEffect(() => {
    if (answeredAt !== undefined) onSeen(noteId, answeredAt)
  }, [noteId, answeredAt, onSeen])

  // 開いたら（別の付箋に替わったら）、パネルにフォーカスする
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [noteId])

  // パネルの外のキャンバスを押したら閉じる。同じ付箋の三角の上（三角が開け閉めする）と、付箋の下の欄の上は除く
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target
      if (!(target instanceof Node) || rootRef.current?.contains(target) || e.button !== 0) return
      if (target instanceof Element && target.closest('.ai-note-controls, .ai-note-chip')) return
      if (!view.root.contains(target)) return
      if (editor.session.get().hoveredAiCorner === noteId) return
      onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [editor, view, noteId, onClose])

  if (gone) return null

  const width = view.root.clientWidth
  const height = view.root.clientHeight
  let left = (box.x + box.w - camera.x) * camera.zoom + GAP
  if (left + POPOVER_WIDTH > width - EDGE) left = (box.x - camera.x) * camera.zoom - GAP - POPOVER_WIDTH
  left = Math.max(EDGE, Math.min(left, width - POPOVER_WIDTH - EDGE))
  const top = Math.max(EDGE, Math.min((box.y - camera.y) * camera.zoom, height - 160))
  const maxHeight = Math.max(160, Math.min(POPOVER_MAX_HEIGHT, height - top - EDGE))

  const related: RelatedNote[] = (answer?.related ?? []).flatMap((id) =>
    editor.getNode(id)?.type === 'note' ? [{ id, label: firstLine(questionText(editor, [id]), RELATED_LABEL_LENGTH) }] : [],
  )
  const questionChanged = answer ? questionText(editor, [noteId, ...(answer.questionIds ?? [])]) !== answer.question : false
  const model = answer && !progress ? { model: answer.model, effort: answer.effort } : runningModel
  const label = model?.model ? settingLabel(catalog, { model: model.model, ...(model.effort ? { effort: model.effort as Effort } : {}) }) : ''

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <aside
      ref={rootRef}
      className="answer-popover"
      aria-label="Claude の回答"
      tabIndex={-1}
      style={{ left, top, width: POPOVER_WIDTH, maxHeight }}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
      onFocus={() => onFocusChange(true)}
      onBlur={(e) => {
        if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) onFocusChange(false)
      }}
      {...{ [OWN_KEYS_ATTRIBUTE]: '' }}
    >
      <div className="answer-popover-head">
        <strong>回答</strong>
        {label && <span className="answer-popover-model">{label}</span>}
      </div>
      <AnswerView
        answer={answer}
        progress={progress}
        {...(error ? { error } : {})}
        questionChanged={questionChanged}
        related={related}
        onRelated={onRelated}
        onContinue={onContinue}
        onKeep={onKeep}
        {...(onStop ? { onStop } : {})}
        {...(onChat && answer ? { onChat, chatTitle: chatTitle ?? null } : {})}
      />
    </aside>
  )
}
