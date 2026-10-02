import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { NodeRecord } from '@canvcode/core'
import {
  KEEP_TEXT_EDITING_ATTRIBUTE,
  OWN_KEYS_ATTRIBUTE,
  PropertyEdit,
  editNodes,
  hitGradientHandle,
  usedColors,
  type CanvasView,
  type Editor,
  type PaintEditing,
  type SharedValue,
  type TextSelection,
} from '@canvcode/canvas'
import { IMAGE_VARIANT_SIZES, TEXT_TOGGLE_FORMATS } from '@canvcode/nodes'
import { CornerRadiusField, LineHeightField, NumberField, SegmentedField, SelectField, ToggleGroup, type ValueEditor } from './controls.tsx'
import { ColorField, PaintField } from './ColorPicker.tsx'
import { UsedColorsContext } from './usedColorsContext.ts'
import { FontField } from './FontField.tsx'
import { ShadowsField } from './ShadowsField.tsx'
import { ChartDataField } from './ChartDataField.tsx'
import { textRangeOf, visibleSections, type DesignField, type VisibleSection } from './registry.ts'
import { TEXT_SECTION_TAB, TEXT_TOGGLE_FIELDS, paintBoxSize } from './sections.ts'
import type { PaintEditingLink } from './GradientEditor.tsx'
import type { PaintImageSource } from './ImagePaintEditor.tsx'
import { applyTextToggle, editingTextOf, editingToggleValue } from './textToggles.ts'

