import { useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { MoveHorizontal, MoveVertical, RotateCcw, UnfoldHorizontal, UnfoldVertical } from 'lucide-react'
import type { NodeRecord } from '@canvcode/core'
import { PropertyEdit, editNodes, patchAdjust, tableHeightPatch, type Editor } from '@canvcode/canvas'
import { adjustOf, slotsOf } from '@canvcode/nodes'
import { isSlideLayout, layoutUsesRowGrid, TABLE_IMAGE_SPEC, TABLE_IMAGE_WIDTH_RANGE, tablePanelHeightRange } from '@canvcode/slides'
import { FieldLabel, NumberField, type ValueEditor } from './controls.tsx'
import type { DesignIcon, DesignSectionProps } from './registry.ts'
import { slideLayoutAdjustTarget } from './slideLayoutAdjustTarget.ts'

// スライド（v2）の「配置」：表パネル（中の行を含む）と右図枠の位置、table-image の表パネルの幅、表パネルの高さを手で直す。
// 高さの横の「自動に戻す」は、手で決めた高さ（table の h）だけを消す（行数と内容から決める高さに戻る）。
// 値は slide-layout の props.adjust（スライドの幾何の単位。1920 幅の px）に書き、並べ直し（コミットフック）が子を置き直す。
// スライド・表のセル・パネル・図枠のどれを選んでいても、その slide-layout を変える。表パネル・図枠のドラッグでも同じ値が変わる

type Key = { group: 'table' | 'figure'; key: 'dx' | 'dy' | 'w' | 'h' }

const OFFSET_LIMIT = 1920

// 行の左のアイコン（名前はツールチップ）
const ICONS: Record<Key['key'], DesignIcon> = { dx: MoveHorizontal, dy: MoveVertical, w: UnfoldHorizontal, h: UnfoldVertical }

export function SlideLayoutAdjustSection(props: DesignSectionProps) {
  const { editor, nodes } = props
  // 選んでいるノードがみな同じ slide-layout に属するときだけ出す
  const layouts = nodes.map((node) => slideLayoutAdjustTarget(editor, node)?.id)
  const layoutId = layouts.every((id) => id !== undefined && id === layouts[0]) ? layouts[0]! : null
  const layout = useLayoutRecord(editor, layoutId)
  // 続けて変えている途中の変更（ラベルのドラッグ）。項目ごとに 1 つ
  const running = useRef<{ key: string; edit: PropertyEdit } | null>(null)
  const endRunning = (commit: boolean) => {
    const current = running.current
    running.current = null
    if (!current) return
    if (commit) current.edit.commit()
    else current.edit.cancel()
  }
  useEffect(() => () => endRunning(true), [layoutId, editor])

  if (!layout) return null
  const kind = (layout.props as Record<string, unknown>).layout
  const adjust = adjustOf((layout.props as Record<string, unknown>).adjust)
  const isTableImage = kind === 'table-image'
  // 表パネルの高さ：決めていなければ今の（行数と内容から決まった）高さを出す。範囲は行数で決まる
  const slots = slotsOf((layout.props as Record<string, unknown>).slots)
  const rowCount = slots.rows.filter((row) => editor.getNode(row.body)?.parentId === layout.id).length
  const panel = slots.panel ? editor.getNode(slots.panel) : undefined
  const panelH = (panel?.props as Record<string, unknown> | undefined)?.h
  const heightRange = isSlideLayout(kind) && layoutUsesRowGrid(kind) ? tablePanelHeightRange(kind, rowCount) : null

  const write = (patch: Parameters<typeof patchAdjust>[1]) => (node: NodeRecord) => {
    const current = adjustOf((node.props as Record<string, unknown>).adjust)
    const next = patchAdjust(current, patch)
    return JSON.stringify(next) === JSON.stringify(current) ? node : { ...node, props: { ...node.props, adjust: next } }
  }
  const valueEditor = ({ group, key }: Key): ValueEditor<number> => {
    const id = `${group}.${key}`
    const label = `design: slide-layout.${id}`
    // 高さを決めるときは、パネルの上端が今の位置に残るように dy も決め直す（tableHeightPatch）
    const patch = (value: number) =>
      key === 'h' ? { table: tableHeightPatch(kind, rowCount, panel?.parentId === layout.id ? panel.y : undefined, value) ?? {} } : { [group]: { [key]: value } }
    return {
      set(value) {
        endRunning(true)
        editNodes(editor, [layout.id], write(patch(value)), label)
      },
      preview(value) {
        if (running.current?.key !== id) {
          endRunning(true)
          running.current = { key: id, edit: new PropertyEdit(editor, [layout.id], label) }
        }
        running.current.edit.update(write(patch(value)))
      },
      end(commit) {
        if (running.current?.key === id) endRunning(commit)
      },
    }
  }
  const field = (k: Key, label: string, value: number, range: { min: number; max: number }, extra?: ReactNode) => (
    <NumberField
      key={`${k.group}.${k.key}`}
      label={label}
      icon={ICONS[k.key]}
      value={{ kind: 'same', value }}
      editor={valueEditor(k)}
      control={{ kind: 'number', ...range, step: 1, unit: 'px' }}
      extra={extra}
    />
  )
  // 高さの横の「自動に戻す」：table の h だけを消す（位置・幅・画像の値は残す）。高さが自動なら押せない
  const autoHeight = (
    <button
      className="design-icon-button"
      title="高さを自動に戻す"
      aria-label="高さを自動に戻す"
      disabled={adjust.table?.h === undefined}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => {
        endRunning(true)
        editNodes(editor, [layout.id], write({ table: { h: undefined } }), 'design: slide-layout.table.h.auto')
      }}
    >
      <RotateCcw size={16} strokeWidth={1.75} aria-hidden />
    </button>
  )
  const offset = { min: -OFFSET_LIMIT, max: OFFSET_LIMIT }
  const hasAdjust = adjust.table !== undefined || adjust.figure !== undefined

  return (
    <div className="design-slide-adjust" data-testid="slide-layout-adjust">
      <div className="design-field">
        <FieldLabel label="表" />
        <div className="design-control">
          <button
            className="design-fill-toggle"
            title="配置を元に戻す"
            aria-label="配置を元に戻す"
            disabled={!hasAdjust}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              endRunning(true)
              editNodes(editor, [layout.id], (node) => ({ ...node, props: withoutAdjust(node.props as Record<string, unknown>) }), 'design: slide-layout.reset')
            }}
          >
            <RotateCcw size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      </div>
      <div className="design-field-row" data-row="slide-layout.table">
        {field({ group: 'table', key: 'dx' }, '横の位置', adjust.table?.dx ?? 0, offset)}
        {field({ group: 'table', key: 'dy' }, '縦の位置', adjust.table?.dy ?? 0, offset)}
      </div>
      {isTableImage && field({ group: 'table', key: 'w' }, '幅', adjust.table?.w ?? TABLE_IMAGE_SPEC.tableWidth, TABLE_IMAGE_WIDTH_RANGE)}
      {heightRange &&
        field({ group: 'table', key: 'h' }, '高さ', adjust.table?.h ?? (typeof panelH === 'number' ? Math.round(panelH) : heightRange.max), heightRange, autoHeight)}
      {isTableImage && (
        <>
          <div className="design-field">
            <FieldLabel label="画像" />
          </div>
          <div className="design-field-row" data-row="slide-layout.figure">
            {field({ group: 'figure', key: 'dx' }, '横の位置', adjust.figure?.dx ?? 0, offset)}
            {field({ group: 'figure', key: 'dy' }, '縦の位置', adjust.figure?.dy ?? 0, offset)}
          </div>
        </>
      )}
    </div>
  )
}

function withoutAdjust(props: Record<string, unknown>): Record<string, unknown> {
  const { adjust: _, ...rest } = props
  return rest
}

// slide-layout のレコード。変わったら描き直す（選んでいる子ではなく親の props が変わるので、パネルの選択の更新では追えない）
function useLayoutRecord(editor: Editor, layoutId: string | null): NodeRecord | null {
  const subscribe = useCallback(
    (onChange: () => void) =>
      editor.store.listen((event) => {
        if (layoutId && event.patch.has(layoutId)) onChange()
      }),
    [editor, layoutId],
  )
  return useSyncExternalStore(subscribe, () => (layoutId ? (editor.getNode(layoutId) ?? null) : null))
}
