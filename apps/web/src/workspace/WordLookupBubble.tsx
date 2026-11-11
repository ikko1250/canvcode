import { useEffect, useRef } from 'react'
import { lookupHeading, type LookupResult } from '../claude/lookup.ts'

// 調べた語の吹き出し（o メニューの「単語を調べる」。MAI-99）。PDF のページの上で選んだ所のすぐ下（下に場所がなければ上）に出す。
// 待っている間は「調べています」、答えが来たら意味と、読み方・品詞（あれば）、「ノートとして置く」を出す。
// ×・Esc・吹き出しの外を押すと閉じる（待っている頼みもやめる）
export type WordLookupState =
  | { status: 'loading'; phrase: string }
  | { status: 'done'; phrase: string; result: LookupResult }
  | { status: 'error'; phrase: string; error: string }

const WIDTH = 320
// 下に出すのに要る高さのめやす（これより下に場所がなければ、上に出す）
const ROOM_BELOW = 200
const GAP = 8

export function WordLookupBubble(props: {
  state: WordLookupState
  anchor: { left: number; top: number; right: number; bottom: number }
  onPlaceNote(): void
  onRetry(): void
  onClose(): void
}) {
  const { state, anchor } = props
  const ref = useRef<HTMLDivElement>(null)
  const onClose = props.onClose
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return
      if (e instanceof PointerEvent && ref.current?.contains(e.target as Node)) return
      onClose()
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', close, true)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', close, true)
    }
  }, [onClose])
  const below = anchor.bottom + GAP + ROOM_BELOW <= window.innerHeight || anchor.top - GAP - ROOM_BELOW < 0
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - WIDTH - 8))
  const style = below
    ? { left, top: Math.max(8, anchor.bottom + GAP), width: WIDTH }
    : { left, bottom: Math.max(8, window.innerHeight - anchor.top + GAP), width: WIDTH }
  const heading = state.status === 'done' ? lookupHeading(state.result) : ''
  return (
    <div ref={ref} className="word-lookup" role="dialog" aria-label="単語を調べる" style={style} onContextMenu={(e) => e.preventDefault()}>
      <div className="word-lookup-head">
        <strong className="word-lookup-phrase">{state.phrase}</strong>
        <button className="word-lookup-close" title="閉じる（Esc）" aria-label="閉じる" onClick={props.onClose}>
          ×
        </button>
      </div>
      {state.status === 'loading' && (
        <p className="word-lookup-status" role="status">
          調べています…
        </p>
      )}
      {state.status === 'error' && (
        <>
          <p className="word-lookup-error" role="alert">
            {state.error}
          </p>
          <div className="word-lookup-actions">
            <button onClick={props.onRetry}>もう一度</button>
          </div>
        </>
      )}
      {state.status === 'done' && (
        <>
          {heading && <p className="word-lookup-heading">{heading}</p>}
          <p className="word-lookup-meaning">{state.result.meaning}</p>
          <div className="word-lookup-actions">
            <button onClick={props.onPlaceNote}>ノートとして置く</button>
          </div>
        </>
      )}
    </div>
  )
}
