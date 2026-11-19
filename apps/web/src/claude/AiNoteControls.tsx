import { useCallback, useEffect, useMemo, useState } from 'react'
import type { NodeRecord } from '@canvcode/core'
import { MAX_AI_PLACES, aiNoteMeta, setAiNote, type AiContext, type AiNoteMeta, type CanvasView, type Editor, type SessionState } from '@canvcode/canvas'
import type { ClaudeClient, Effort } from './claudeClient.ts'
import { useClaudeState } from './claudeClient.ts'
import { ModelPicker } from './ModelPicker.tsx'
import { loadSetting, saveSetting, type ModelSetting } from './modelChoice.ts'

// AI 付箋（meta.ai。Claude に聞く付箋）のまわり（docs/canvas-answer-panel-plan.md の 5）。カメラに付いて動く。
// - 付箋の下の欄：左にコンテキストを選ぶアイコン（範囲で囲む絵。横に添えた数）、右にモデルの札と送信（➤）。枠で囲まず、付箋の下に並べる。
//   出すのは、選んでいるものに AI 付箋がちょうど 1 枚あるとき（ほかと一緒でもよい）・その付箋の文字の編集中・
//   その付箋の答えのパネルかこの欄にフォーカスがあるとき（答えのパネルが見張る。AnswerPopover の onFocusChange）・
//   添える所を選んでいる間だけ
// - コンテキストを選ぶアイコン：付箋と一緒にほかのノードを選んでいれば、それをすぐ添える。付箋だけなら「添える所を選ぶ」状態にし、
//   キャンバスで範囲をドラッグするかノードをクリックしたら添えて、付箋を選び直す（Esc かもう一度押すとやめる）。
//   添えられるのは MAX_AI_PLACES か所まで（サーバーの上限）。添えた数を押すと、添えたものの一覧（× で外す）
// - 付箋の上の札：前の答え（続き）を添えた付箋には、いつも出す（「「質問」の答え」と、元の付箋へ移る ↗）。
//   会話の答え（会話のタブの「付箋に切り出す」）を添えた付箋には「💬 会話「題」の答え」と、会話のそのジョブへ戻る「↗ 会話へ」
//   （docs/claude-chat-tab-plan.md の 5）。両方あれば、上下に並べる
// - 答えを作っている間は、送信を押せない（角の三角が点滅している）。文字の編集中は Ctrl+Enter でも送る
// - 小さく表示しているときは出さない
// - 札と欄の上のホイール・ピンチ（トラックパッド・マウス）は、キャンバスのパン・ズームに渡す（CanvasView の passWheel）
const MIN_ZOOM = 0.3
// 札と欄の幅の下限（画面のピクセル。付箋が狭くても、この幅で出す。書式のツールバーも、この幅を避ける）
export const AI_NOTE_UI_MIN_WIDTH = 220
const MIN_WIDTH = AI_NOTE_UI_MIN_WIDTH

