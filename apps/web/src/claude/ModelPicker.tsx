import { useEffect, useRef, useState } from 'react'
import type { ModelCatalog } from './claudeClient.ts'
import { EFFORT_LABELS, effortsOf, modelLabel, settingLabel, settingOf, withModel, type ModelSetting } from './modelChoice.ts'

// 送るボタンの横の「Opus 5.5 · High」（MAI-106）。押すと、モデルと effort を選ぶ欄が上に開く。
// 選んだ値は次に送るときから使う。欄の外を押すか Esc で閉じる（Esc はパネルを閉じない）
export function ModelPicker(props: { catalog: ModelCatalog | undefined; setting: ModelSetting; onChange(setting: ModelSetting): void }) {
  const { catalog, setting, onChange } = props
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !rootRef.current?.contains(e.target)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [open])

  const efforts = effortsOf(catalog, setting.model)
  // 一覧にないモデル（前の会話で使った古いモデルなど）も、選んでいるなら出す
  const unlisted = setting.model && !catalog?.models.some((choice) => choice.value === setting.model) ? setting.model : null

  return (
    <div
      className="claude-model"
      ref={rootRef}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return
        e.preventDefault()
        setOpen(false)
        buttonRef.current?.focus()
      }}
    >
      <button
        type="button"
        ref={buttonRef}
        className="claude-model-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title="モデルと effort を選ぶ（次に送るときから、この会話で使う）"
      >
        {settingLabel(catalog, setting)}
      </button>
      {open && (
        <div className="claude-model-popover" role="dialog" aria-label="モデルと effort">
          <label>
            <span>モデル</span>
            <select value={setting.model ?? ''} onChange={(e) => onChange(withModel(catalog, setting, e.target.value || undefined))}>
              <option value="">{modelLabel(catalog, undefined)}</option>
              {catalog?.models.map((choice) => (
                <option key={choice.value} value={choice.value} title={choice.description}>
                  {choice.label}
                </option>
              ))}
              {unlisted && <option value={unlisted}>{unlisted}</option>}
            </select>
          </label>
          <label>
            <span>effort</span>
            <select
              value={setting.effort ?? ''}
              disabled={efforts.length === 0}
              onChange={(e) => onChange(settingOf({ model: setting.model, effort: efforts.find((effort) => effort === e.target.value) }))}
            >
              <option value="">{efforts.length === 0 ? 'なし' : '既定'}</option>
              {efforts.map((effort) => (
                <option key={effort} value={effort}>
                  {EFFORT_LABELS[effort]}
                </option>
              ))}
            </select>
          </label>
          {!catalog && <p className="claude-model-note">モデルの一覧を読み込んでいます…</p>}
          {catalog && !catalog.fromClaude && <p className="claude-model-note">Claude Code にモデルの一覧を聞けなかったので、主なものだけを出しています</p>}
        </div>
      )}
    </div>
  )
}
