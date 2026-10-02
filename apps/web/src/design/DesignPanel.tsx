import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { NodeRecord } from '@canvcode/core'
import {
  KEEP_TEXT_EDITING_ATTRIBUTE,
  OWN_KEYS_ATTRIBUTE,
  PropertyEdit,
  editNodes,
  type CanvasView,
  type Editor,
  type SharedValue,
  type TextSelection,
} from '@canvcode/canvas'
import { ColorField, LineHeightField, NumberField, SegmentedField, SelectField, type ValueEditor } from './controls.tsx'
import { FontField } from './FontField.tsx'
import { textRangeOf, visibleSections, type DesignField } from './registry.ts'
import './sections.ts'

// デザインパネル（MAI-73）。Figma の右のパネルのように、選んでいるノードの見た目のプロパティを並べて変える。
// - 出すセクション・項目は registry.ts の登録から、選んでいるノードの型に合わせて決める（複数なら共通の項目だけ）
// - 1 回の変更は 1 つのトランザクション。スライダーなどのドラッグ中の変更は、離すまでを 1 つにまとめる（Undo 1 回）
// - パネルの中のキー入力は、キャンバスのショートカットに渡さない（data-own-keys）。ボタンはフォーカスを奪わない
// - 閉じると右上の小さなボタンだけになる。開け閉めはブラウザに覚える（storage.ts）
// - 文字を編集中に範囲を選んでいれば、文字の色・大きさ・フォントはその範囲の値を見せ（行間はノード単位。MAI-76）、その範囲に当てる（MAI-74、MAI-75）。
//   パネルにフォーカスが移っても文字の編集は終わらない（data-keep-text-editing）。値を入れ終えたら、編集中の文字にフォーカスを戻す

export function DesignPanel(props: {
  editor: Editor
  view: CanvasView | null
  nodes: readonly NodeRecord[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { editor, view, nodes, open, onOpenChange } = props
  const rootRef = useRef<HTMLElement>(null)
  // 続けて変えている途中の変更（スライダーのドラッグ・色の選択）。項目ごとに 1 つ
  const running = useRef<{ fieldId: string; edit: PropertyEdit } | null>(null)
  const ids = nodes.map((node) => node.id)
  const selectionKey = ids.join(',')
  const textEditor = view?.textEditor ?? null
  const textSelection = useSyncExternalStore(textEditor?.subscribeSelection ?? noSubscription, textEditor?.getSelectionSnapshot ?? noSelection)

  const endRunning = (commit: boolean) => {
    const current = running.current
    running.current = null
    if (!current) return
    if (commit) current.edit.commit()
    else current.edit.cancel()
  }

  // 選択が変わった・パネルを閉じた・Canvas を移ったら、途中の変更を確定する
  useEffect(() => () => endRunning(true), [selectionKey, open, editor])

  // パネルの外を押したら、途中の変更を確定する（色の選択を開いたままキャンバスを触ったときなど）。
  // キャンバスの操作がトランザクションを開く前に閉じておく
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return
      endRunning(true)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [])

  // 文字を編集中なら、その文字にフォーカスを戻す（選んでいた範囲も戻る）
  const backToCanvas = () => {
    if (textEditor?.editingId && textEditor.focus()) return
    view?.root.focus({ preventScroll: true })
  }

  // 書く時点の、編集中の文字の範囲（範囲ごとの書式の項目は、その範囲に当てる）
  const writer = <T,>(field: DesignField<T>, value: T) => {
    const selection: TextSelection | null = textEditor?.editingId ? textEditor.getSelectionSnapshot() : null
    return (node: NodeRecord) => field.write(node, value, textRangeOf(node, selection))
  }

  const valueEditor = <T,>(field: DesignField<T>): ValueEditor<T> => {
    const label = `design: ${field.id}`
    return {
      set(value) {
        endRunning(true)
        editNodes(editor, ids, writer(field, value), label, textEditor)
      },
      preview(value) {
        if (running.current?.fieldId !== field.id) {
          endRunning(true)
          running.current = { fieldId: field.id, edit: new PropertyEdit(editor, ids, label, textEditor) }
        }
        running.current.edit.update(writer(field, value))
      },
      end(commit) {
        if (running.current?.fieldId === field.id) endRunning(commit)
      },
    }
  }

  const sections = visibleSections(nodes, undefined, textSelection)
  if (sections.length === 0) return null

  if (!open) {
    return (
      <button
        className="design-panel-toggle"
        title="デザインパネルを開く"
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => onOpenChange(true)}
      >
        デザイン
      </button>
    )
  }

  return (
    <aside
      className="design-panel"
      ref={rootRef}
      aria-label="デザイン"
      {...{ [OWN_KEYS_ATTRIBUTE]: '', [KEEP_TEXT_EDITING_ATTRIBUTE]: '' }}
      data-testid="design-panel"
    >
      <header className="design-panel-header">
        <span className="design-panel-title">デザイン</span>
        <span className="design-panel-count">{nodes.length > 1 ? `${nodes.length} 個` : typeLabel(nodes[0])}</span>
        <button className="design-panel-close" title="閉じる" onPointerDown={(e) => e.preventDefault()} onClick={() => onOpenChange(false)}>
          ×
        </button>
      </header>
      {/* 選択が変わったら作り直し、入力中の文字を捨てる */}
      <div key={selectionKey} className="design-panel-body">
        {sections.map(({ section, fields, showComponent }) => (
          <section key={section.id} className="design-section" data-section={section.id}>
            <h3>{section.title}</h3>
            {fields.map(({ field, value }) => (
              <FieldView key={field.id} field={field} value={value} editor={valueEditor(field)} onDone={backToCanvas} />
            ))}
            {showComponent && section.Component && <section.Component nodes={nodes} />}
          </section>
        ))}
      </div>
    </aside>
  )
}

function FieldView(props: { field: DesignField<any>; value: SharedValue<any>; editor: ValueEditor<any>; onDone: () => void }) {
  const { field, value, editor, onDone } = props
  const control = field.control
  switch (control.kind) {
    case 'color':
      return <ColorField label={field.label} value={value} editor={editor} onDone={onDone} />
    case 'number':
      return <NumberField label={field.label} value={value} editor={editor} control={control} onDone={onDone} />
    case 'segmented':
      return <SegmentedField label={field.label} value={value} editor={editor} options={control.options} onDone={onDone} />
    case 'font':
      return <FontField label={field.label} value={value} editor={editor} onDone={onDone} />
    case 'lineHeight':
      return <LineHeightField label={field.label} value={value} editor={editor} onDone={onDone} />
    case 'select':
      return <SelectField label={field.label} value={value} editor={editor} options={control.options} onDone={onDone} />
  }
}

const noSubscription = () => () => {}
const noSelection = (): TextSelection | null => null

const TYPE_LABELS: Record<string, string> = {
  geo: '図形',
  text: 'テキスト',
  note: '付箋',
  arrow: '矢印',
  draw: 'フリーハンド',
  image: '画像',
}

function typeLabel(node: NodeRecord | undefined): string {
  return (node && TYPE_LABELS[node.type]) ?? node?.type ?? ''
}
