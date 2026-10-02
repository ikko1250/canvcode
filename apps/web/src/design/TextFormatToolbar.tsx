import { useSyncExternalStore, type ComponentType } from 'react'
import { KEEP_TEXT_EDITING_ATTRIBUTE, OWN_KEYS_ATTRIBUTE, type CanvasView, type Editor, type TextSelection } from '@canvcode/canvas'
import type { Camera } from '@canvcode/core'
import { ToggleButton } from './controls.tsx'
import { TEXT_TOGGLE_FIELDS } from './sections.ts'
import { TEXT_TOGGLE_SHORTCUTS, applyTextToggle, editingToggleItems } from './textToggles.ts'

// 文字を編集している間、そのテキスト・付箋のすぐ上に出す小さなツールバー（MAI-79）。太字・斜体・下線・取り消し線を切り替える。
// - キャンバスのズーム・パンに追従する（ノードの画面上の位置に付いて動く）。ボタンの大きさはズームによらず一定。
//   上に場所がなければ（画面の上端に近い）ノードの下に出す
// - ボタンはフォーカスを奪わない（デザインパネルと同じ。押しても編集中の文字の選択が残る）。
//   ツールバーの中にフォーカスが移っても、文字の編集は終えない（data-keep-text-editing）
// - 表示・切り替えはデザインパネルと同じ（textToggles.ts。範囲の値、範囲がなければ次に打つ文字の書式）

const TOOLBAR_HEIGHT = 32
const GAP = 8
// 画面の上端からこれより近ければ、ノードの下に出す（上のパンくずリストと重ならないように）
const TOP_MARGIN = 48

export function TextFormatToolbar(props: { editor: Editor; view: CanvasView | null; camera: Camera }) {
  const { editor, view, camera } = props
  const textEditor = view?.textEditor ?? null
  // 選択・書式が変わるたびに描き直す
  const selection = useSyncExternalStore(textEditor?.subscribeSelection ?? noSubscription, textEditor?.getSelectionSnapshot ?? noSelection)
  if (!textEditor || !selection) return null
  const node = editor.getNode(selection.nodeId)
  const entry = editor.index.get(selection.nodeId)
  if (!node || !entry || (node.type !== 'text' && node.type !== 'note')) return null
  const bounds = entry.worldBounds
  const x = (bounds.x - camera.x) * camera.zoom
  const y = (bounds.y - camera.y) * camera.zoom
  const above = y - GAP - TOOLBAR_HEIGHT
  const top = above >= TOP_MARGIN ? above : y + bounds.h * camera.zoom + GAP
  return (
    <div
      className="text-format-toolbar"
      role="toolbar"
      aria-label="文字の書式"
      data-testid="text-format-toolbar"
      style={{ left: Math.max(GAP, x), top }}
      {...{ [OWN_KEYS_ATTRIBUTE]: '', [KEEP_TEXT_EDITING_ATTRIBUTE]: '' }}
      onPointerDown={(e) => {
        // ボタンの間を押しても、キャンバスの操作にしない・フォーカスを奪わない
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {editingToggleItems(textEditor).map((item) => {
        const control = TEXT_TOGGLE_FIELDS[item.key].control as { icon: ComponentType }
        return (
          <ToggleButton
            key={item.key}
            item={{
              id: `text.${item.key}`,
              title: `${item.title}（${TEXT_TOGGLE_SHORTCUTS[item.key]}）`,
              icon: control.icon,
              value: item.value,
              onToggle: () => applyTextToggle(editor, textEditor, [node], item.key, item.value),
            }}
          />
        )
      })}
    </div>
  )
}

const noSubscription = () => () => {}
const noSelection = (): TextSelection | null => null