// デザインパネル（MAI-73）。Figma の右のパネルのように、選んでいるノードの見た目のプロパティを並べて変える。
// - 出すセクション・項目は registry.ts の登録から、選んでいるノードの型に合わせて決める（複数なら共通の項目だけ）
// - 1 回の変更は 1 つのトランザクション。スライダーなどのドラッグ中の変更は、離すまでを 1 つにまとめる（Undo 1 回）
// - パネルの中のキー入力は、キャンバスのショートカットに渡さない（data-own-keys）。ボタンはフォーカスを奪わない
// - 閉じると右上の小さなボタンだけになる。開け閉めはブラウザに覚える（storage.ts）
// - 文字を編集中に範囲を選んでいれば、文字の色・大きさ・フォントはその範囲の値を見せ（行間はノード単位。MAI-76）、その範囲に当てる（MAI-74、MAI-75）。
//   パネルにフォーカスが移っても文字の編集は終わらない（data-keep-text-editing）。値を入れ終えたら、編集中の文字にフォーカスを戻す
// - 太字・斜体・下線・取り消し線（MAI-79）は 1 行にボタンを並べる（control の group）。編集中は Ctrl+B などと同じに切り替える（textToggles.ts）
// - 色の項目はカラーピッカー（ColorPicker.tsx。MAI-81）。「このキャンバスで使った色」は、ピッカーを開いたときに今の Canvas から集める
// - 塗りのグラデーション（MAI-82）を開いている間は、図形の上にハンドルを出す（session.paintEditing。1 つの図形を選んでいるときだけ）
// - 画像の塗り（MAI-83）の画像は、CanvasView の Asset（ワークスペースの画像・ファイル・クリップボード）から選ぶ（paintImageSource）
// - 影（MAI-86）は「効果」に一覧で出す（ShadowsField。＋・−・表示の切り替え、影ごとの値）
// - 角丸（MAI-84）は、4 つの角を一緒に変える入力と、角ごとの 4 つの入力（CornerRadiusField）。図形の上の角丸のハンドルでも変えられる（cornerHandles.ts）
// - グラフ（MAI-88）は「グラフ」にデータの表（ChartDataField。行の色・ラベル・値、CSV/TSV の貼り付け）、ドーナツの穴・開始角度・ラベルの表示
// - 図形の中の文字の書式は「文字」のタブに分ける（section.tab）。タブが 2 つ以上あるときだけ、見出しにタブを並べる。
//   図形の文字を編集している間は、選んでいなければ「文字」のタブを開く
// - 図形の「形」（MAI-87）で矩形・楕円・ブロック矢印を切り替え、ブロック矢印の軸の太さなどを % で変える。図形の上の形のハンドルでも変えられる（blockArrowHandles.ts）

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

  const getUsedColors = useCallback(() => usedColors(editor), [editor])

  // 塗りのグラデーションを、図形の上のハンドルでも編集できるようにする（1 つだけ選んでいるとき）
  const paintEditing = useSyncExternalStore(editor.session.subscribe, () => editor.session.get().paintEditing)
  const singleId = nodes.length === 1 ? nodes[0].id : null
  const paintLink = useMemo(() => paintEditingLink(editor, view, singleId), [editor, view, singleId])
  const paintImages = useMemo(() => paintImageSource(view), [view])

  // 選んだタブ（null は自動。文字を編集中なら文字のタブ、そうでなければ最初のタブ）
  const [chosenTab, setChosenTab] = useState<string | null>(null)
  const editingId = useSyncExternalStore(editor.session.subscribe, () => editor.session.get().editingId)

  const allSections = visibleSections(nodes, undefined, textSelection)
  if (allSections.length === 0) return null
  // 見た目のタブ（MAIN_TAB）をいつも先頭にする（文字のセクションが見た目のセクションより上に並ぶ組み合わせでも）
  const tabs = [...new Set(allSections.map(({ tab }) => tab ?? MAIN_TAB))].sort((a, b) => Number(b === MAIN_TAB) - Number(a === MAIN_TAB))
  const editingLabel = editingId !== null && ids.includes(editingId) && tabs.includes(TEXT_SECTION_TAB) ? TEXT_SECTION_TAB : null
  const tab = chosenTab !== null && tabs.includes(chosenTab) ? chosenTab : (editingLabel ?? tabs[0])
  const sections = tabs.length > 1 ? allSections.filter((visible) => (visible.tab ?? MAIN_TAB) === tab) : allSections
  const mainTitle = nodes.length > 1 ? `${nodes.length} 個` : typeLabel(nodes[0])

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
        {tabs.length > 1 ? (
          <div className="design-panel-tabs" role="tablist" aria-label="デザインのタブ">
            {tabs.map((id) => (
              <button
                key={id}
                role="tab"
                aria-selected={id === tab}
                className={id === tab ? 'design-panel-tab active' : 'design-panel-tab'}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => setChosenTab(id)}
              >
                {id === MAIN_TAB ? mainTitle : id}
              </button>
            ))}
          </div>
        ) : (
          <span className="design-panel-count">{mainTitle}</span>
        )}
        <button className="design-panel-close" title="閉じる" onPointerDown={(e) => e.preventDefault()} onClick={() => onOpenChange(false)}>
          ×
        </button>
      </header>
      {/* 選択が変わったら作り直し、入力中の文字を捨てる */}
      <UsedColorsContext.Provider value={getUsedColors}>
        <div key={`${selectionKey}:${tab}`} className="design-panel-body">
          {sections.map(({ section, fields, showComponent }) => (
            <section key={section.id} className="design-section" data-section={section.id}>
              <h3>{section.title}</h3>
              {fieldRows(fields).map((row) =>
                row.kind === 'toggles' ? (
                  <ToggleGroup
                    key={row.group}
                    label={row.group}
                    items={row.fields.map(({ field, value }) => {
                      const control = field.control as Extract<DesignField['control'], { kind: 'toggle' }>
                      const key = TEXT_TOGGLE_FORMATS.find((k) => TEXT_TOGGLE_FIELDS[k] === field)!
                      const editing = editingTextOf(textEditor, nodes)
                      const shown = editing ? editingToggleValue(editing, key) : (value as SharedValue<boolean>)
                      return {
                        id: field.id,
                        title: control.title,
                        icon: control.icon,
                        value: shown,
                        onToggle: () => {
                          endRunning(true)
                          applyTextToggle(editor, textEditor, nodes, key, shown)
                        },
                      }
                    })}
                  />
                ) : (
                  <FieldView
                    key={row.field.field.id}
                    field={row.field.field}
                    value={row.field.value}
                    editor={valueEditor(row.field.field)}
                    nodes={nodes}
                    paint={{ link: paintLink, editing: paintEditing?.nodeId === singleId ? paintEditing : null, images: paintImages }}
                    onDone={backToCanvas}
                  />
                ),
              )}
              {showComponent && section.Component && <section.Component nodes={nodes} />}
            </section>
          ))}
        </div>
      </UsedColorsContext.Provider>
    </aside>
  )
}