export function AiNoteControls(props: {
  editor: Editor
  view: CanvasView
  session: SessionState
  claude: ClaudeClient
  // 答えを作っている付箋
  busy: ReadonlySet<string>
  // 答えのパネルかこの欄にフォーカスがある付箋（答えのパネルで見ている付箋）
  focusedNoteId: string | null
  onSend(noteId: string): void
  // 前の答えの札の ↗：元の付箋へ移る
  onOpenContext(canvasId: string, noteId: string): void
  // 会話の答えの札の ↗：会話のそのジョブ（会話の質問なら、そのカード）へ戻る（Claude を使えないときは渡さない）
  onOpenChat?(target: { threadId: string; jobId?: string; questionId?: string }): void
  canvasTitle(canvasId: string): string
  notify(message: string): void
}) {
  const { editor, view, session, claude, busy, focusedNoteId, onSend, onOpenContext, onOpenChat, canvasTitle, notify } = props
  const { camera } = session
  const notes = useAiNotes(editor)
  const { models } = useClaudeState(claude)
  // 添える所を選んでいる付箋
  const [picking, setPicking] = useState<string | null>(null)
  // 添えたものの一覧を開いている付箋
  const [listing, setListing] = useState<string | null>(null)

  useEffect(() => {
    if (notes.length > 0) void claude.loadModels()
  }, [claude, notes.length])

  // 文字の編集中に Ctrl+Enter（Mac は ⌘+Enter）で、編集を終えて送る
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.isComposing) return
      const id = view.textEditor.editingId
      if (!id || !aiNoteMeta(editor.getNode(id))) return
      e.preventDefault()
      e.stopPropagation()
      view.textEditor.finish()
      if (!busy.has(id)) onSend(id)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [editor, view, onSend, busy])

  // 添える所を選んでいる間：範囲選択を終えたか、ノードを選んだら、それを添えて付箋を選び直す。Esc でやめる
  useEffect(() => {
    if (!picking) return
    const stop = () => {
      setPicking(null)
      if (editor.getNode(picking)) editor.setSelection([picking])
    }
    const unsubscribe = editor.session.subscribe((state, prev) => {
      if (state.brush || (state.selectedIds === prev.selectedIds && state.lastBrush === prev.lastBrush)) return
      const context = selectionContext(editor, view, picking)
      if (!context) return
      addContext(editor, picking, context, notify)
      stop()
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      stop()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      unsubscribe()
      window.removeEventListener('keydown', onKey, true)
    }
  }, [editor, view, picking, notify])

  // 札と欄の上のホイール・ピンチを、キャンバスに渡す（React 19 の ref は、外すときに返した関数を呼ぶ）
  const passWheel = useCallback((element: HTMLDivElement | null) => (element ? view.passWheel(element) : undefined), [view])

  if (camera.zoom < MIN_ZOOM) return null

  // 下の欄を出す付箋
  const aiSelected = [...session.selectedIds].filter((id) => aiNoteMeta(editor.getNode(id)))
  const editing = session.editingId && aiNoteMeta(editor.getNode(session.editingId)) ? session.editingId : null
  const target = picking ?? editing ?? (focusedNoteId && aiNoteMeta(editor.getNode(focusedNoteId)) ? focusedNoteId : null) ?? (aiSelected.length === 1 ? aiSelected[0]! : null)
  const screen = (x: number, y: number) => ({ left: (x - camera.x) * camera.zoom, top: (y - camera.y) * camera.zoom })

  return (
    <div className="ai-note-layer" ref={passWheel}>
      {notes.map((node) => {
        // 付箋の上の札：会話の答えと、前の答え（続き）
        const contexts = aiNoteMeta(node)?.contexts ?? []
        const chat = contexts.find((item) => item.kind === 'chat')
        const answer = contexts.find((item) => item.kind === 'answer')
        const box = editor.index.get(node.id)?.worldBounds
        if ((!chat && !answer) || !box) return null
        return (
          <div
            key={`chip:${node.id}`}
            className="ai-note-chips"
            style={{ ...screen(box.x, box.y), width: Math.max(MIN_WIDTH, box.w * camera.zoom) }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {chat?.kind === 'chat' && (
              <div className="ai-note-chip chat" title="会話の答えを踏まえて答えます（会話には何も足しません）">
                <span className="ai-note-chip-label">💬 {chat.label}</span>
                {onOpenChat && chat.threadId && (
                  <button
                    type="button"
                    onClick={() =>
                      onOpenChat({ threadId: chat.threadId!, ...(chat.jobId ? { jobId: chat.jobId } : {}), ...(chat.questionId ? { questionId: chat.questionId } : {}) })
                    }
                    title="会話のこの答えへ戻る"
                  >
                    ↗ 会話へ
                  </button>
                )}
              </div>
            )}
            {answer?.kind === 'answer' && (
              <div className="ai-note-chip" title="前の質問と答えを踏まえて答えます">
                <span className="ai-note-chip-label">📎 「{answer.label}」の答え</span>
                <button type="button" onClick={() => onOpenContext(answer.canvasId, answer.noteId)} title="元の付箋へ移る">
                  ↗ {answer.canvasId === editor.canvasId ? '元の付箋' : canvasTitle(answer.canvasId)}
                </button>
              </div>
            )}
          </div>
        )
      })}
      {target &&
        (() => {
          const node = editor.getNode(target)
          const meta = aiNoteMeta(node)
          const box = editor.index.get(target)?.worldBounds
          if (!node || !meta || !box) return null
          const setting: ModelSetting = meta.model || meta.effort ? { ...(meta.model ? { model: meta.model } : {}), ...(meta.effort ? { effort: meta.effort as Effort } : {}) } : loadSetting()
          const update = (patch: Partial<AiNoteMeta>, label?: string) => {
            const latest = aiNoteMeta(editor.getNode(target))
            if (latest) setAiNote(editor, target, { ...latest, ...patch }, label)
          }
          const places = meta.contexts.flatMap((context, index) => (context.kind === 'canvas' ? [{ context, index }] : []))
          const answering = busy.has(target)
          const pickContext = () => {
            if (picking === target) return setPicking(null)
            if (places.length >= MAX_AI_PLACES) return notify(TOO_MANY_PLACES)
            const others = [...editor.session.get().selectedIds].filter((id) => id !== target)
            const context = others.length > 0 ? selectionContext(editor, view, target) : null
            if (context) return addContext(editor, target, context, notify)
            setPicking(target)
          }
          return (
            <div
              key={`controls:${target}`}
              className="ai-note-controls"
              data-own-keys=""
              // 押してもフォーカスを持たないボタン（Mac の Safari・Firefox）を押したときも、フォーカスがこの欄に来るように
              // （キャンバスへ移ると、答えのパネルから開いた欄が消え、押せない）
              tabIndex={-1}
              style={{ left: screen(box.x, 0).left, top: screen(0, box.y + box.h).top + 6, width: Math.max(MIN_WIDTH, box.w * camera.zoom) }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="ai-note-controls-row">
                <button
                  type="button"
                  className={`ai-note-attach${picking === target ? ' picking' : ''}`}
                  onClick={pickContext}
                  aria-label="添える所を選ぶ"
                  title={
                    picking === target
                      ? '添える所を選んでいます（範囲をドラッグするか、ノードをクリック。Esc でやめる）'
                      : '添える所を選ぶ（範囲をドラッグするか、ノードをクリック。付箋と一緒に選んでいれば、それを添える）'
                  }
                >
                  <AreaIcon />
                </button>
                {places.length > 0 && (
                  <button
                    type="button"
                    className="ai-note-attach-count"
                    aria-expanded={listing === target}
                    onClick={() => setListing(listing === target ? null : target)}
                    title="添えたもの（押すと一覧。× で外す）"
                  >
                    {places.length}
                  </button>
                )}
                {picking === target && <span className="ai-note-picking">範囲をドラッグか、ノードをクリック</span>}
                <span className="ai-note-controls-spacer" />
                <ModelPicker
                  catalog={models}
                  setting={setting}
                  placement="down"
                  onChange={(next) => {
                    saveSetting(next)
                    update({ model: next.model ?? '', effort: next.effort ?? '' }, 'モデルを選ぶ')
                  }}
                />
                <button
                  type="button"
                  className="ai-note-send"
                  disabled={answering}
                  aria-label="Claude に送る"
                  onClick={() => {
                    // 文字を編集している途中なら、編集を終えてから送る（書いた文字を質問にする）
                    if (view.textEditor.editingId === target) view.textEditor.finish()
                    onSend(target)
                  }}
                  title={answering ? 'Claude が答えを作っています' : 'Claude に送る（文字の編集中は Ctrl+Enter）'}
                >
                  <span aria-hidden="true">➤</span>
                </button>
              </div>
              {listing === target && places.length > 0 && (
                <div className="ai-note-contexts">
                  {places.map(({ context, index }) => (
                    <span key={index} className="ai-note-context" title={`${context.label}（選んだ所を Claude に見せます）`}>
                      <span className="ai-note-context-label">{context.label}</span>
                      <button
                        type="button"
                        aria-label="外す"
                        title="外す"
                        onClick={() => update({ contexts: meta.contexts.filter((_, j) => j !== index) }, 'Claude に添えるものを外す')}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })()}
    </div>
  )
}

function AreaIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="2" width="12" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" />
      <path d="M8 5.5v5M5.5 8h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

const TOO_MANY_PLACES = `添えられる所は ${MAX_AI_PLACES} か所までです。添えた数を押し、× で外してから添えてください`

// 付箋に添えるものを足す（同じものは足さない。選んだ所は MAX_AI_PLACES か所まで）
function addContext(editor: Editor, noteId: string, context: AiContext, notify: (message: string) => void): void {
  const meta = aiNoteMeta(editor.getNode(noteId))
  if (!meta) return
  if (meta.contexts.some((known) => sameContext(known, context))) return notify('もう添えてあります')
  if (context.kind === 'canvas' && meta.contexts.filter((known) => known.kind === 'canvas').length >= MAX_AI_PLACES) return notify(TOO_MANY_PLACES)
  setAiNote(editor, noteId, { ...meta, contexts: [...meta.contexts, context] }, 'Claude に添えるものを足す')
}

// 今の Canvas の AI 付箋（入れ子の中も）。付箋の meta.ai か位置・大きさが変わったら読み直す
function useAiNotes(editor: Editor): NodeRecord[] {
  const [version, setVersion] = useState(0)
  useEffect(
    () =>
      editor.store.listen((event) => {
        for (const change of event.patch.values()) {
          const touches = (record: unknown) => typeof record === 'object' && record !== null && (record as NodeRecord).typeName === 'node' && (record as NodeRecord).meta?.ai !== undefined
          if (touches(change.before) || touches(change.after)) {
            setVersion((v) => v + 1)
            return
          }
        }
      }),
    [editor],
  )
  return useMemo(() => {
    void version
    return [...editor.index.nodeIds()].flatMap((id) => {
      const node = editor.getNode(id)
      return node && aiNoteMeta(node) ? [node] : []
    })
  }, [editor, version])
}

// 今選んでいるもの（付箋自身は除く）
function selectionContext(editor: Editor, view: CanvasView, noteId: string): AiContext | null {
  const selected = [...editor.session.get().selectedIds].filter((id) => id !== noteId)
  const target = view.canvasReference()
  if (!target) return null
  const nodes = target.nodes.filter((node) => node.id !== noteId)
  if (nodes.length === 0 && selected.length === 0 && target.nodes.length > 0) return null
  return { kind: 'canvas', label: nodes.length > 0 ? `${nodes.length} 個のノード` : 'キャンバスの範囲', target: { ...target, nodes } }
}

function sameContext(a: AiContext, b: AiContext): boolean {
  if (a.kind === 'answer' && b.kind === 'answer') return a.noteId === b.noteId
  if (a.kind === 'chat' && b.kind === 'chat') return a.jobId === b.jobId && a.questionId === b.questionId
  if (a.kind !== 'canvas' || b.kind !== 'canvas') return false
  const ids = (context: typeof a) => context.target.nodes.map((node) => node.id).sort().join(',')
  return ids(a) === ids(b) && JSON.stringify(a.target.rect) === JSON.stringify(b.target.rect)
}
