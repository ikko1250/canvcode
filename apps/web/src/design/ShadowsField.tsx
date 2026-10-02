import { sharedOf, type SharedValue } from '@canvcode/canvas'
import { defaultShadow, SHADOW_BLUR_MAX, SHADOW_OFFSET_LIMIT, SHADOW_SPREAD_LIMIT, solidPaint, type Fill, type Shadow, type ShadowType } from '@canvcode/nodes'
import { MIXED_LABEL, NumberField, type ValueEditor } from './controls.tsx'
import { PaintField } from './ColorPicker.tsx'
import { shadowRows, type FillChange, type ShadowsChange } from './sections.ts'

// 影の一覧（MAI-86。デザインパネルの「効果」。Figma の Effects）。
// - 見出しの行の＋で影を足す（末尾に、下へ 4px・ぼかし 4px・黒 25 % のドロップシャドウ）
// - 影ごとに、種類（ドロップシャドウ・内側の影）、表示の切り替え（目）、−（消す）、X・Y・ぼかし・広がり、色と不透明度（PaintField）
// - 複数を選んだとき：影の数と種類の並びが同じなら、影ごとの値を比べて違えば「混在」。数か種類が違えば、一覧の代わりに「混在」と出し、
//   ＋で既定の影 1 つに置き換える（Figma と同じ）

const TYPE_OPTIONS: { value: ShadowType; label: string }[] = [
  { value: 'drop', label: 'ドロップシャドウ' },
  { value: 'inner', label: '内側の影' },
]

type NumberKey = 'x' | 'y' | 'blur' | 'spread'
const NUMBER_FIELDS: { key: NumberKey; label: string; min: number; max: number }[] = [
  { key: 'x', label: 'X', min: -SHADOW_OFFSET_LIMIT, max: SHADOW_OFFSET_LIMIT },
  { key: 'y', label: 'Y', min: -SHADOW_OFFSET_LIMIT, max: SHADOW_OFFSET_LIMIT },
  { key: 'blur', label: 'ぼかし', min: 0, max: SHADOW_BLUR_MAX },
  { key: 'spread', label: '広がり', min: -SHADOW_SPREAD_LIMIT, max: SHADOW_SPREAD_LIMIT },
]

export function ShadowsField(props: { label: string; value: SharedValue<Shadow[]>; editor: ValueEditor<ShadowsChange>; onDone?: () => void }) {
  const { label, value, editor, onDone } = props
  const rows = shadowRows(value)
  return (
    <div className="design-shadows" data-testid="shadows-field">
      <div className="design-field design-shadows-head">
        <span className="design-label">{label}</span>
        <div className="design-control">
          {rows === null && <span className="design-mixed">{MIXED_LABEL}</span>}
          <button
            className="design-fill-toggle design-shadow-add"
            title="影を足す"
            aria-label="影を足す"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => editor.set(rows === null ? [defaultShadow()] : { op: 'add' })}
          >
            +
          </button>
        </div>
      </div>
      {rows?.map((shadows, index) => <ShadowRow key={index} index={index} shadows={shadows} editor={editor} onDone={onDone} />)}
    </div>
  )
}

function ShadowRow(props: { index: number; shadows: Shadow[]; editor: ValueEditor<ShadowsChange>; onDone?: () => void }) {
  const { index, shadows, editor, onDone } = props
  const name = `影 ${index + 1}`
  const shared = <K extends keyof Shadow>(key: K) => sharedOf(shadows.map((shadow) => shadow[key]))!
  const type = shadows[0].type
  const visible = shadows.some((shadow) => shadow.visible !== false)
  const hidden = shadows.every((shadow) => shadow.visible === false)
  const update = (patch: Partial<Shadow>): ShadowsChange => ({ op: 'update', index, patch })
  const numberEditor = (key: NumberKey): ValueEditor<number> => ({
    set: (v) => editor.set(update({ [key]: v })),
    preview: (v) => editor.preview(update({ [key]: v })),
    end: (commit) => editor.end(commit),
  })
  // 色は塗りの形（単色）で PaintField に渡す
  const colors = shared('color')
  const opacities = shared('opacity')
  const paint: SharedValue<Fill> =
    colors.kind === 'same' && opacities.kind === 'same'
      ? { kind: 'same', value: solidPaint(colors.value, opacities.value) }
      : { kind: 'mixed', values: shadows.map((shadow) => solidPaint(shadow.color, shadow.opacity)) }
  const toPatch = (change: FillChange): ShadowsChange | null => {
    if (change === null || !('change' in change)) return change?.type === 'solid' ? update({ color: change.color, opacity: change.opacity }) : null
    if (change.change === 'color') return update({ color: change.color })
    if (change.change === 'opacity') return update({ opacity: change.opacity })
    return null
  }
  const paintEditor: ValueEditor<FillChange> = {
    set: (change) => {
      const next = toPatch(change)
      if (next) editor.set(next)
    },
    preview: (change) => {
      const next = toPatch(change)
      if (next) editor.preview(next)
    },
    end: (commit) => editor.end(commit),
  }
  return (
    <div className={hidden ? 'design-shadow hidden' : 'design-shadow'} data-shadow-index={index} aria-label={name} role="group">
      <div className="design-field">
        <span className="design-label">{name}</span>
        <div className="design-control design-shadow-controls">
          <select
            className="design-select"
            aria-label={`${name}の種類`}
            value={type}
            onChange={(e) => {
              editor.set(update({ type: e.target.value as ShadowType }))
              onDone?.()
            }}
          >
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            className="design-fill-toggle"
            title={visible ? '影を隠す' : '影を表示する'}
            aria-label={visible ? '影を隠す' : '影を表示する'}
            aria-pressed={!visible}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => editor.set(update({ visible: !visible }))}
          >
            <EyeIcon open={visible} />
          </button>
          <button
            className="design-fill-toggle"
            title="影を消す"
            aria-label="影を消す"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => editor.set({ op: 'remove', index })}
          >
            −
          </button>
        </div>
      </div>
      <div className="design-corner-grid">
        {NUMBER_FIELDS.map(({ key, label, min, max }) => (
          <NumberField
            key={key}
            className="design-corner-cell design-shadow-cell"
            label={label}
            value={shared(key)}
            editor={numberEditor(key)}
            control={{ kind: 'number', min, max, step: 1 }}
            onDone={onDone}
          />
        ))}
      </div>
      <PaintField label="色" value={paint} editor={paintEditor} canOpacity canNone={false} onDone={onDone} />
    </div>
  )
}

function EyeIcon(props: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
      {props.open ? <circle cx="8" cy="8" r="2" /> : <path d="M2.5 13.5l11-11" />}
    </svg>
  )
}
