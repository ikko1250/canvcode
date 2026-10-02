import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { SharedValue } from '@canvcode/canvas'
import { fontFamilyCss, fontLabel, type FontCategory, type FontOption } from '@canvcode/nodes'
import { MIXED_LABEL, type ValueEditor } from './controls.tsx'
import { FALLBACK_FONT_LABEL, canQueryLocalFonts, fontOptions, isFontMissing, loadLocalFonts } from './fontList.ts'

// フォントを選ぶ部品（MAI-75）。押すと、デザインパネルの左に別のペインを重ねて、フォントの一覧を開く（名前はそのフォントで見せる）。
// パネルの中に開くと下の項目（大きさなど）が押し下げられるので、パネルの外に浮かせる。ボタンの高さにそろえ、画面からはみ出さないよう収める。
// ペインの外を押すと閉じる（ペインは DOM ではパネルの中に置き、パネルのキーの扱い・フォーカスの扱いを受け継ぐ）
// - 上の欄で名前を絞り込める。↑↓ で動かし、Enter で選ぶ。Esc で閉じる
// - 選んだら 1 回の変更（Undo 1 回）。文字を編集中で範囲を選んでいれば、その範囲に当たる（項目の write が決める）
// - Local Font Access API が使えるブラウザでは、端末のフォントをすべて一覧に足せる
// - 選んでいるフォントがこの端末になければ（ほかの端末で選んだフォント）、ボタンと一覧に印を付け、代わりのフォントで描いていると書く

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
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<CSSProperties | null>(null)
  const current = value.kind === 'same' ? value.value : null
  const missing = current !== null && isFontMissing(current)

  const all = fontOptions(current ? [current] : [])
  const q = query.trim().toLowerCase()
  const options = q ? all.filter((option) => option.label.toLowerCase().includes(q) || option.family.toLowerCase().includes(q)) : all

  useEffect(() => {
    if (open) filterRef.current?.focus({ preventScroll: true })
  }, [open])

  // ペインの位置：デザインパネルの左に、ボタンの高さにそろえて置く。パネルのスクロール・画面の大きさの変化に付いていく
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const button = buttonRef.current
      const popup = popupRef.current
      if (!button || !popup) return
      const anchor = (button.closest('.design-panel') ?? button).getBoundingClientRect()
      const height = popup.offsetHeight
      const top = Math.max(POPUP_MARGIN, Math.min(button.getBoundingClientRect().top, window.innerHeight - height - POPUP_MARGIN))
      setPosition({ top, right: window.innerWidth - anchor.left + POPUP_GAP })
    }
    place()
    const scroller = buttonRef.current?.closest('.design-panel')
    scroller?.addEventListener('scroll', place)
    window.addEventListener('resize', place)
    return () => {
      scroller?.removeEventListener('scroll', place)
      window.removeEventListener('resize', place)
    }
  }, [open])

  // ペインとボタンの外を押したら閉じる
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (popupRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      setOpen(false)
      setQuery('')
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
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
          ref={buttonRef}
          className="design-font-button"
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={current ? (missing ? `${fontLabel(current)}（${missingNote()}）` : fontLabel(current)) : MIXED_LABEL}
          style={current ? { fontFamily: fontFamilyCss(current) } : undefined}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => (open ? close(false) : openList())}
        >
          <span className={current ? 'design-font-name' : 'design-font-name mixed'}>{current ? fontLabel(current) : MIXED_LABEL}</span>
          {missing && (
            <span className="design-font-missing-mark" aria-label="この端末にありません">
              !
            </span>
          )}
          <span className="design-font-caret" aria-hidden>
            ▾
          </span>
        </button>
        {missing && <div className="design-font-missing">{missingNote()}</div>}
        {open && (
          <div
            ref={popupRef}
            className="design-font-popup"
            role="dialog"
            aria-label={`${label}を選ぶ`}
            style={position ?? { visibility: 'hidden' }}
            onKeyDown={onKeyDown}
          >
            <div className="design-font-popup-header">{label}</div>
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

function missingNote(): string {
  return `この端末にないため、${FALLBACK_FONT_LABEL} で表示しています`
}

// ペインとデザインパネルの間、画面の縁との間（px）
const POPUP_GAP = 8
const POPUP_MARGIN = 8

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
  const missing = option.category === 'system' && isFontMissing(option.family)
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
        title={missing ? `${option.family}（${missingNote()}）` : option.family}
        onPointerDown={(e) => e.preventDefault()}
        onPointerEnter={onHover}
        onClick={onChoose}
      >
        <span className="design-font-option-name">{option.label}</span>
        {missing && <span className="design-font-option-missing">この端末にない</span>}
      </div>
    </>
  )
}
