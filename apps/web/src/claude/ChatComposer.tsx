import type { KeyboardEvent, RefObject, UIEvent } from 'react'
import type { ModelCatalog } from './claudeClient.ts'
import { ModelPicker } from './ModelPicker.tsx'
import type { ModelSetting } from './modelChoice.ts'

// 会話のタブの入力欄（docs/claude-chat-tab-plan.md の 4）。
// - 上に札：添えた所（「📍 名前 ×」）と、取り込む付箋の質問（「付箋の質問を取り込みます「質問」 ×」）
// - 文の欄。Enter は改行、Ctrl（⌘）+Enter で送る（呼ぶ側の onKeyDown）
// - 下の並び：📎（選んでいる所を添える）、「会話｜質問」の切り替え（質問は、その 1 つだけ会話に入れずに聞く。キャンバスでだけ出す）、
//   モデルの札、➤（送る）

export type ComposeMode = 'chat' | 'question'

export interface ComposerAttachment {
  label: string
  // null の間は保存している
  refId: string | null
}

export function ChatComposer(props: {
  inputRef: RefObject<HTMLTextAreaElement | null>
  prompt: string
  placeholder: string
  attachment: ComposerAttachment | null
  // 取り込む付箋の質問の 1 行目。importFromChat なら別枠の質問（会話の質問）
  importLabel?: string | null
  importFromChat?: boolean
  mode: ComposeMode
  // 「会話｜質問」の切り替え（渡さなければ出さない）
  onMode?(mode: ComposeMode): void
  catalog: ModelCatalog | undefined
  setting: ModelSetting
  canSend: boolean
  error: string | null
  onPrompt(text: string): void
  onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void
  onScroll(e: UIEvent<HTMLTextAreaElement>): void
  onAttachSelection(): void
  onClearAttachment(): void
  onClearImport?(): void
  onSetting(setting: ModelSetting): void
  onSend(): void
}) {
  const { inputRef, prompt, placeholder, attachment, importLabel, importFromChat = false, mode, onMode, catalog, setting, canSend, error } = props
  const { onPrompt, onKeyDown, onScroll, onAttachSelection, onClearAttachment, onClearImport, onSetting, onSend } = props
  return (
    <div className={`claude-compose${mode === 'question' ? ' question' : ''}`}>
      {(attachment || importLabel) && (
        <div className="claude-compose-chips">
          {attachment && (
            <span className="claude-attachment" title={attachment.refId ?? undefined}>
              <span>{attachment.refId === null ? `📍 ${attachment.label}（保存中…）` : `📍 ${attachment.label}`}</span>
              <button type="button" onClick={onClearAttachment} aria-label="添付を外す" title="添付を外す">
                ×
              </button>
            </span>
          )}
          {importLabel && (
            <span className="claude-attachment claude-import-chip" title="次に送る文と一緒に、付箋の質問と答えを会話に入れます">
              <span>
                {importFromChat ? '会話の質問を取り込みます' : '付箋の質問を取り込みます'}「{importLabel}」
              </span>
              {onClearImport && (
                <button type="button" onClick={onClearImport} aria-label="取り込むのをやめる" title="取り込むのをやめる">
                  ×
                </button>
              )}
            </span>
          )}
        </div>
      )}
      <textarea
        ref={inputRef}
        value={prompt}
        rows={3}
        placeholder={placeholder}
        aria-label={mode === 'question' ? 'Claude に聞く（会話に入れない）' : 'Claude に頼む'}
        onChange={(e) => onPrompt(e.target.value)}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
      />
      {error && <div className="claude-error">{error}</div>}
      <div className="claude-compose-actions">
        <button type="button" className="claude-attach" onClick={onAttachSelection} aria-label="選んでいる所を添える" title="選んでいるノード（直前の範囲選択）を添える">
          📎
        </button>
        {onMode && (
          <div
            className="claude-mode"
            role="radiogroup"
            aria-label="送り方"
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
              e.preventDefault()
              const next = mode === 'chat' ? 'question' : 'chat'
              onMode(next)
              e.currentTarget.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus()
            }}
          >
            <button
              type="button"
              role="radio"
              data-mode="chat"
              aria-checked={mode === 'chat'}
              tabIndex={mode === 'chat' ? 0 : -1}
              onClick={() => onMode('chat')}
              title="会話の続きとして頼む（Canvas や文書も編集できる）"
            >
              会話
            </button>
            <button
              type="button"
              role="radio"
              data-mode="question"
              aria-checked={mode === 'question'}
              tabIndex={mode === 'question' ? 0 : -1}
              onClick={() => onMode('question')}
              title="この 1 つだけ、会話に入れずに聞く（答えは質問のタブにも出る）"
            >
              質問
            </button>
          </div>
        )}
        <span className="claude-compose-spacer" />
        <ModelPicker catalog={catalog} setting={setting} onChange={onSetting} />
        <button type="button" className="claude-send" disabled={!canSend} onClick={onSend} aria-label="送る" title="送る（Ctrl+Enter）">
          ➤
        </button>
      </div>
    </div>
  )
}
