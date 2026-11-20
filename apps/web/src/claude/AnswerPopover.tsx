import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'
import type { Camera } from '@canvcode/core'
import { OWN_KEYS_ATTRIBUTE, aiNoteMeta, firstLine, questionText, type CanvasView, type Editor } from '@canvcode/canvas'
import { AnswerView, type AnswerProgress, type RelatedNote, type TaskProgress } from './AnswerView.tsx'
import type { Effort, ModelCatalog } from './claudeClient.ts'
import { settingLabel } from './modelChoice.ts'
import { useNodesVersion } from './useNodesVersion.ts'

// 付箋の横の答えのパネル（docs/canvas-answer-panel-plan.md の 4）。付箋の角の三角を押すと開く。
// - 付箋の右上に合わせて、付箋の右に出す（右に入らなければ左）。カメラに付いて動くが、大きさは倍率によらない（幅 POPOVER_WIDTH、高さは中身に合わせて
//   POPOVER_MAX_HEIGHT まで。本文は中でスクロール）。キャンバスの端からはみ出さない。
//   下が詰まっているとき（付箋の上の端に合わせると、パネルの下の端がキャンバスの下にはみ出す）は、収まる所まで上にずらす
//   （docs/answer-popover-size-plan.md）。高さの上限はキャンバスの高さだけで決め、位置によらない（測った高さで位置を決めても、高さが変わらない）
//   右のデザインパネルを出しているときは、その左端を右の端とする（パネルはデザインパネルの下に重なるので、隠れないように）
// - 上に「回答」（付箋の作業なら「作業」）とモデルの札。その下は AnswerView（本文・関連する付箋・「続けて聞く」「Canvasに残す」。
//   答えを作っている間は進み具合、付箋の作業の間はその様子）
// - 閉じる：同じ三角をもう一度押す（App）・Esc・パネルの外のキャンバスを押す（左ボタン。付箋の下の欄の上は除く）・付箋が消えた
// - 開いたらパネルにフォーカスする。パネルか付箋の下の欄にフォーカスがある間は、欄を出す（onFocusChange）。パネルの中のキー入力は、キャンバスに渡さない。
//   どちらにあるかは、文書の focusin で決める（blur では決めない）。欄のボタンを押すとフォーカスが欄へ移るので、そこで欄を消すと押せない。
//   また、押したボタンが消えた（× で外した）・押せなくなった（送信）ときは、フォーカスが body へ落ちるだけで focusin は来ない。
//   そのときは欄を出したままにする（ほかへフォーカスが移るか、パネルを閉じるまで）

export const POPOVER_WIDTH = 360
export const POPOVER_MAX_HEIGHT = 640
// 付箋とパネルの間・キャンバスの端との間（画面の CSS ピクセル）
const GAP = 12
const EDGE = 8
// 高さの上限の下限（キャンバスがこれより低くても、ここまではとる）
const MIN_HEIGHT = 160
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
  // 付箋の作業の間の様子
  task?: TaskProgress | null
  runningModel?: { model?: string; effort?: string }
  error?: string
  onClose(): void
  // 答えを見た（質問のタブの青い点を消す）
  onSeen(noteId: string, answeredAt: number): void
  onFocusChange(focused: boolean): void
  // 右のデザインパネルを出している
  besideDesignPanel?: boolean
  onRelated(id: string): void
  onContinue(): void
  onKeep(): void
  onStop?(): void
  // 会話で続ける（Claude を使えないときは渡さない）。chatTitle は、いま会話のタブで選んでいる会話の題
  onChat?(newThread: boolean): void
  chatTitle?: string | null
  // 作業の報告の「チャットで続ける」
  onOpenThread?(threadId: string, jobId?: string): void
}) {
  const { editor, view, camera, noteId, catalog, progress, task, runningModel, error, onClose, onSeen, onFocusChange, besideDesignPanel, onRelated, onContinue, onKeep, onStop, onChat, chatTitle, onOpenThread } =
    props
  const rootRef = useRef<HTMLElement>(null)
  // パネルの実際の高さ（中身に合わせた高さ。下が詰まっているときに、どれだけ上にずらすかを決める）
  const [boxHeight, setBoxHeight] = useState(0)
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

  // フォーカスがパネルか付箋の下の欄に入ったか、ほかへ入ったか（下のフォーカスする effect より先に聞き始める）
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target
      onFocusChange(target instanceof Element && (rootRef.current?.contains(target) === true || target.closest('.ai-note-controls') !== null))
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [onFocusChange])

  // 高さを測る。出したときと、大きさが変わったとき（答えが届いた・書体を読み込んだなど）。ResizeObserver の知らせは描く前に来るので、
  // flushSync でその場で位置を直す（ふつうの setState だと次のタスクで描き直すので、はみ出した位置が一瞬出る）
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    setBoxHeight(el.offsetHeight)
    const observer = new ResizeObserver(() => flushSync(() => setBoxHeight(el.offsetHeight)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [gone])

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
  // 右の端（キャンバスの右端か、デザインパネルの左端。キャンバスの左上を 0 とする）
  const panel = besideDesignPanel ? document.querySelector('[data-testid="design-panel"]') : null
  const right = panel ? Math.min(width, panel.getBoundingClientRect().left - view.root.getBoundingClientRect().left) : width
  let left = (box.x + box.w - camera.x) * camera.zoom + GAP
  if (left + POPOVER_WIDTH > right - EDGE) left = (box.x - camera.x) * camera.zoom - GAP - POPOVER_WIDTH
  left = Math.max(EDGE, Math.min(left, right - POPOVER_WIDTH - EDGE))
  const maxHeight = Math.max(MIN_HEIGHT, Math.min(POPOVER_MAX_HEIGHT, height - 2 * EDGE))
  // 上の端は付箋の上の端に合わせる。下の端がキャンバスの下にはみ出すなら、収まる所まで上にずらす（キャンバスの上の端より上にはしない）
  const top = Math.max(EDGE, Math.min((box.y - camera.y) * camera.zoom, height - EDGE - Math.min(boxHeight, maxHeight)))

  const related: RelatedNote[] = (answer?.related ?? []).flatMap((id) =>
    editor.getNode(id)?.type === 'note' ? [{ id, label: firstLine(questionText(editor, [id]), RELATED_LABEL_LENGTH) }] : [],
  )
  const questionChanged = answer ? questionText(editor, [noteId, ...(answer.questionIds ?? [])]) !== answer.question : false
  const model = answer && !progress && !task ? { model: answer.model, effort: answer.effort } : runningModel
  const working = Boolean(task || answer?.threadId)
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
      aria-label={working ? 'Claude の作業' : 'Claude の回答'}
      tabIndex={-1}
      style={{ left, top, width: POPOVER_WIDTH, maxHeight }}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
      {...{ [OWN_KEYS_ATTRIBUTE]: '' }}
    >
      <div className="answer-popover-head">
        <strong>{working ? '作業' : '回答'}</strong>
        {label && <span className="answer-popover-model">{label}</span>}
      </div>
      <AnswerView
        answer={answer}
        progress={progress}
        task={task ?? null}
        {...(error ? { error } : {})}
        questionChanged={questionChanged}
        related={related}
        onRelated={onRelated}
        onContinue={onContinue}
        onKeep={onKeep}
        {...(onStop ? { onStop } : {})}
        {...(onChat && answer ? { onChat, chatTitle: chatTitle ?? null } : {})}
        {...(onOpenThread ? { onOpenThread } : {})}
      />
    </aside>
  )
}
