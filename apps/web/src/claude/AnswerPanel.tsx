import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { OWN_KEYS_ATTRIBUTE } from '@canvcode/canvas'
import { AnswerStrip, AnswerThinking } from './AnswerLogView.tsx'
import type { AnswerLogEntry } from './answerLog.ts'

// 付箋で聞いた答え（キャンバスの AI）を見るパネル。キャンバスの右に、チャット（ClaudePanel）と同じ置き場所に出す。
// - 右上の「Claude」と C で開くのは、こちら。会話で頼むときは「チャット」でチャットに移る（チャットの「←」で戻る）
// - 回答中のものを押すと、下に Claude の考えている中身だけが流れる。終わったら「回答終了」と「答えへ移る」。
//   前に終わったものは「過去の答え」に畳む（AnswerLogView）
// - パネルの中のキー入力は、キャンバスのショートカットに渡さない（data-own-keys）。Esc で閉じる

interface Props {
  // 付箋で聞いた答えの記録（新しいものから）
  answers: readonly AnswerLogEntry[]
  // 画面を開いた時刻（これより後に終わった答えを、上に「回答終了」として出す）
  since: number
  // 隠しているか（チャットを見せている間。閉じずに隠すので、見ていた答えが残る）
  hidden: boolean
  // 増えたら、パネルにフォーカスする（見えているときだけ）
  focusRequest: number
  onJump(entry: AnswerLogEntry): void
  onClear(): void
  onOpenChat(): void
  onClose(): void
}

export function AnswerPanel(props: Props) {
  const { answers, since, hidden, focusRequest, onJump, onClear, onOpenChat, onClose } = props
  // 考えている中身を見ている答え。消えた記録なら一覧だけに戻る
  const [viewing, setViewing] = useState<string | null>(null)
  const viewed = viewing ? answers.find((entry) => entry.id === viewing) : undefined
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!hidden) panelRef.current?.focus({ preventScroll: true })
  }, [focusRequest, hidden])

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <aside
      ref={panelRef}
      className={`answer-panel${viewed ? ' viewing' : ''}`}
      aria-label="付箋の答え"
      hidden={hidden}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      {...{ [OWN_KEYS_ATTRIBUTE]: '' }}
    >
      <div className="claude-panel-header">
        <strong>付箋の答え</strong>
        <button type="button" className="answer-panel-chat" onClick={onOpenChat} title="Claude と会話して頼むチャットを開く（C でも）">
          チャット →
        </button>
        <button type="button" className="claude-close" onClick={onClose} title="閉じる（Esc）" aria-label="閉じる">
          ×
        </button>
      </div>

      {answers.length === 0 ? (
        <p className="claude-hint answer-panel-empty">
          付箋で聞いた答えは、まだありません。付箋を右クリックして「Claude に聞く（付箋で答える）」を選ぶか、AI 付箋の「送信」で聞くと、
          ここに回答中のもの（Claude の考えている中身を見られます）と、終わったもの（答えへ移れます）が並びます。
          会話で頼むときは、右上の「チャット」へ。
        </p>
      ) : (
        <AnswerStrip
          entries={answers}
          since={since}
          viewing={viewed ? viewed.id : null}
          onView={setViewing}
          onJump={onJump}
          onClear={() => {
            setViewing(null)
            onClear()
          }}
        />
      )}

      {viewed && <AnswerThinking entry={viewed} onBack={() => setViewing(null)} onJump={onJump} />}
    </aside>
  )
}
