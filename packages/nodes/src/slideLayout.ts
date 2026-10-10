import type { NodeRecord } from '@canvcode/core'
import { defineNodeType } from './defineNodeType.ts'

// スライドの中身を並べ直すための入れ物（スライド v2）。スライドの子として 1 つ置き、スライドと同じ大きさ（左上 0,0）にする。
// テンプレート（表紙・箇条書き・表・表＋画像・表＋2画像）が並べた子（文字・矩形・画像）の役割を、子の id で slots に持つ。
// 自分は何も描かず、当たらない。子はスライドの直下の子と同じように選べる（container: 'layout'）。
// slots の id の子が消されていても壊さない（並べ直すときに無視する）

export type SlideLayoutKind = 'title' | 'bullets' | 'table' | 'table-image' | 'table-images'

// 行。table / table-image / table-images は見出し（label）と本文（body）、bullets は本文だけ。
// h は手で決めた行の高さ（セルの下端のリサイズで書く。足しただけの省略できる値なので版は上げない）。無ければ内容から自動で決める
export interface SlideLayoutRow {
  label?: string
  body: string
  h?: number
}

// 並べる子の役割（子の id）。rows の並びが行の順
export interface SlideLayoutSlots {
  title?: string
  subtitle?: string
  credits?: string
  panel?: string
  // figure は table-image の右の図の枠・table-images の下の左の図の枠。figure2 は table-images の下の右の図の枠
  figure?: string
  figure2?: string
  rows: SlideLayoutRow[]
}

export interface SlideLayoutProps {
  layout: SlideLayoutKind
  w: number
  h: number
  slots: SlideLayoutSlots
  // 手で直した配置（デザインパネルの「配置」、表パネル・右図枠のドラッグとリサイズで書く）。足しただけの省略できる値なので版は上げない
  adjust?: SlideLayoutAdjust
}

// 手で直した配置。値はスライドの幾何の単位（16:9 の 1920 幅の px。4:3 では横を縮めて使う）。
// table は表パネル（中の行を含む）のずらす量と、table-image の左表パネルの幅（w）。figure は table-image の右図枠のずらす量。
// 0 や無い値は既定の配置
export interface SlideLayoutAdjust {
  table?: { dx?: number; dy?: number; w?: number }
  figure?: { dx?: number; dy?: number }
}

// 壊れたデータ（数でない値・NaN など）を捨てて読む。0 の値と空になった組は省く
export function adjustOf(value: unknown): SlideLayoutAdjust {
  const v = (value ?? {}) as Record<string, unknown>
  const pick = (group: unknown, keys: readonly string[]): Record<string, number> | undefined => {
    if (!group || typeof group !== 'object') return undefined
    const out: Record<string, number> = {}
    for (const key of keys) {
      const n = (group as Record<string, unknown>)[key]
      if (typeof n === 'number' && Number.isFinite(n) && n !== 0) out[key] = n
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
  const table = pick(v.table, ['dx', 'dy', 'w'])
  const figure = pick(v.figure, ['dx', 'dy'])
  return { ...(table ? { table } : {}), ...(figure ? { figure } : {}) }
}

export type SlideLayoutNode = NodeRecord<SlideLayoutProps>

const SINGLE_SLOTS = ['title', 'subtitle', 'credits', 'panel', 'figure', 'figure2'] as const

// 壊れたデータ（rows が配列でない、id が文字列でないなど）も読める形にする
export function slotsOf(value: unknown): SlideLayoutSlots {
  const v = (value ?? {}) as Record<string, unknown>
  const slots: SlideLayoutSlots = { rows: [] }
  for (const key of SINGLE_SLOTS) {
    const id = v[key]
    if (typeof id === 'string') slots[key] = id
  }
  if (Array.isArray(v.rows)) {
    for (const row of v.rows as unknown[]) {
      const r = (row ?? {}) as Record<string, unknown>
      slots.rows.push({
        ...(typeof r.label === 'string' ? { label: r.label } : {}),
        body: typeof r.body === 'string' ? r.body : '',
        ...(rowHeightOf(r.h) !== undefined ? { h: r.h as number } : {}),
      })
    }
  }
  return slots
}

// 手で決めた行の高さ。正の有限の数でなければ（壊れた値も）無い（自動）とする
export function rowHeightOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

// slots に入っている子の id（並べる順。空の id は除く）
export function slotIds(slots: SlideLayoutSlots): string[] {
  const ids: string[] = []
  for (const key of SINGLE_SLOTS) {
    const id = slots[key]
    if (id) ids.push(id)
  }
  for (const row of slots.rows) {
    if (row.label) ids.push(row.label)
    if (row.body) ids.push(row.body)
  }
  return ids
}

// slots の id を map で写し替える。map で引けない id は外す（行の本文は空の id にして、行の並びを保つ）。
// 行の高さ（h）は行についていく（複製・貼り付けでも同じ高さ）
export function remapSlots(slots: SlideLayoutSlots, map: (id: string) => string | undefined): SlideLayoutSlots {
  const out: SlideLayoutSlots = { rows: [] }
  for (const key of SINGLE_SLOTS) {
    const from = slots[key]
    const id = from ? map(from) : undefined
    if (id) out[key] = id
  }
  for (const row of slots.rows) {
    const label = row.label ? map(row.label) : undefined
    out.rows.push({ ...(label ? { label } : {}), body: (row.body && map(row.body)) || '', ...(row.h !== undefined ? { h: row.h } : {}) })
  }
  return out
}

export const slideLayoutType = defineNodeType<SlideLayoutProps>({
  type: 'slide-layout',
  version: 1,

  defaultProps: () => ({ layout: 'title', w: 1920, h: 1080, slots: { rows: [] } }),

  getBounds: (node) => ({ x: 0, y: 0, w: node.props.w, h: node.props.h }),

  // 自分には当たらない（中の子だけが当たる）
  hitTest: () => false,

  // 何も描かない（並べた子が描く）
  render() {},
  renderRough() {},

  // resize を定義しないので、リサイズできない。回転もせず、矢印もつながない
  canRotate: false,
  canBind: false,
  container: 'layout',

  // 複製・貼り付けで、slots を新しい id に写す
  remapIds: (node, map) => ({ ...node.props, slots: remapSlots(slotsOf(node.props.slots), map) }),

  // 子が出ていったら、slots から外す
  releaseChild: (node, childId) => ({
    ...node.props,
    slots: remapSlots(slotsOf(node.props.slots), (id) => (id === childId ? undefined : id)),
  }),
})
