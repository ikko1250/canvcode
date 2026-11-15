import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { ModelCatalog } from './claudeClient.ts'
import {
  EFFORT_LABELS,
  FAMILY_LABELS,
  effortsOf,
  modelGroups,
  modelLabel,
  modelStopIndex,
  modelStops,
  settingLabel,
  settingOf,
  withModel,
  type ModelSetting,
} from './modelChoice.ts'

// 送るボタンの横の「Opus 5.5 · High」（MAI-106）。押すと、モデルと effort を選ぶ欄が上に開く。
// - 欄は 2 本のスライダー。Model は Haiku・Sonnet・Opus・Fable のそれぞれの最新版の 4 段、Effort はそのモデルで選べる段。
//   段の点を押すか、つまみを引いて選ぶ（キーは ←→・Home・End）。左端の名前と、選んでいるものの名前（太字）を添える
// - 「Model ›」を押すと、全部のバージョンの一覧に替わる（古いバージョンと「既定」はここで選ぶ）。選ぶか「‹ Model」で戻る
// 選んだ値は次に送るときから使う。欄の外を押すか Esc で閉じる（一覧なら Esc でまずスライダーに戻る。Esc はパネルを閉じない）
export function ModelPicker(props: { catalog: ModelCatalog | undefined; setting: ModelSetting; onChange(setting: ModelSetting): void }) {
  const { catalog, setting, onChange } = props
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'sliders' | 'list'>('sliders')
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const modelNameRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // 見せ方を替えたあとにフォーカスを移す先（一覧を開いたら選んでいる行、戻ったら「Model ›」）
  const focusAfterSwitch = useRef(false)

  const close = () => {
    setOpen(false)
    setView('sliders')
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !rootRef.current?.contains(e.target)) close()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [open])

  useEffect(() => {
    if (!focusAfterSwitch.current) return
    focusAfterSwitch.current = false
    if (view === 'list') listRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
    else modelNameRef.current?.focus()
  }, [view])

  const switchView = (next: 'sliders' | 'list') => {
    focusAfterSwitch.current = true
    setView(next)
  }

  const stops = modelStops(catalog)
  const modelIndex = modelStopIndex(catalog, stops, setting.model)
  const efforts = effortsOf(catalog, setting.model)
  const effortIndex = setting.effort ? efforts.indexOf(setting.effort) : -1

  return (
    <div
      className="claude-model"
      ref={rootRef}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return
        e.preventDefault()
        if (view === 'list') {
          switchView('sliders')
          return
        }
        close()
        buttonRef.current?.focus()
      }}
    >
      <button
        type="button"
        ref={buttonRef}
        className="claude-model-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        title="モデルと effort を選ぶ（次に送るときから、この会話で使う）"
      >
        {settingLabel(catalog, setting)}
      </button>
      {open && (
        <div className="claude-model-popover" role="dialog" aria-label="モデルと effort">
          {view === 'sliders' ? (
            <>
              <div className="claude-model-row claude-model-row-top">
                <button
                  type="button"
                  ref={modelNameRef}
                  className="claude-model-name claude-model-more"
                  onClick={() => switchView('list')}
                  title="全部のバージョンから選ぶ"
                  aria-label="Model（全部のバージョンから選ぶ）"
                >
                  Model ›
                </button>
                <StopSlider
                  label="Model"
                  stops={stops.map((stop) => FAMILY_LABELS[stop.family])}
                  index={modelIndex}
                  selectedLabel={modelLabel(catalog, setting.model)}
                  labels="top"
                  onSelect={(index) => onChange(withModel(catalog, setting, stops[index]?.value))}
                />
              </div>
              <div className="claude-model-row claude-model-row-bottom">
                <span className="claude-model-name">Effort</span>
                <StopSlider
                  label="Effort"
                  stops={efforts.map((effort) => EFFORT_LABELS[effort])}
                  index={effortIndex}
                  selectedLabel={efforts.length === 0 ? 'なし' : setting.effort ? EFFORT_LABELS[setting.effort] : '既定'}
                  labels="bottom"
                  disabled={efforts.length === 0}
                  onSelect={(index) => onChange(settingOf({ model: setting.model, effort: efforts[index] }))}
                />
              </div>
              {(setting.model || setting.effort) && (
                <button type="button" className="claude-model-reset" onClick={() => onChange({})} title="モデルも effort も、ワークスペースの設定に従う">
                  既定に戻す
                </button>
              )}
              {!catalog && <p className="claude-model-note">モデルの一覧を読み込んでいます…</p>}
              {catalog && !catalog.fromClaude && <p className="claude-model-note">Claude Code にモデルの一覧を聞けなかったので、主なものだけを出しています</p>}
            </>
          ) : (
            <>
              <button type="button" className="claude-model-name claude-model-back" onClick={() => switchView('sliders')} aria-label="スライダーに戻る">
                ‹ Model
              </button>
              <div className="claude-model-list" role="radiogroup" aria-label="モデル（全部のバージョン）" ref={listRef}>
                <ModelOption
                  label={modelLabel(catalog, undefined)}
                  description="ワークスペースの設定のモデル"
                  checked={!setting.model}
                  onChoose={() => {
                    onChange(withModel(catalog, setting, undefined))
                    switchView('sliders')
                  }}
                />
                {modelGroups(catalog, setting.model).map((group) => (
                  <div className="claude-model-group" key={group[0]?.value}>
                    {group.map((choice) => (
                      <ModelOption
                        key={choice.value}
                        label={choice.label}
                        description={choice.description}
                        checked={setting.model === choice.value}
                        onChoose={() => {
                          onChange(withModel(catalog, setting, choice.value))
                          switchView('sliders')
                        }}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function ModelOption(props: { label: string; description?: string; checked: boolean; onChoose(): void }) {
  return (
    <button type="button" role="radio" aria-checked={props.checked} className="claude-model-option" onClick={props.onChoose} title={props.description}>
      <span className="claude-model-option-label">{props.label}</span>
      {props.description && <span className="claude-model-option-description">{props.description}</span>}
    </button>
  )
}

// つまみの幅（CSS の .claude-stops-knob と同じ）。段の中心は、両端からつまみの半分だけ内側に等しく並べる
const KNOB_WIDTH = 34

function stopAt(index: number, count: number): number {
  return count <= 1 ? 0 : index / (count - 1)
}

// 段のあるスライダー。index は選んでいる段（-1 ならつまみを出さない：既定など）。
// labels の側に、左端の段の名前と、選んでいるものの名前（太字。つまみの上か下。はみ出さないように寄せる）を出す
function StopSlider(props: {
  label: string
  stops: readonly string[]
  index: number
  selectedLabel: string
  labels: 'top' | 'bottom'
  disabled?: boolean
  onSelect(index: number): void
}) {
  const { label, stops, index, selectedLabel, labels, disabled = false, onSelect } = props
  const count = stops.length
  const trackRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef<HTMLSpanElement>(null)
  const selectedRef = useRef<HTMLSpanElement>(null)
  // 引いている間に最後に選んだ段（同じ段では何度も選ばない）
  const dragged = useRef(-1)

  // 選んでいるものの名前を、つまみの真上（下）に置き、端からはみ出すなら内側に寄せる。左端の名前と重なるなら、左端の名前を隠す
  useLayoutEffect(() => {
    const row = rowRef.current
    const selected = selectedRef.current
    if (!row || !selected) return
    const width = row.clientWidth
    const center = index < 0 ? width : KNOB_WIDTH / 2 + (width - KNOB_WIDTH) * stopAt(index, count)
    const left = Math.max(0, Math.min(width - selected.offsetWidth, center - selected.offsetWidth / 2))
    selected.style.left = `${left}px`
    const first = firstRef.current
    if (first) first.style.visibility = left < first.offsetWidth + 6 ? 'hidden' : ''
  })

  const nearest = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || count <= 1) return 0
    const t = (clientX - rect.left - KNOB_WIDTH / 2) / Math.max(1, rect.width - KNOB_WIDTH)
    return Math.max(0, Math.min(count - 1, Math.round(t * (count - 1))))
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || count === 0 || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragged.current = nearest(e.clientX)
    onSelect(dragged.current)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    const next = nearest(e.clientX)
    if (next === dragged.current) return
    dragged.current = next
    onSelect(next)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || count === 0) return
    let next: number
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = index < 0 ? 0 : Math.max(0, index - 1)
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = index < 0 ? 0 : Math.min(count - 1, index + 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = count - 1
    else return
    e.preventDefault()
    if (next !== index) onSelect(next)
  }

  const labelRow = (
    <div className="claude-stops-labels" ref={rowRef} aria-hidden="true">
      {count > 0 && index !== 0 && (
        <span className="claude-stops-label" ref={firstRef}>
          {stops[0]}
        </span>
      )}
      <span className="claude-stops-label claude-stops-selected" ref={selectedRef}>
        {selectedLabel}
      </span>
    </div>
  )

  return (
    <div className="claude-stops">
      {labels === 'top' && labelRow}
      <div
        ref={trackRef}
        className="claude-stops-track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-disabled={disabled || undefined}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, count - 1)}
        aria-valuenow={index >= 0 ? index : undefined}
        aria-valuetext={selectedLabel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onKeyDown={onKeyDown}
      >
        {stops.map((stop, i) => (
          <span key={stop} className="claude-stops-dot" style={{ '--t': stopAt(i, count) } as CSSProperties} />
        ))}
        {index >= 0 && <span className="claude-stops-knob" style={{ '--t': stopAt(index, count) } as CSSProperties} />}
      </div>
      {labels === 'bottom' && labelRow}
    </div>
  )
}
