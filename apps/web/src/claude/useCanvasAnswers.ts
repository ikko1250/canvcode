import { useCallback, useRef, useState, type RefObject } from 'react'
import { MAX_AI_PLACES, aiNoteMeta, answerCandidates, previousTurnsOf, questionOf, type CanvasView } from '@canvcode/canvas'
import { NoteTaskUndoError, runningNoteTasks, type ClaudeClient, type Effort } from './claudeClient.ts'
import { loadSetting, type ModelSetting } from './modelChoice.ts'

// AI 付箋の作業（付箋の文を指示にして、会話と同じ Claude Code のジョブで動かす。docs/ai-note-tasks-plan.md）の、画面の側。
// - 送る（ask）：付箋の文（何枚か選んだときは読む順につなぐ）を指示にして、POST /api/claude/note-tasks で頼む。
//   添えた所は送るときに ref にする（ref は 3 日で消えるので、付箋には範囲を持っておく）。続きの付箋なら前の指示と報告、
//   前の作業があればその会話（サーバーが前の作業の記録を渡す）、近くの付箋（関連する付箋の候補）も送る。
//   undo なら、前の作業の Canvas の変更を戻してから送る（戻せなければ送らず、わけを出す）
// - 作業の間と報告は、サーバーが付箋に書く（meta.ai.task・meta.ai.answer）。ここは、頼んでいる間（応答が来るまで）だけを持つ（sending）
// - 頼めなかったわけは、付箋ごとに覚えておく（failures。答えのパネルに出す。次に送ったら消す）
// - 止める（cancel）は、その付箋の動いている作業のジョブを止める（ほかのタブで頼んだものも）
// - モデルと effort は、AI 付箋なら付箋に選んだもの、ほかはチャットで最後に選んだもの（なければサーバーの既定）

export type SendingNote = {
  key: number
  canvasId: string
  noteId: string
}

export interface CanvasAnswersDeps {
  viewRef: RefObject<CanvasView | null>
  claude: ClaudeClient
  notify: (message: string) => void
}

export function useCanvasAnswers({ viewRef, claude, notify }: CanvasAnswersDeps) {
  const [sending, setSending] = useState<SendingNote[]>([])
  // 頼んでいる付箋（ask が読む。ask を変えないように、state とは別に持つ。ask が変わると、それを使う Canvas の画面が作り直される）
  const sendingIds = useRef(new Set<string>())
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map())
  const fail = useCallback((noteId: string, message: string | null) => {
    setFailures((map) => {
      const next = new Map(map)
      if (message) next.set(noteId, message)
      else next.delete(noteId)
      return next
    })
  }, [])

  // 付箋の文を指示にして頼む。undo なら、前の作業の Canvas の変更を戻してから送る
  const ask = useCallback(
    async (ids: readonly string[], options: { undo?: boolean } = {}) => {
      const view = viewRef.current
      const editor = view?.editor
      const asked = editor ? questionOf(editor, ids) : null
      if (!view || !editor || !asked) return notify('文字のある付箋を選んでください')
      const noteId = asked.questionIds[0]!
      const canvasId = editor.canvasId
      if (sendingIds.current.has(noteId) || runningNoteTasks(claude.state).some((job) => job.note?.noteId === noteId)) {
        return notify('この付箋の作業が、まだ終わっていません。終わるまで待つか、止めてください')
      }
      const meta = aiNoteMeta(editor.getNode(noteId))
      const setting: ModelSetting = { ...loadSetting(), ...(meta?.model ? { model: meta.model } : {}), ...(meta?.effort ? { effort: meta.effort as Effort } : {}) }
      const places = meta?.contexts.flatMap((context) => (context.kind === 'canvas' ? [context] : [])) ?? []
      // 欄では MAX_AI_PLACES か所までしか添えられないが、前から添えてあったものは多いことがある（送るとサーバーが 400 で断る）
      if (places.length > MAX_AI_PLACES) return notify(`添えた所が多すぎます（${MAX_AI_PLACES} か所まで）。付箋の下の欄の添えた数を押し、× で外してください`)
      const previous = previousTurnsOf(meta)
      const candidates = answerCandidates(editor, asked.questionIds)
      const lastThreadId = meta?.answer?.threadId
      const item: SendingNote = { key: Date.now() + Math.random(), canvasId, noteId }
      sendingIds.current.add(noteId)
      setSending((list) => [...list, item])
      fail(noteId, null)
      try {
        const refs = (
          await Promise.all(places.map(async (place) => ({ label: place.label, refId: await view.saveReference(place.target, place.regions).catch(() => null) })))
        ).flatMap((ref) => (ref.refId ? [{ label: ref.label, refId: ref.refId }] : []))
        if (refs.length < places.length) notify(`添えた所のうち ${places.length - refs.length} か所を渡せませんでした（残りで頼みます）`)
        const { undone } = await claude.startNoteTask({
          noteId,
          canvasId,
          instruction: asked.question,
          ...(asked.questionIds.length > 1 ? { questionIds: asked.questionIds.slice(1) } : {}),
          ...(refs.length > 0 ? { refs } : {}),
          ...(candidates.length > 0 ? { candidates } : {}),
          ...(previous.length > 0 ? { previous } : {}),
          ...(lastThreadId ? { lastThreadId } : {}),
          ...(options.undo && lastThreadId ? { undo: true } : {}),
          ...(setting.model ? { model: setting.model } : {}),
          ...(setting.effort ? { effort: setting.effort } : {}),
        })
        if (undone && undone.length > 0) notify(`前の変更を ${undone.length} 個戻して、頼みました`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const detail = error instanceof NoteTaskUndoError && error.undone.length > 0 ? `${message}（新しい方の ${error.undone.length} 個は戻しました）` : message
        fail(noteId, detail)
        notify(`頼めませんでした：${detail}`)
      } finally {
        sendingIds.current.delete(noteId)
        setSending((list) => list.filter((entry) => entry.key !== item.key))
      }
    },
    [viewRef, claude, notify, fail],
  )

  // その付箋の動いている作業を止める（ほかのタブで頼んだものも）
  const cancel = useCallback(
    (noteId: string) => {
      const job = runningNoteTasks(claude.state).find((item) => item.note?.noteId === noteId)
      if (job) void claude.cancel(job.id).catch((error: unknown) => notify(`止められませんでした：${error instanceof Error ? error.message : String(error)}`))
    },
    [claude, notify],
  )

  return { sending, ask, failures, cancel }
}
