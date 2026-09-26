import { useEffect, useLayoutEffect, useState } from 'react'
import { slideKey, type FigureSlot, type SlideData } from '@canvcode/slides'

// フレームを入れるスライドの図の欄を選ぶ（提案 B。「o」メニューの「スライドの図にする…」）。
// デッキ → スライドと欄の順に選ぶ。図を置けるのは表のスライド（table・table-image）と 2 図のスライド（table-images）

export interface FigureTarget {
  deckId: string
  slideKey: string
  slot: FigureSlot
  // 置き換える前の図（あれば、確かめるときに見せる）
  replacing: string | null
}

interface DeckSummary {
  file: string
  title: string
}

interface SlotChoice {
  slot: FigureSlot
  label: string
  current: string | null
}

// スライドに置ける図の欄
function figureSlotsOf(slide: SlideData): SlotChoice[] {
  const layout = slide.layout ?? 'table'
  if (layout === 'table') return [{ slot: 'image', label: '図', current: null }]
  if (layout === 'table-image') {
    return [{ slot: 'image', label: slide.code ? '図（コードと置き換え）' : '図', current: slide.image?.path ?? null }]
  }
  if (layout === 'table-images') {
    return [
      { slot: 'images.0', label: '左の図', current: slide.images?.[0]?.path ?? null },
      { slot: 'images.1', label: '右の図', current: slide.images?.[1]?.path ?? null },
    ]
  }
  return []
}

export function FigureTargetDialog(props: { frameName: string; onChoose(target: FigureTarget | null): void }) {
  const { onChoose } = props
  const [decks, setDecks] = useState<DeckSummary[] | null>(null)
  const [deckId, setDeckId] = useState<string | null>(null)
  // 読んだデッキのスライド（選び直したデッキのものでなければ、まだ読んでいる途中）
  const [loaded, setLoaded] = useState<{ deckId: string; slides: SlideData[] } | null>(null)
  const slides = loaded && loaded.deckId === deckId ? loaded.slides : null
  const [error, setError] = useState<string | null>(null)

  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onChoose(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onChoose])

  useEffect(() => {
    let cancelled = false
    void fetch('/api/slides')
      .then(async (response) => {
        if (!response.ok) throw new Error(`デッキの一覧を読めません（${response.status}）`)
        const body = (await response.json()) as { decks: DeckSummary[] }
        if (cancelled) return
        const sorted = [...body.decks].sort((a, b) => a.title.localeCompare(b.title))
        setDecks(sorted)
        if (sorted.length === 1) setDeckId(sorted[0].file)
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!deckId) return
    let cancelled = false
    void fetch(`/api/slides/${encodeURIComponent(deckId)}`)
      .then(async (response) => {
        const body = (await response.json()) as { deck?: { slides: SlideData[] }; error?: string }
        if (cancelled) return
        if (!body.deck) throw new Error(`デッキを読めません：${body.error ?? response.status}`)
        setLoaded({ deckId, slides: body.deck.slides })
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [deckId])

  return (
    <div className="dialog-backdrop" onPointerDown={() => onChoose(null)}>
      <div className="dialog figure-target" role="dialog" aria-label="スライドの図にする" onPointerDown={(e) => e.stopPropagation()}>
        <h2>「{props.frameName}」をスライドの図にする</h2>
        {error && <p className="figure-target-error">{error}</p>}
        {!error && decks === null && <p>読み込み中…</p>}
        {decks !== null && decks.length === 0 && <p>スライドデッキがありません。パイメニューの Portal › スライドから作れます。</p>}
        {decks !== null && decks.length > 0 && (
          <label className="figure-target-deck">
            デッキ
            <select value={deckId ?? ''} onChange={(e) => setDeckId(e.currentTarget.value || null)}>
              <option value="">選んでください</option>
              {decks.map((deck) => (
                <option key={deck.file} value={deck.file}>
                  {deck.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {deckId && slides === null && !error && <p>読み込み中…</p>}
        {deckId && slides && (
          <ol className="figure-target-slides">
            {slides.map((slide, index) => {
              const slots = figureSlotsOf(slide)
              return (
                <li key={slideKey(slide, index)} className={slots.length === 0 ? 'disabled' : ''}>
                  <span className="figure-target-title">
                    {index + 1}. {slide.title}
                  </span>
                  {slots.length === 0 ? (
                    <span className="figure-target-note">図を置けません</span>
                  ) : (
                    slots.map((choice) => (
                      <button
                        key={choice.slot}
                        title={choice.current ? `今の図：${choice.current}` : undefined}
                        onClick={() => onChoose({ deckId, slideKey: slideKey(slide, index), slot: choice.slot, replacing: choice.current })}
                      >
                        {choice.label}
                      </button>
                    ))
                  )}
                </li>
              )
            })}
          </ol>
        )}
        <div className="dialog-buttons">
          <button onClick={() => onChoose(null)}>やめる</button>
        </div>
      </div>
    </div>
  )
}
