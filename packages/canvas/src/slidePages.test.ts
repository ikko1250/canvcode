import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { builtinNodeTypes, createSlideDeckCardType, createSlidePageType, type SlidePageProps } from '@canvcode/nodes'
import { Editor } from './editor.ts'
import { reconcileSlidePages, type SlidePageInfo } from './slidePages.ts'
import { Workspace } from './workspace.ts'

// スライドデッキの画像をキャンバスに並べる

const FILE = 'file:deck'
// カード（480×320）の右に 80 空けて、640×360 の画像を 40 間隔で横 4 枚ずつ
const slot = (index: number) => ({ x: 560 + (index % 4) * 680, y: Math.floor(index / 4) * 400 })

function setup() {
  const types = [
    ...builtinNodeTypes,
    createSlideDeckCardType({ get: () => null }),
    createSlidePageType({ load: () => Promise.reject(new Error('no images in tests')) }),
  ]
  const workspace = new Workspace({ rootCanvasId: 'canvas:root', types })
  const editor = new Editor({ workspace })
  const card = editor.makeNode('slide-deck-card', { x: 0, y: 0, props: { fileId: FILE, role: 'owner' } })
  editor.createNodes([card])
  const pages = () =>
    editor.index
      .allIds()
      .map((id) => editor.getNode(id)!)
      .filter((node): node is NodeRecord<SlidePageProps> => node.type === 'slide-page')
  const byKey = (key: string) => pages().find((page) => page.props.slideKey === key)!
  const note = (x: number, y: number) => {
    const node = editor.makeNode('geo', { x, y, props: { w: 100, h: 50 } })
    editor.createNodes([node])
    return node.id
  }
  const sync = (list: SlidePageInfo[]) => reconcileSlidePages(editor, card.id, list)
  return { editor, card, pages, byKey, note, sync }
}

const page = (key: string, hash = `hash-${key}`, ready = true): SlidePageInfo => ({ key, hash, ready })

describe('reconcileSlidePages', () => {
  it('lays the slides out beside the card, four to a row, locked', () => {
    const { pages, byKey, sync } = setup()
    expect(sync(['a', 'b', 'c', 'd', 'e'].map((key) => page(key)))).toBe(true)
    expect(pages()).toHaveLength(5)
    expect(pages().every((p) => p.locked)).toBe(true)
    expect(byKey('a')).toMatchObject({ ...slot(0), props: { hash: 'hash-a', slideIndex: 0, removed: false } })
    expect(byKey('e')).toMatchObject({ ...slot(4), props: { slideIndex: 4 } })
    // もう一度合わせても、何も変わらない
    expect(sync(['a', 'b', 'c', 'd', 'e'].map((key) => page(key)))).toBe(false)
  })

  it('moves what sits on a slide together with it when slides are reordered', () => {
    const { editor, byKey, note, sync } = setup()
    sync([page('a'), page('b'), page('c')])
    // a の上の付箋（中心が a の中）と、どの画像にも載っていない付箋
    const onA = note(slot(0).x + 100, slot(0).y + 100)
    const outside = note(-500, -500)
    const pageA = byKey('a').id
    sync([page('b'), page('c'), page('a')])
    expect(byKey('a')).toMatchObject({ id: pageA, ...slot(2), props: { slideIndex: 2 } })
    expect(byKey('b')).toMatchObject(slot(0))
    expect(editor.getNode(onA)).toMatchObject({ x: slot(2).x + 100, y: slot(2).y + 100 })
    expect(editor.getNode(outside)).toMatchObject({ x: -500, y: -500 })
  })

  it('keeps a removed slide, with what sits on it, below the grid', () => {
    const { editor, byKey, note, sync } = setup()
    sync([page('a'), page('b')])
    const onB = note(slot(1).x + 10, slot(1).y + 10)
    sync([page('a')])
    // 並び（1 行）の下に 160 空けた列
    const removedAt = { x: 560, y: 360 + 160 }
    expect(byKey('b')).toMatchObject({ ...removedAt, props: { removed: true } })
    expect(editor.getNode(onB)).toMatchObject({ x: removedAt.x + 10, y: removedAt.y + 10 })
    // スライドが戻れば（エディタで Undo して保存したなど）、並びに戻す
    sync([page('a'), page('b')])
    expect(byKey('b')).toMatchObject({ ...slot(1), props: { removed: false } })
    expect(editor.getNode(onB)).toMatchObject({ x: slot(1).x + 10, y: slot(1).y + 10 })
  })

  it('keeps showing the previous image until the new one is ready', () => {
    const { byKey, sync } = setup()
    sync([page('a', 'old')])
    sync([page('a', 'new', false)])
    expect(byKey('a').props.hash).toBe('old')
    sync([page('a', 'new', true)])
    expect(byKey('a').props.hash).toBe('new')
    // まだ一度も画像が無いスライドは空
    sync([page('a', 'new'), page('b', 'b1', false)])
    expect(byKey('b').props.hash).toBe('')
  })

  it('hands a positional page over to the id the slide gets later', () => {
    const { pages, byKey, sync } = setup()
    sync([page('@0'), page('@1')])
    const first = byKey('@0').id
    sync([page('s-aaaaaa'), page('s-bbbbbb')])
    expect(pages()).toHaveLength(2)
    expect(byKey('s-aaaaaa')).toMatchObject({ id: first, props: { removed: false } })
  })

  it('does not put the layout into the undo history', () => {
    const { editor, pages, sync } = setup()
    sync([page('a')])
    // Undo で戻るのは、カードを置いた操作だけ
    expect(editor.undo()).toBe(true)
    expect(pages()).toHaveLength(1)
  })
})
