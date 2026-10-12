import { useEffect, useRef } from 'react'
import { RotateCw, Ruler } from 'lucide-react'
import type { NodeRecord } from '@canvcode/core'
import { PropertyEdit, arrowDirectionUpdate, editNodes, sharedOf, type ArrowDirectionChange } from '@canvcode/canvas'
import { arrowAngle, arrowLength, normalizeAngle, type ArrowProps } from '@canvcode/nodes'
import { NumberField, type ValueEditor } from './controls.tsx'
import type { DesignSectionProps } from './registry.ts'

// 矢印の向き（角度）と長さ。角度は 0° が右、時計回り、0〜360°（ノードの回転・グラデーションの角度と同じ）。
// 角度を変えると、つながっていない矢印は真ん中を中心に回り、一方の端がつながっている矢印はその端を中心に回る（canvas の arrowDirection.ts）。
// 両端ともつながっている矢印は、向きも長さもつながる先で決まるので、このセクションを出さない（sections.ts の appliesTo）

// 表示の値（0.1 刻みに丸める）
const round1 = (value: number) => Math.round(value * 10) / 10

export function ArrowDirectionSection(props: DesignSectionProps) {
  const { editor, nodes } = props
  const arrows = nodes.filter((node): node is NodeRecord<ArrowProps> => node.type === 'arrow')
  const ids = arrows.map((node) => node.id)
  const key = ids.join(',')
  // 続けて変えている途中の変更（ラベルのドラッグ）。項目ごとに 1 つ
  const running = useRef<{ key: string; edit: PropertyEdit } | null>(null)
  const endRunning = (commit: boolean) => {
    const current = running.current
    running.current = null
    if (!current) return
    if (commit) current.edit.commit()
    else current.edit.cancel()
  }
  useEffect(() => () => endRunning(true), [key, editor])

  if (arrows.length === 0 || arrows.length !== nodes.length) return null

  const valueEditor = (field: 'angle' | 'length'): ValueEditor<number> => {
    const label = `design: arrow.${field}`
    const update = (value: number) => arrowDirectionUpdate(editor, (field === 'angle' ? { angle: normalizeAngle(value) } : { length: value }) as ArrowDirectionChange)
    return {
      set(value) {
        endRunning(true)
        editNodes(editor, ids, update(value), label)
      },
      preview(value) {
        if (running.current?.key !== field) {
          endRunning(true)
          running.current = { key: field, edit: new PropertyEdit(editor, ids, label) }
        }
        running.current.edit.update(update(value))
      },
      end(commit) {
        if (running.current?.key === field) endRunning(commit)
      },
    }
  }

  return (
    <div className="design-field-row" data-row="arrow.direction" data-testid="arrow-direction">
      <NumberField
        label="角度"
        icon={RotateCw}
        value={sharedOf(arrows.map((node) => round1(arrowAngle(node.props))))!}
        editor={valueEditor('angle')}
        control={{ kind: 'number', min: -360, max: 720, step: 1, unit: '°' }}
      />
      <NumberField
        label="長さ"
        icon={Ruler}
        value={sharedOf(arrows.map((node) => round1(arrowLength(node.props))))!}
        editor={valueEditor('length')}
        control={{ kind: 'number', min: 1, max: 100000, step: 1, unit: 'px' }}
      />
    </div>
  )
}
