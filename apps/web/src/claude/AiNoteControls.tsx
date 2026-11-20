import { useCallback, useEffect, useMemo, useState } from 'react'
import type { NodeRecord } from '@canvcode/core'
import {
  MAX_AI_PLACES,
  aiNoteMeta,
  hasUndoableChanges,
  isMacPlatform,
  pdfPlaceLabel,
  sameAiContext,
  setAiNote,
  type AiContext,
  type AiNoteMeta,
  type CanvasView,
  type Editor,
  type SessionState,
} from '@canvcode/canvas'
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
//   PDF のページの上は、Ctrl（⌘）+ドラッグで文字を読む順になぞって添える（docs/ai-note-pick-text-plan.md）。
//   添えたときに Ctrl（⌘）を押していれば選ぶ状態のまま続け、離したら付箋を選び直す。
//   範囲で PDF のページを囲んだときは、その範囲の文字も添える（付箋で答える Claude はファイルを読めない）。
//   添えられるのは MAX_AI_PLACES か所まで（サーバーの上限）。添えた数を押すと、添えたものの一覧（× で外す）
// - 付箋の上の札：前の答え（続き）を添えた付箋には、いつも出す（「「質問」の答え」と、元の付箋へ移る ↗）。
//   会話の答え（会話のタブの「付箋に切り出す」）を添えた付箋には「💬 会話「題」の答え」と、会話のそのジョブへ戻る「↗ 会話へ」
//   （docs/claude-chat-tab-plan.md の 5）。両方あれば、上下に並べる。
//   幅は付箋の画面の幅（縮小しても付箋より広くしない。docs/ai-note-chip-width-plan.md）。CHIP_COMPACT_WIDTH より狭ければボタンを「↗」だけにし、
//   CHIP_MIN_WIDTH より狭ければ出さない
// - 答えを作っている間は、送信を押せない（角の三角が点滅している）。文字の編集中は Ctrl+Enter でも送る
// - 小さく表示しているときは出さない
// - 札と欄の上のホイール・ピンチ（トラックパッド・マウス）は、キャンバスのパン・ズームに渡す（CanvasView の passWheel）
const MIN_ZOOM = 0.3
// 下の欄の幅の下限（画面のピクセル。付箋が狭くても、この幅で出す。書式のツールバーも、この幅を避ける）
export const AI_NOTE_UI_MIN_WIDTH = 220
const MIN_WIDTH = AI_NOTE_UI_MIN_WIDTH
// 上の札：この幅（画面のピクセル）より狭ければ、ボタンを「↗」だけにする。CHIP_MIN_WIDTH より狭ければ（「↗」と名前の頭が入らない）、札を出さない
const CHIP_COMPACT_WIDTH = 180
const CHIP_MIN_WIDTH = 56

