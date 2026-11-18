import { useCallback, useRef, useState, type RefObject } from 'react'
import {
  MAX_AI_PLACES,
  aiNoteMeta,
  answerCandidates,
  firstLine,
  previousTurnsOf,
  questionOf,
  setAiAnswer,
  waitUntilIdle,
  type CanvasView,
  type Editor,
} from '@canvcode/canvas'
import { AnswerError, requestAnswer } from './answer.ts'
import type { ClaudeClient } from './claudeClient.ts'
import { loadSetting, type ModelSetting } from './modelChoice.ts'
import type { Effort } from './claudeClient.ts'

// キャンバスの AI（付箋で聞き、答えは付箋に持たせる。docs/canvas-answer-panel-plan.md）の、画面の側。
// - 答えは、質問の付箋（何枚か選んだときは読む順で最初の付箋）の meta.ai.answer に書く（Undo 1 回で消える）
// - 待っている間は、質問の付箋の角の三角が点滅する（App が session の answeringIds に立てる）。やめるのは答えのパネルの「やめる」（cancel）。
//   同じ付箋を重ねて頼まない。待っている間に別の Canvas に移っても、その Canvas の Editor が残っていれば、そこに書く
// - 答えられなかったわけは、付箋ごとに覚えておく（failures。答えのパネルに出す。次に聞いたら消す）
// - 進み具合と考えている中身は、サーバーが動いている質問として流す（質問のタブと答えのパネルは、それを出す）
// - モデルと effort は、AI 付箋なら付箋に選んだもの、ほかはチャットで最後に選んだもの（なければサーバーの既定）
// - 続きの付箋なら、付箋に添えた前の質問と答えも送る。関連する付箋を選ばせるため、近くの付箋も送る
// - どの付箋の質問かも送り、サーバーの動いている質問の一覧に載せる（すべてのタブに流す）。付箋に書いたら（書けなかったら）finish で知らせる。
//   ほかのタブで止められたら（SSE の question-done が cancelled）、付箋に書くのをやめる

export type AnsweringJob = {
  key: number
  canvasId: string
  // 質問の付箋（最初の付箋に答えを書き、角の三角を点滅させる）と、重ねて頼まないもの
  anchorIds: string[]
  busy: string[]
  abort: AbortController
  // 質問の 1 行目
  label: string
}

// 頼んだ結果：答えを書いた付箋、書けなかったわけ、やめた
type Outcome = { noteId: string; message?: string } | { problem: string } | { cancelled: true }

export interface CanvasAnswersDeps {
  viewRef: RefObject<CanvasView | null>
  claude: ClaudeClient
  notify: (message: string) => void
  // 答えを書く Canvas の Editor（読み込んでいなければ undefined）
  answerEditor: (canvasId: string) => Editor | undefined
  canvasTitle: (canvasId: string) => string
}