function FieldView(props: {
  field: DesignField<any>
  value: SharedValue<any>
  editor: ValueEditor<any>
  nodes: readonly NodeRecord[]
  paint: { link: PaintEditingLink | null; editing: PaintEditing | null; images: PaintImageSource | null }
  onDone: () => void
}) {
  const { field, value, editor, nodes, paint, onDone } = props
  const control = field.control
  switch (control.kind) {
    case 'color':
      return <ColorField label={field.label} value={value} editor={editor} onDone={onDone} />
    case 'paint':
      return (
        <PaintField
          label={field.label}
          value={value}
          editor={editor}
          canOpacity={nodes.every((node) => control.opacity?.(node) ?? true)}
          canNone={nodes.every((node) => control.none?.(node) ?? true)}
          canGradient={nodes.every((node) => control.gradient?.(node) ?? false)}
          canImage={nodes.every((node) => control.image?.(node) ?? false)}
          images={paint.images}
          sizes={nodes.map(paintBoxSize)}
          link={paint.link}
          paintEditing={paint.editing}
          role={control.role}
          onDone={onDone}
        />
      )
    case 'number':
      return <NumberField label={field.label} value={value} editor={editor} control={control} onDone={onDone} />
    case 'segmented':
      return <SegmentedField label={field.label} value={value} editor={editor} options={control.options} onDone={onDone} />
    case 'font':
      return <FontField label={field.label} value={value} editor={editor} onDone={onDone} />
    case 'lineHeight':
      return <LineHeightField label={field.label} value={value} editor={editor} onDone={onDone} />
    case 'cornerRadius':
      return <CornerRadiusField label={field.label} value={value} editor={editor} onDone={onDone} />
    case 'shadows':
      return <ShadowsField label={field.label} value={value} editor={editor} onDone={onDone} />
    case 'chartData':
      return <ChartDataField label={field.label} value={value} editor={editor} onDone={onDone} />
    case 'select':
      return <SelectField label={field.label} value={value} editor={editor} options={control.options} onDone={onDone} />
    case 'toggle':
      // fieldRows で ToggleGroup にまとめる
      return null
  }
}

// オン・オフのボタン（group の同じ項目が続くもの）を 1 行にまとめる
type FieldRow =
  | { kind: 'field'; field: VisibleSection['fields'][number] }
  | { kind: 'toggles'; group: string; fields: VisibleSection['fields'] }

function fieldRows(fields: VisibleSection['fields']): FieldRow[] {
  const rows: FieldRow[] = []
  for (const item of fields) {
    const control = item.field.control
    if (control.kind !== 'toggle') {
      rows.push({ kind: 'field', field: item })
      continue
    }
    const last = rows.at(-1)
    if (last?.kind === 'toggles' && last.group === control.group) last.fields.push(item)
    else rows.push({ kind: 'toggles', group: control.group, fields: [item] })
  }
  return rows
}

// 図形の上のグラデーションのハンドルとのつなぎ（MAI-82）。1 つだけ選んでいるときだけ
function paintEditingLink(editor: Editor, view: CanvasView | null, nodeId: string | null): PaintEditingLink | null {
  if (!nodeId) return null
  return {
    begin: (stop) => editor.session.set({ paintEditing: { nodeId, stop } }),
    end: () => {
      if (editor.session.get().paintEditing?.nodeId === nodeId) editor.session.set({ paintEditing: null })
    },
    selectStop: (stop) => {
      const current = editor.session.get().paintEditing
      if (current?.nodeId === nodeId && current.stop !== stop) editor.session.set({ paintEditing: { ...current, stop } })
    },
    ownsPointer: (e) => {
      const root = view?.root
      if (!root || !(e.target instanceof Node) || !root.contains(e.target)) return false
      const rect = root.getBoundingClientRect()
      return hitGradientHandle(editor, { x: e.clientX - rect.left, y: e.clientY - rect.top }) !== null
    },
  }
}

// 画像の塗り（MAI-83）の画像を選ぶ先。Asset は CanvasView が持つ
function paintImageSource(view: CanvasView | null): PaintImageSource | null {
  if (!view) return null
  const assets = view.assets
  return {
    list: () => assets.images(),
    get: (assetId) => assets.get(assetId),
    url: (assetId) => {
      const record = assets.get(assetId)
      return record ? assets.url(record, IMAGE_VARIANT_SIZES[0]) : null
    },
    importFile: (file) => view.importImageFile(file),
    importClipboard: () => view.importClipboardImage(),
  }
}

// タブの名前。section.tab のないセクションは最初のタブ（見出しにはノードの種類を出す）
const MAIN_TAB = ''

const noSubscription = () => () => {}
const noSelection = (): TextSelection | null => null

const TYPE_LABELS: Record<string, string> = {
  geo: '図形',
  text: 'テキスト',
  note: '付箋',
  arrow: '矢印',
  draw: 'フリーハンド',
  image: '画像',
  chart: 'グラフ',
}

function typeLabel(node: NodeRecord | undefined): string {
  return (node && TYPE_LABELS[node.type]) ?? node?.type ?? ''
}
