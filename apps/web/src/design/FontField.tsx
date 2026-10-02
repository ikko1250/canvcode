import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { SharedValue } from '@canvcode/canvas'
import { fontFamilyCss, fontLabel, type FontCategory, type FontOption } from '@canvcode/nodes'
import { MIXED_LABEL, type ValueEditor } from './controls.tsx'
import { canQueryLocalFonts, fontOptions, loadLocalFonts } from './fontList.ts'

// フォントを選ぶ部品（MAI-75）。押すと、パネルの中にフォントの一覧を開く（名前はそのフォントで見せる）。
// - 上の欄で名前を絞り込める。↑↓ で動かし、Enter で選ぶ。Esc で閉じる
// - 選んだら 1 回の変更（Undo 1 回）。文字を編集中で範囲を選んでいれば、その範囲に当たる（項目の write が決める）
// - Local Font Access API が使えるブラウザでは、端末のフォントをすべて一覧に足せる

const GROUP_TITLES: Record<FontCategory, string> = {
  generic: '標準',
  bundled: '同梱',
  system: 'この端末',
}

export function FontField(props: { label: string; value: SharedValue<string>; editor: ValueEditor<string>; onDone?: () => void }) {
  const { label, value, editor, onDone } = props
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  // 端末のフォントを読んだら、描き直して一覧を作り直す
  const [, setLocalVersion] = useState(0)
  const filterRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const current = value.kind === 'same' ? value.value : null

  const all = fontOptions(current ? [current] : [])
  const q = query.trim().toLowerCase()
  const options = q ? all.filter((option) => option.label.toLowerCase().includes(q) || option.family.toLowerCase().includes(q)) : all

  useEffect(() => {
    if (open) filterRef.current?.focus({ preventScroll: true })
  }, [open])

  // 選んでいる候補が見えるようにする
  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  // 開くときは、今のフォントを選んだところから
  const openList = () => {
    setActive(Math.max(0, all.findIndex((option) => option.family === current)))
    setOpen(true)
  }
  const close = (done: boolean) => {
    setOpen(false)
    setQuery('')
    if (done) onDone?.()
  }
  const choose = (option: FontOption) => {
    close(false)
    editor.set(option.family)
    onDone?.()
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close(true)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => Math.max(0, Math.min(options.length - 1, i + delta)))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const option = options[active]
      if (option) choose(option)
    }
  }

  return (
    <div className="design-field design-font-field">
      <span className="design-label">{label}</span>
      <div className="design-control">
        <button
          className="design-font-button"
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={current ? fontLabel(current) : MIXED_LABEL}
          style={current ? { fontFamily: fontFamilyCss(current) } : undefined}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => (open ? close(false) : openList())}
        >
          <span className={current ? 'design-font-name' : 'design-font-name mixed'}>{current ? fontLabel(current) : MIXED_LABEL}</span>
          <span className="design-font-caret" aria-hidden>
            ▾
          </span>
        </button>
        {open && (
          <div className="design-font-popup" onKeyDown={onKeyDown}>
            <input
              ref={filterRef}
              type="text"
              className="design-font-filter"
              aria-label={`${label}を絞り込む`}
              placeholder="フォントを探す"
              spellCheck={false}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
            />
            <div ref={listRef} className="design-font-list" role="listbox" aria-label={label}>
              {options.length === 0 && <div className="design-font-empty">見つかりません</div>}
              {options.map((option, index) => (
                <FontOptionRow
                  key={option.family}
                  option={option}
                  index={index}
                  selected={option.family === current}
                  active={index === active}
                  groupTitle={index === 0 || options[index - 1].category !== option.category ? GROUP_TITLES[option.category] : null}
                  onHover={() => setActive(index)}
                  onChoose={() => choose(option)}
                />
              ))}
            </div>
            {canQueryLocalFonts() && (
              <button
                className="design-font-local"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => void loadLocalFonts().then(() => setLocalVersion((v) => v + 1))}
              >
                端末のフォントを追加
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function FontOptionRow(props: {
  option: FontOption
  index: number
  selected: boolean
  active: boolean
  groupTitle: string | null
  onHover: () => void
  onChoose: () => void
}) {
  const { option, index, selected, active, groupTitle, onHover, onChoose } = props
  return (
    <>
      {groupTitle && <div className="design-font-group">{groupTitle}</div>}
      <div
        role="option"
        aria-selected={selected}
        data-index={index}
        data-font={option.family}
        className={['design-font-option', selected ? 'selected' : '', active ? 'active' : ''].filter(Boolean).join(' ')}
        style={{ fontFamily: fontFamilyCss(option.family) }}
        title={option.family}
        onPointerDown={(e) => e.preventDefault()}
        onPointerEnter={onHover}
        onClick={onChoose}
      >
        {option.label}
      </div>
    </>
  )
}
