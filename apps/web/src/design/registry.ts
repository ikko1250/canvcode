import type { NodeRecord } from '@canvcode/core'
import { sameValue, sharedValue, type SharedValue } from '@canvcode/canvas'
import type { ComponentType } from 'react'

// デザインパネルのセクションと項目の登録（MAI-73）。
// パネルは、選んでいるノードに合わせて、登録したセクションを上から順に並べる。
// - 項目（DesignField）：1 つの値（塗りの色、線の太さなど）。どの型のノードが持つか、読み書きのしかた、入力部品を決める
// - セクション（DesignSection）：見出しの付いた項目のまとまり（塗り・線・文字など）
// 選んでいるノードのすべてが持つ項目だけを出す（複数の型を選んだときは共通の項目）。値が違えば「混在」と出す。
// 後の課題（グラデーション・角丸・ボーダー・シャドウなど）は、registerDesignSection でセクションを足すか、
// 既存のセクションに項目を足す。項目の入力部品で足りないものは、セクションの Component で自由に描ける

// 入力部品の種類（controls.tsx の部品）
export type FieldControl =
  | { kind: 'color' }
  | {
      kind: 'number'
      min?: number
      max?: number
      step?: number
      // 数字の右に出す単位（「px」「%」）
      unit?: string
      // 数字の入力の下にスライダーも出す（min と max が要る）。ドラッグ中の変更は Undo 1 回にまとまる
      slider?: boolean
      // 表示する値と、ノードに入れる値の換算（不透明度を 0〜100 % で見せるなど）。既定はそのまま
      toDisplay?: (value: number) => number
      fromDisplay?: (value: number) => number
    }
  | { kind: 'segmented'; options: readonly SegmentOption[] }

export interface SegmentOption {
  value: string
  title: string
  // ボタンに出す文字。icon を指定したときは使わない
  label?: string
  icon?: ComponentType
}

export interface DesignField<T = unknown> {
  id: string
  label: string
  // この項目を持つノードか
  appliesTo(node: NodeRecord): boolean
  read(node: NodeRecord): T
  // 値を変えたノード。同じ値なら同じノードを返す（差分に入れない）
  write(node: NodeRecord, value: T): NodeRecord
  control: FieldControl
}

export interface DesignSectionProps {
  nodes: readonly NodeRecord[]
}

export interface DesignSection {
  id: string
  title: string
  // 小さいほど上に出す
  order: number
  fields: readonly DesignField<any>[]
  // 項目のほかに、このセクションを出すノードか（Component だけのセクション用）。項目があれば、項目で決める
  appliesTo?(node: NodeRecord): boolean
  // 項目の下に描く、そのセクション専用の UI（グラデーションの編集など、共通の部品で表せないもの）
  Component?: ComponentType<DesignSectionProps>
}

const sections: DesignSection[] = []

// セクションを登録する。同じ id があれば置き換える
export function registerDesignSection(section: DesignSection): void {
  const i = sections.findIndex((s) => s.id === section.id)
  if (i >= 0) sections[i] = section
  else sections.push(section)
  sections.sort((a, b) => a.order - b.order)
}

export function designSections(): readonly DesignSection[] {
  return sections
}

// パネルに出すセクションと項目。nodes のすべてが持つ項目だけを残し、項目が 1 つもないセクションは出さない
export interface VisibleSection {
  section: DesignSection
  fields: { field: DesignField<any>; value: SharedValue<unknown> }[]
  showComponent: boolean
}

export function visibleSections(nodes: readonly NodeRecord[], all: readonly DesignSection[] = sections): VisibleSection[] {
  if (nodes.length === 0) return []
  const result: VisibleSection[] = []
  for (const section of all) {
    const fields = section.fields
      .filter((field) => nodes.every((node) => field.appliesTo(node)))
      .map((field) => ({ field, value: sharedValue(nodes, (node) => field.read(node))! }))
    const showComponent = Boolean(section.Component && (section.appliesTo ? nodes.every((node) => section.appliesTo!(node)) : fields.length > 0))
    if (fields.length > 0 || showComponent) result.push({ section, fields, showComponent })
  }
  return result
}

// ---- 項目を作る手助け ----

// ノードの型ごとの props のキー。型によって名前が違う同じ意味の値（図形の stroke と矢印の color など）を 1 つの項目にまとめる
export type PropKeys = Readonly<Record<string, string>>

// props の値を読み書きする項目。fallback は古いレコードに値がないときに使う
export function propField<T>(options: {
  id: string
  label: string
  keys: PropKeys
  control: FieldControl
  fallback?: T
  // 型ごとの追加の条件（同じ型でも、その値を使わないノードを外すなど）
  when?: (node: NodeRecord) => boolean
}): DesignField<T> {
  const { keys, fallback, when } = options
  const keyOf = (node: NodeRecord) => keys[node.type]
  return {
    id: options.id,
    label: options.label,
    control: options.control,
    appliesTo: (node) => keyOf(node) !== undefined && (when ? when(node) : true),
    read: (node) => ((node.props as Record<string, unknown>)[keyOf(node)] ?? fallback) as T,
    write(node, value) {
      const key = keyOf(node)
      const props = node.props as Record<string, unknown>
      if (key === undefined || sameValue(props[key], value)) return node
      return { ...node, props: { ...props, [key]: value } }
    },
  }
}