export function AiNoteControls(props: {
  editor: Editor
  view: CanvasView
  session: SessionState
  claude: ClaudeClient
  // 答えを作っている付箋
  busy: ReadonlySet<string>
  // 答えのパネルかこの欄にフォーカスがある付箋（答えのパネルで見ている付箋）
  focusedNoteId: string | null
  // 送る（undo なら、前の作業の Canvas の変更を戻してから送る）
  onSend(noteId: string, undo?: boolean): void
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
  // 添える所を選んでいる付箋（選び始めた Canvas の Editor と一緒に持つ）。Canvas を移ったら、選ぶ状態を抜ける（戻ってきても続けない）
  const [pickingIn, setPickingIn] = useState<{ noteId: string; editor: Editor } | null>(null)
  if (pickingIn && pickingIn.editor !== editor) setPickingIn(null)
  const picking = pickingIn?.editor === editor && editor.getNode(pickingIn.noteId) ? pickingIn.noteId : null
  const setPicking = useCallback((noteId: string | null) => setPickingIn(noteId ? { noteId, editor } : null), [editor])
  // 添えたものの一覧を開いている付箋
  const [listing, setListing] = useState<string | null>(null)
  // 送信の ▾（「前の変更を戻してから送る」）を開いている付箋
  const [sendMenu, setSendMenu] = useState<string | null>(null)

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

  // 添える所を選んでいる間：範囲選択を終えたか、ノードを選んだか、PDF の文字をなぞったら、それを添える。
  // 添えたときに Ctrl（⌘）を押していなければ、付箋を選び直して抜ける。押していれば続け、離したら抜ける
  // （ドラッグの途中で離したら、そのドラッグで添えてから抜ける）。Esc でやめる
  useEffect(() => {
    if (!picking) return
    editor.session.set({ pickingContext: true })
    // held：Ctrl（⌘）を押しているか（キーと、ポインタのイベントの修飾キーで決める。選ぶ状態に入る前から押していても分かるように）。
    // picked：押したまま添えたか（離したら抜ける。何も添えずに離したなら、ズームのために押したなどなので抜けない）。
    // down：ボタンを押している（ドラッグの途中）。leaving：ドラッグの途中で離した（ドラッグを終えたら抜ける）。
    // stopped：抜けた（片付けたあとに届くものも、何もしない）
    let held = false
    let picked = false
    let down = false
    let leaving = false
    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      setPicking(null)
      if (editor.getNode(picking)) editor.setSelection([picking])
    }
    const take = (context: AiContext) => {
      if (held) {
        picked = true
        // 選んだものと範囲選択の枠を、付箋に戻しておく（残すと、次に押したとき・Undo で選択が戻ったときに、もう一度添える）。
        // 添える前に戻す（添えた編集の Undo で、付箋を選んだ状態に戻るように）
        editor.setSelection([picking])
        if (editor.session.get().lastBrush) editor.session.set({ lastBrush: null })
      }
      addContext(editor, picking, context, notify)
      if (!held || placesOf(aiNoteMeta(editor.getNode(picking))).length >= MAX_AI_PLACES) stop()
    }
    const unsubscribe = editor.session.subscribe((state, prev) => {
      if (stopped || state.brush || (state.selectedIds === prev.selectedIds && state.lastBrush === prev.lastBrush)) return
      const context = selectionContext(editor, view, picking)
      if (context) take(context)
    })
    const stopTextPicks = view.onTextPick((target) => {
      if (!stopped) take({ kind: 'canvas', label: pdfPlaceLabel(target), target })
    })
    const track = (e: KeyboardEvent | PointerEvent) => {
      held = e.ctrlKey || e.metaKey
    }
    const onPointer = (e: PointerEvent) => {
      track(e)
      if (e.type === 'pointerdown') down = true
      else if (e.type === 'pointerup' || e.type === 'pointercancel') down = false
    }
    // キャンバスがドラッグを終えたあと（泡の段）：途中で Ctrl（⌘）を離していたら、なぞった文字を読み終えて添えてから抜ける
    const afterRelease = () => {
      if (leaving && !stopped) void view.textPickSettled().then(stop)
    }
    const onKey = (e: KeyboardEvent) => {
      track(e)
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      stop()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      track(e)
      if (held || !picked) return
      if (down) leaving = true
      else stop()
    }
    // ⌘+Tab などでウィンドウを離れると、離したことが届かない
    const onBlur = () => {
      held = false
      if (picked) stop()
    }
    const pointerEvents = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    for (const type of pointerEvents) window.addEventListener(type, onPointer, true)
    window.addEventListener('pointerup', afterRelease)
    window.addEventListener('pointercancel', afterRelease)
    return () => {
      stopped = true
      unsubscribe()
      stopTextPicks()
      editor.session.set({ pickingContext: false })
      // なぞった所のハイライトを消す（ほかの Canvas へ移ったあとなら、移るときに消えている）
      if (view.editor === editor) view.clearWordHighlight()
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      for (const type of pointerEvents) window.removeEventListener(type, onPointer, true)
      window.removeEventListener('pointerup', afterRelease)
      window.removeEventListener('pointercancel', afterRelease)
    }
  }, [editor, view, picking, setPicking, notify])

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
        const width = box.w * camera.zoom
        if (width < CHIP_MIN_WIDTH) return null
        const compact = width < CHIP_COMPACT_WIDTH
        // 前の答えの札の ↗ のボタンの名前と、説明（狭い札では名前が「↗」だけになるので、ほかの Canvas なら説明にその名前を入れる）
        const elsewhere = answer?.kind === 'answer' && answer.canvasId !== editor.canvasId ? canvasTitle(answer.canvasId) : null
        const back = `↗ ${elsewhere ?? '元の付箋'}`
        const backTitle = elsewhere ? `元の付箋へ移る（${elsewhere}）` : '元の付箋へ移る'
        return (
          <div
            key={`chip:${node.id}`}
            className={compact ? 'ai-note-chips compact' : 'ai-note-chips'}
            style={{ ...screen(box.x, box.y), width }}
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
                    aria-label={compact ? '↗ 会話へ' : undefined}
                  >
                    <ChipButtonText compact={compact}>↗ 会話へ</ChipButtonText>
                  </button>
                )}
              </div>
            )}
            {answer?.kind === 'answer' && (
              <div className="ai-note-chip" title="前の質問と答えを踏まえて答えます">
                <span className="ai-note-chip-label">📎 「{answer.label}」の答え</span>
                <button type="button" onClick={() => onOpenContext(answer.canvasId, answer.noteId)} title={backTitle} aria-label={compact ? back : undefined}>
                  <ChipButtonText compact={compact}>{back}</ChipButtonText>
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
          const places = placesOf(meta)
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
                      ? `添える所を選んでいます（範囲をドラッグするか、ノードをクリック。${PICK_TEXT_HELP}。Esc でやめる）`
                      : `添える所を選ぶ（範囲をドラッグするか、ノードをクリック。${PICK_TEXT_HELP}。付箋と一緒に選んでいれば、それを添える）`
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
                  aria-label="Claude に頼む"
                  onClick={() => {
                    // 文字を編集している途中なら、編集を終えてから送る（書いた文字を指示にする）
                    if (view.textEditor.editingId === target) view.textEditor.finish()
                    setSendMenu(null)
                    onSend(target)
                  }}
                  title={answering ? 'Claude が作業しています' : 'Claude に頼む（文字の編集中は Ctrl+Enter）'}
                >
                  <span aria-hidden="true">➤</span>
                </button>
                {hasUndoableChanges(meta.answer) && (
                  <button
                    type="button"
                    className="ai-note-send-more"
                    disabled={answering}
                    aria-haspopup="menu"
                    aria-expanded={sendMenu === target}
                    aria-label="送り方を選ぶ"
                    title="送り方を選ぶ（前の作業の変更を戻してから送る）"
                    onClick={() => setSendMenu(sendMenu === target ? null : target)}
                  >
                    <span aria-hidden="true">▾</span>
                  </button>
                )}
              </div>
              {sendMenu === target && hasUndoableChanges(meta.answer) && (
                <div className="ai-note-send-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      if (view.textEditor.editingId === target) view.textEditor.finish()
                      setSendMenu(null)
                      onSend(target, true)
                    }}
                    title="前の作業でキャンバスに足した・変えたものを戻してから、もう一度頼む（ファイルとコマンドの変更は戻せません）"
                  >
                    前の変更を戻してから送る
                  </button>
                </div>
              )}
              {picking === target && <div className="ai-note-picking-help">{PICK_TEXT_HELP}</div>}
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

