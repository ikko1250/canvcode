import { useCallback, useRef, useState, type RefObject } from 'react'
import {
  aiNoteMeta,
  answerContent,
  answerFollowUpOf,
  buttonTarget,
  placeAnswer,
  placeFollowUp,
  previousTurns,
  questionOf,
  questionText,
  replaceAnswer,
  restoreAnswerVersion,
  waitUntilIdle,
  type CanvasView,
  type Editor,
  type PreviousTurn,
} from '@canvcode/canvas'
import type { ButtonProps } from '@canvcode/nodes'
import { requestAnswer } from './answer.ts'
import type { AnswerLog, AnswerLogEntry } from './answerLog.ts'
import type { ClaudeClient } from './claudeClient.ts'
import { loadSetting, type ModelSetting } from './modelChoice.ts'
import type { Effort } from './claudeClient.ts'

// キャンバスの AI（付箋で聞き、付箋で答える）の、画面の側。
// - 待っている間は、置く所（質問の付箋か、書き直すフレームの右上）に「書いています」を出す（× でやめられる）。
//   同じ付箋・同じフレームを重ねて頼まない。待っている間に別の Canvas に移っても、その Canvas の Editor が残っていれば、そこに置く
// - 頼んだものは AnswerLog に記録する（付箋の答えのパネルに、回答中・回答終了と考えている中身を出す）
// - モデルと effort は、AI モードの付箋なら付箋に選んだもの、ほかはチャットで最後に選んだもの（なければサーバーの既定）

export type AnsweringJob = {
  key: number
  canvasId: string
  // 印を出す所と、重ねて頼まないもの
  anchorIds: string[]
  busy: string[]
  message: string
  abort: AbortController
  kind: AnswerLogEntry['kind']
  label: string
  frameId?: string
}

// 頼んだ結果：置いた（書き直した）フレーム、置けなかったわけ、やめた
type Outcome = { frameId: string; message?: string } | { problem: string } | { cancelled: true }

// 続きの質問で送る前の答えの、文字の数の上限（サーバーの上限に収まるように。古いものから落とす）
const MAX_PREVIOUS_LENGTH = 12000

export interface CanvasAnswersDeps {
  viewRef: RefObject<CanvasView | null>
  claude: ClaudeClient
  log: AnswerLog
  notify: (message: string) => void
  // 答えを置く Canvas の Editor（読み込んでいなければ undefined）
  answerEditor: (canvasId: string) => Editor | undefined
  canvasTitle: (canvasId: string) => string
}

