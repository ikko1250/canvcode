import { useEffect, useMemo, useState } from 'react'
import type { Camera, NodeRecord } from '@canvcode/core'
import { aiNoteMeta, setAiNote, type AiContext, type AiNoteMeta, type CanvasView, type Editor } from '@canvcode/canvas'
import type { ClaudeClient, Effort } from './claudeClient.ts'
import { useClaudeState } from './claudeClient.ts'
import { ModelPicker } from './ModelPicker.tsx'
import { loadSetting, saveSetting, type ModelSetting } from './modelChoice.ts'

// AI モードの付箋（meta.ai。Claude に聞く付箋）の下に出す欄。カメラに付いて動く。2 段に分ける：
// - 1 段目：左にモデルと effort（チャットと同じ選び方。付箋ごとに覚え、最後に選んだものとしても覚える）と
//   「＋ 選んでいる所」（今選んでいるものを、いくつでも Claude に添える）、右に送信（付箋の文字の編集中は Ctrl+Enter でも送る）
// - 2 段目から：添えたもの（続きの質問なら前の答え）。長い名前は省き（名前の全体はホバーで出る）、多ければ折り返す。× で外す。何も添えていなければ出さない
// 答えを書いている間は出さない（質問の付箋の右上に「書いています」が出る）。小さく表示しているときも出さない
const MIN_ZOOM = 0.3
// 欄の幅の下限（画面のピクセル）
const MIN_WIDTH = 320

export function AiNoteControls(props: {
  editor: Editor
  view: CanvasView
  camera: Camera
  claude: ClaudeClient
  // 答えを書いている付箋
  busy: ReadonlySet<string>
  onSend(noteId: string): void
  notify(message: string): void
}) {
  const { editor, view, camera, claude, busy, onSend, notify } = props
  const notes = useAiNotes(editor)
  const { models } = useClaudeState(claude)

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
      onSend(id)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [editor, view, onSend])

  if (camera.zoom < MIN_ZOOM) return null
  return (
    <>
      {notes.map((node) => {
        const meta = aiNoteMeta(node)
        const box = editor.index.get(node.id)?.worldBounds
        if (!meta || !box || busy.has(node.id)) return null
        const setting: ModelSetting = meta.model || meta.effort ? { ...(meta.model ? { model: meta.model } : {}), ...(meta.effort ? { effort: meta.effort as Effort } : {}) } : loadSetting()
        const update = (patch: Partial<AiNoteMeta>, label?: string) => {
          const latest = aiNoteMeta(editor.getNode(node.id))
          if (latest) setAiNote(editor, node.id, { ...latest, ...patch }, label)
        }
        const addSelection = () => {
          const context = selectionContext(editor, view, node.id)
          if (!context) return notify('添えたいもの（付箋・画像・PDF・答えのフレームなど）を選んでから押してください')
          if (meta.contexts.some((known) => sameContext(known, context))) return notify('もう添えてあります')
          update({ contexts: [...meta.contexts, context] }, 'Claude に添えるものを足す')
        }
        return (
          <div
            key={node.id}
            className="ai-note-controls"
            data-own-keys=""
            style={{ left: (box.x - camera.x) * camera.zoom, top: (box.y + box.h - camera.y) * camera.zoom + 6, width: Math.max(MIN_WIDTH, box.w * camera.zoom) }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="ai-note-controls-row">
              <ModelPicker
                catalog={models}
                setting={setting}
                placement="down"
                onChange={(next) => {
                  saveSetting(next)
                  update({ model: next.model ?? '', effort: next.effort ?? '' }, 'モデルを選ぶ')
                }}
              />
              <button type="button" className="ai-note-attach" onClick={addSelection} title="今選んでいるものを、Claude に添える（いくつでも）">
                ＋ 選んでいる所
              </button>
              <button
                type="button"
                className="ai-note-send"
                onClick={() => {
                  // 文字を編集している途中なら、編集を終えてから送る（書いた文字を質問にする）
                  if (view.textEditor.editingId === node.id) view.textEditor.finish()
                  onSend(node.id)
                }}
                title="Claude に送る（文字の編集中は Ctrl+Enter）"
              >
                送信
              </button>
            </div>
            {meta.contexts.length > 0 && (
              <div className="ai-note-contexts">
                {meta.contexts.map((context, i) => {
                  const label = context.kind === 'answer' ? `続き：${context.label}` : context.label
                  return (
                    <span key={i} className="ai-note-context" title={`${label}（${context.kind === 'answer' ? '前の答えを踏まえて答えます' : '選んだ所を Claude に見せます'}）`}>
                      <span className="ai-note-context-label">{label}</span>
                      <button
                        type="button"
                        aria-label="外す"
                        title="外す"
                        onClick={() => update({ contexts: meta.contexts.filter((_, j) => j !== i) }, 'Claude に添えるものを外す')}
                      >
                        ×
                      </button>
                    </span>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

// 今の Canvas の AI モードの付箋。付箋の meta.ai か位置・大きさが変わったら読み直す
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
    return editor.index.allIds().flatMap((id) => {
      const node = editor.getNode(id)
      return node && aiNoteMeta(node) ? [node] : []
    })
  }, [editor, version])
}

// 今選んでいるもの（付箋自身は除く）。答えのフレームを 1 つだけ選んでいれば、その答え（続きの質問として前の答えを渡す）
function selectionContext(editor: Editor, view: CanvasView, noteId: string): AiContext | null {
  const selected = [...editor.session.get().selectedIds].filter((id) => id !== noteId)
  if (selected.length === 1) {
    const node = editor.getNode(selected[0]!)
    if (node?.type === 'frame' && node.meta?.answer) return { kind: 'answer', frameId: node.id, label: (node.props as { name?: string }).name || '答え' }
  }
  const target = view.canvasReference()
  if (!target) return null
  const nodes = target.nodes.filter((node) => node.id !== noteId)
  if (nodes.length === 0 && selected.length === 0 && target.nodes.length > 0) return null
  return { kind: 'canvas', label: nodes.length > 0 ? `${nodes.length} 個のノード` : 'キャンバスの範囲', target: { ...target, nodes } }
}

function sameContext(a: AiContext, b: AiContext): boolean {
  if (a.kind === 'answer' && b.kind === 'answer') return a.frameId === b.frameId
  if (a.kind !== 'canvas' || b.kind !== 'canvas') return false
  const ids = (context: typeof a) => context.target.nodes.map((node) => node.id).sort().join(',')
  return ids(a) === ids(b) && JSON.stringify(a.target.rect) === JSON.stringify(b.target.rect)
}