// 札のボタンの文字。狭い札（compact）では「↗」だけ（名前は aria-label で付ける）。はみ出す分は省略記号で切る
// （切るのは中の span。ボタンで切ると、ボタンの当たり（::before）も切れる）
function ChipButtonText({ compact, children }: { compact: boolean; children: string }) {
  return <span className="ai-note-chip-button-text">{compact ? '↗' : children}</span>
}

function AreaIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="2" width="12" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" />
      <path d="M8 5.5v5M5.5 8h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

// 修飾キーの名前（Mac は ⌘）と、PDF の文字のなぞり方
const MOD_KEY = isMacPlatform() ? '⌘' : 'Ctrl'
const PICK_TEXT_HELP = `PDF は ${MOD_KEY}+ドラッグで文字をなぞる。${MOD_KEY} を押している間は続けて選べる`

const TOO_MANY_PLACES = `添えられる所は ${MAX_AI_PLACES} か所までです。添えた数を押し、× で外してから添えてください`

// 付箋に添えるものを足す（同じものは足さない。選んだ所は MAX_AI_PLACES か所まで）
function addContext(editor: Editor, noteId: string, context: AiContext, notify: (message: string) => void): void {
  const meta = aiNoteMeta(editor.getNode(noteId))
  if (!meta) return
  if (meta.contexts.some((known) => sameAiContext(known, context))) return notify('もう添えてあります')
  if (context.kind === 'canvas' && placesOf(meta).length >= MAX_AI_PLACES) return notify(TOO_MANY_PLACES)
  setAiNote(editor, noteId, { ...meta, contexts: [...meta.contexts, context] }, 'Claude に添えるものを足す')
}

// 添えた所（kind: 'canvas'）と、contexts の中の位置
function placesOf(meta: AiNoteMeta | null): { context: Extract<AiContext, { kind: 'canvas' }>; index: number }[] {
  return (meta?.contexts ?? []).flatMap((context, index) => (context.kind === 'canvas' ? [{ context, index }] : []))
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

// 今選んでいるもの（付箋自身は除く）。範囲選択の枠がかかった PDF のページは、ページの中の範囲も持つ（送るときに、その文字を読む）
function selectionContext(editor: Editor, view: CanvasView, noteId: string): AiContext | null {
  const selected = [...editor.session.get().selectedIds].filter((id) => id !== noteId)
  const target = view.canvasReference()
  if (!target) return null
  const nodes = target.nodes.filter((node) => node.id !== noteId)
  if (nodes.length === 0 && selected.length === 0 && target.nodes.length > 0) return null
  const regions = view.canvasReferenceRegions().filter((region) => nodes.some((node) => node.id === region.nodeId))
  return {
    kind: 'canvas',
    label: nodes.length > 0 ? `${nodes.length} 個のノード` : 'キャンバスの範囲',
    target: { ...target, nodes },
    ...(regions.length > 0 ? { regions } : {}),
  }
}