export function useCanvasAnswers({ viewRef, claude, log, notify, answerEditor, canvasTitle }: CanvasAnswersDeps) {
  const [answering, setAnswering] = useState<AnsweringJob[]>([])
  const answeringIds = useRef(new Set<string>())

  // 答えが届いたら、文字の編集・ドラッグなどが終わるまで待つ（その間は書けない）。待つ間は、印の文で知らせる。
  // 待ち終えたときの Editor（Canvas がなければ undefined）を返す。やめたら null
  const settle = useCallback(
    async (job: AnsweringJob, signal: AbortSignal): Promise<Editor | undefined | null> => {
      const editor = answerEditor(job.canvasId)
      if (editor?.store.activeTransaction) {
        setAnswering((list) => list.map((j) => (j.key === job.key ? { ...j, message: 'Claude の答えができました。編集を終えると置きます' } : j)))
        await waitUntilIdle(editor, signal)
      }
      return signal.aborted ? null : answerEditor(job.canvasId)
    },
    [answerEditor],
  )

  const run = useCallback(
    async (job: AnsweringJob, work: (signal: AbortSignal, onThinking: (text: string) => void) => Promise<Outcome>, failure: string) => {
      if (job.busy.some((id) => answeringIds.current.has(id))) return notify('いま Claude が書いているところです。終わるまで待つか、× でやめてください')
      for (const id of job.busy) answeringIds.current.add(id)
      setAnswering((list) => [...list, job])
      const logId = log.start({ canvasId: job.canvasId, kind: job.kind, label: job.label, ...(job.frameId ? { frameId: job.frameId } : {}) })
      const signal = job.abort.signal
      try {
        const outcome = await work(signal, (text) => log.appendThinking(logId, text))
        if ('frameId' in outcome) {
          log.finish(logId, { status: 'done', frameId: outcome.frameId })
          if (outcome.message) notify(outcome.message)
        } else if ('problem' in outcome) {
          log.finish(logId, { status: 'failed', error: outcome.problem })
          notify(outcome.problem)
        } else {
          log.finish(logId, { status: 'cancelled' })
          notify('Claude に頼むのをやめました')
        }
      } catch (error) {
        if (signal.aborted) {
          log.finish(logId, { status: 'cancelled' })
          return notify('Claude に頼むのをやめました')
        }
        const message = error instanceof Error ? error.message : String(error)
        log.finish(logId, { status: 'failed', error: message })
        notify(`${failure}：${message}`)
      } finally {
        for (const id of job.busy) answeringIds.current.delete(id)
        setAnswering((list) => list.filter((j) => j.key !== job.key))
      }
    },
    [log, notify],
  )

  // 付箋を質問にして Claude に聞き、答えを段落ごとの付箋とボタンにまとめたフレームにして、付箋の下に置く（Undo 1 回で消える）。
  // AI モードの付箋が 1 枚なら、付箋に添えたもの（前の答え・選んだ所）とモデルも使う
  const ask = useCallback(
    (ids: readonly string[]) => {
      const view = viewRef.current
      const editor = view?.editor
      const asked = editor ? questionOf(editor, ids) : null
      if (!view || !editor || !asked) return notify('文字のある付箋を選んでください')
      const meta = asked.questionIds.length === 1 ? aiNoteMeta(editor.getNode(asked.questionIds[0]!)) : null
      const setting: ModelSetting = { ...loadSetting(), ...(meta?.model ? { model: meta.model } : {}), ...(meta?.effort ? { effort: meta.effort as Effort } : {}) }
      const followUpOf = meta?.contexts.find((context) => context.kind === 'answer')?.frameId
      const previous = followUpOf ? fitTurns(previousTurns(editor, followUpOf)) : []
      const places = meta?.contexts.flatMap((context) => (context.kind === 'canvas' ? [context] : [])) ?? []
      const job: AnsweringJob = {
        key: Date.now() + Math.random(),
        canvasId: editor.canvasId,
        anchorIds: asked.questionIds,
        busy: asked.questionIds,
        message: 'Claude が答えを書いています',
        abort: new AbortController(),
        kind: followUpOf ? 'follow-up' : 'ask',
        label: firstLine(questionText(editor, asked.questionIds)),
      }
      return run(
        job,
        async (signal, onThinking) => {
          // 選んだ所は、送るときに ref にする（ref は 3 日で消えるので、付箋には範囲を持っておく）
          const refs = (
            await Promise.all(places.map(async (place) => ({ label: place.label, refId: await view.saveReference(place.target).catch(() => null) })))
          ).flatMap((ref) => (ref.refId ? [{ label: ref.label, refId: ref.refId }] : []))
          const request = { question: asked.question, ...(previous.length > 0 ? { previous } : {}), ...(refs.length > 0 ? { refs } : {}) }
          const answer = await requestAnswer(request, setting, { signal, onThinking })
          const target = await settle(job, signal)
          if (target === null) return { cancelled: true }
          const frameId = target ? placeAnswer(target, asked.questionIds, answer, { label: 'Claude の答えを置く', ...(followUpOf ? { followUpOf } : {}) }) : null
          if (!target || !frameId) return { problem: '質問の付箋が見えなくなったので、答えを置けませんでした' }
          return { frameId, ...(viewRef.current?.editor !== target ? { message: `「${canvasTitle(job.canvasId)}」に Claude の答えを置きました` } : {}) }
        },
        '答えられませんでした',
      )
    },
    [viewRef, notify, run, settle, canvasTitle],
  )

  // ボタンを押した。
  // - 「＋」：答えの横に続きの質問の付箋（AI モード）を置き、文字の編集を始める（置くことと入力で Undo 1 回）
  // - 版の帯：答えをその版に戻す（Claude は呼ばない）
  // - ほか：入っているフレームの前提と付箋（読む順。人が書き換えたものも）を、ボタンの指示で Claude に書き直してもらい、
  //   フレームの付箋と AI が置いたボタンを置き換える（Undo 1 回で戻る）。文字の編集・ドラッグなどの最中なら、終わるまで待ってから置く。
  //   待っている間にフレームの名前・付箋・ボタンが変わった・消えたなら、置き換えない
  const pressButton = useCallback(
    (buttonId: string) => {
      const view = viewRef.current
      const editor = view?.editor
      const node = editor?.getNode(buttonId)
      if (!view || !editor || node?.type !== 'button') return
      const props = node.props as ButtonProps
      const target = buttonTarget(editor, buttonId)
      if (props.action) {
        if (!target) return
        if (answeringIds.current.has(target.frameId)) return notify('いま Claude が書き直しているところです。終わるまで待つか、× でやめてください')
        if (editor.store.activeTransaction) return notify('編集を終えてから押してください')
        if (props.action === 'version') {
          restoreAnswerVersion(editor, target.frameId, props.version ?? -1, { label: '前の答えに戻す' })
          return
        }
        const tx = editor.begin('続きの質問を置く')
        const noteId = placeFollowUp(editor, tx, target.frameId, props.action === 'ask-left' ? 'left' : 'right')
        if (!noteId) return tx.cancel()
        tx.flush()
        view.textEditor.start(noteId, { tx })
        return
      }
      if (claude.state.availability !== 'on') return notify('このサーバーでは Claude を使えません')
      if (!target) return notify('ボタンをフレームの中に置くと、押したときに、そのフレームの付箋を Claude が書き直します')
      if (!target.instruction) return notify('ボタンに文字か指示を入れてください')
      const before = answerContent(editor, target.frameId)
      if (!before || (before.notes.length === 0 && before.assumptions.length === 0)) return notify('フレームの中に、書き直す付箋がありません')
      const label = props.label.trim()
      // 続きの質問の答えなら、前の答えも渡す（書き直しても、続きのまま）
      const followUpOf = answerFollowUpOf(editor, target.frameId)
      const previous = followUpOf ? fitTurns(previousTurns(editor, followUpOf)) : []
      const job: AnsweringJob = {
        key: Date.now() + Math.random(),
        canvasId: editor.canvasId,
        anchorIds: [target.frameId],
        busy: [target.frameId],
        message: `「${label}」で書き直しています`,
        abort: new AbortController(),
        kind: 'rewrite',
        label: label || target.instruction,
        frameId: target.frameId,
      }
      return run(
        job,
        async (signal, onThinking) => {
          const current = { title: before.title, assumptions: before.assumptions, notes: before.notes, buttons: before.buttons, history: before.history }
          const request = { question: questionText(editor, target.questionIds), current, instruction: target.instruction, ...(previous.length > 0 ? { previous } : {}) }
          const answer = await requestAnswer(request, loadSetting(), { signal, onThinking })
          const latest = await settle(job, signal)
          if (latest === null) return { cancelled: true }
          const now = latest ? answerContent(latest, target.frameId) : null
          if (!latest || !now) return { problem: 'フレームが見えなくなったので、書き直せませんでした' }
          if (now.signature !== before.signature) return { problem: '待っている間にフレームの付箋が変わったので、置き換えませんでした' }
          replaceAnswer(latest, target.frameId, answer, target.questionIds, { label: `答えを書き直す（${label}）`, instruction: target.instruction, via: label || target.instruction })
          return { frameId: target.frameId }
        },
        '書き直せませんでした',
      )
    },
    [viewRef, claude, notify, run, settle],
  )

  // クリックで押せるボタンか。Claude に送るボタンは、Claude を使えるときだけ（使えないときは、クリックで選ぶ）
  const canPressButton = useCallback(
    (nodeId: string) => {
      const node = viewRef.current?.editor.getNode(nodeId)
      if (node?.type === 'button' && (node.props as ButtonProps).action) return true
      return claude.state.availability === 'on'
    },
    [viewRef, claude],
  )

  return { answering, ask, pressButton, canPressButton }
}

// 前の答えを、文字の数の上限に収まるまで古いものから落とす
function fitTurns(turns: PreviousTurn[]): PreviousTurn[] {
  const size = (turn: PreviousTurn) => turn.question.length + turn.title.length + turn.paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0)
  const kept = [...turns]
  while (kept.length > 1 && kept.reduce((sum, turn) => sum + size(turn), 0) > MAX_PREVIOUS_LENGTH) kept.shift()
  return kept
}

function firstLine(text: string): string {
  const line = text.split('\n').find((part) => part.trim() !== '')?.trim() ?? ''
  const chars = Array.from(line)
  return chars.length > 60 ? `${chars.slice(0, 59).join('')}…` : line || '（質問）'
}