export function useCanvasAnswers({ viewRef, claude, notify, answerEditor, canvasTitle }: CanvasAnswersDeps) {
  const [answering, setAnswering] = useState<AnsweringJob[]>([])
  const answeringIds = useRef(new Set<string>())
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map())
  const fail = useCallback((ids: readonly string[], message: string | null) => {
    setFailures((map) => {
      const next = new Map(map)
      for (const id of ids) {
        if (message) next.set(id, message)
        else next.delete(id)
      }
      return next
    })
  }, [])

  // 答えが届いたら、文字の編集・ドラッグなどが終わるまで待つ（その間は書けない）。待つときは、そう知らせる。
  // 待ち終えたときの Editor（Canvas がなければ undefined）を返す。やめたら null
  const settle = useCallback(
    async (job: AnsweringJob, signal: AbortSignal): Promise<Editor | undefined | null> => {
      const editor = answerEditor(job.canvasId)
      if (editor?.store.activeTransaction) {
        notify('Claude の答えができました。編集を終えると付箋に書きます')
        await waitUntilIdle(editor, signal)
      }
      return signal.aborted ? null : answerEditor(job.canvasId)
    },
    [answerEditor, notify],
  )

  const run = useCallback(
    async (job: AnsweringJob, work: (signal: AbortSignal) => Promise<Outcome>, failure: string) => {
      if (job.busy.some((id) => answeringIds.current.has(id))) return notify('いま Claude が書いているところです。終わるまで待つか、× でやめてください')
      for (const id of job.busy) answeringIds.current.add(id)
      setAnswering((list) => [...list, job])
      fail(job.busy, null)
      const signal = job.abort.signal
      try {
        const outcome = await work(signal)
        if ('noteId' in outcome) {
          if (outcome.message) notify(outcome.message)
        } else if ('problem' in outcome) {
          fail(job.busy, outcome.problem)
          notify(outcome.problem)
        } else {
          notify('Claude に頼むのをやめました')
        }
      } catch (error) {
        // 499 は、やめた（ほかのタブで止めたときも）
        if (signal.aborted || (error instanceof AnswerError && error.status === 499)) return notify('Claude に頼むのをやめました')
        const message = error instanceof Error ? error.message : String(error)
        fail(job.busy, message)
        notify(`${failure}：${message}`)
      } finally {
        for (const id of job.busy) answeringIds.current.delete(id)
        setAnswering((list) => list.filter((j) => j.key !== job.key))
      }
    },
    [notify, fail],
  )

  // 付箋を質問にして Claude に聞き、答えを質問の付箋に書く（Undo 1 回で消える）。
  // AI 付箋なら、付箋に添えたもの（前の答え・選んだ所）とモデルも使う
  const ask = useCallback(
    (ids: readonly string[]) => {
      const view = viewRef.current
      const editor = view?.editor
      const asked = editor ? questionOf(editor, ids) : null
      if (!view || !editor || !asked) return notify('文字のある付箋を選んでください')
      const [noteId, ...others] = asked.questionIds as [string, ...string[]]
      const meta = aiNoteMeta(editor.getNode(noteId))
      const setting: ModelSetting = { ...loadSetting(), ...(meta?.model ? { model: meta.model } : {}), ...(meta?.effort ? { effort: meta.effort as Effort } : {}) }
      const previous = previousTurnsOf(meta)
      const places = meta?.contexts.flatMap((context) => (context.kind === 'canvas' ? [context] : [])) ?? []
      // 欄では MAX_AI_PLACES か所までしか添えられないが、前から添えてあったものは多いことがある（送るとサーバーが 400 で断る）
      if (places.length > MAX_AI_PLACES) return notify(`添えた所が多すぎます（${MAX_AI_PLACES} か所まで）。付箋の下の欄の添えた数を押し、× で外してください`)
      const candidates = answerCandidates(editor, asked.questionIds)
      const job: AnsweringJob = {
        key: Date.now() + Math.random(),
        canvasId: editor.canvasId,
        anchorIds: asked.questionIds,
        busy: asked.questionIds,
        abort: new AbortController(),
        label: firstLine(asked.question),
      }
      return run(
        job,
        async (signal) => {
          // サーバーの動いている質問の id。ほかのタブで止められたら、ここでもやめる
          let questionId: string | null = null
          const unsubscribe = claude.subscribe(() => {
            if (questionId && claude.state.finishedQuestions.get(questionId) === 'cancelled') job.abort.abort()
          })
          try {
            // 選んだ所は、送るときに ref にする（ref は 3 日で消えるので、付箋には範囲を持っておく）
            const refs = (
              await Promise.all(places.map(async (place) => ({ label: place.label, refId: await view.saveReference(place.target).catch(() => null) })))
            ).flatMap((ref) => (ref.refId ? [{ label: ref.label, refId: ref.refId }] : []))
            const request = {
              question: asked.question,
              ...(previous.length > 0 ? { previous } : {}),
              ...(refs.length > 0 ? { refs } : {}),
              ...(candidates.length > 0 ? { candidates } : {}),
              source: { noteId, canvasId: job.canvasId, label: job.label },
            }
            const answer = await requestAnswer(request, setting, { signal, onStart: (id) => (questionId = id) })
            const outcome = await place(answer)
            // 付箋に書いた（書けなかった・やめた）ことを、サーバーの動いている質問の一覧に知らせる
            if (questionId) {
              if ('noteId' in outcome) void claude.finishQuestion(questionId, 'done')
              else if ('problem' in outcome) void claude.finishQuestion(questionId, 'failed', outcome.problem)
              else void claude.finishQuestion(questionId, 'cancelled')
            }
            return outcome
          } finally {
            unsubscribe()
          }

          // 編集が終わるのを待って、質問の付箋に答えを書く
          async function place(answer: Awaited<ReturnType<typeof requestAnswer>>): Promise<Outcome> {
            const target = await settle(job, signal)
            if (target === null) return { cancelled: true }
            const written =
              target &&
              setAiAnswer(target, noteId, {
                body: answer.body,
                related: answer.related,
                model: answer.model,
                ...(setting.effort ? { effort: setting.effort } : {}),
                question: asked!.question,
                ...(others.length > 0 ? { questionIds: others } : {}),
                answeredAt: Date.now(),
              })
            if (!written) return { problem: '質問の付箋が見えなくなったので、答えを書けませんでした' }
            return { noteId, ...(viewRef.current?.editor !== target ? { message: `「${canvasTitle(job.canvasId)}」の付箋に Claude の答えを書きました` } : {}) }
          }
        },
        '答えられませんでした',
      )
    },
    [viewRef, claude, notify, run, settle, canvasTitle],
  )

  // この画面で頼んでいる、その付箋の答えをやめる
  const cancel = useCallback(
    (noteId: string) => {
      for (const job of answering) if (job.busy.includes(noteId)) job.abort.abort()
    },
    [answering],
  )

  return { answering, ask, failures, cancel }
}
