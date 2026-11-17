import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { buttonInstruction, buttonSize, buttonType, type ButtonProps } from './button.ts'

// ボタン（押すと Claude に指示を送る）

function node(props: Partial<ButtonProps>): NodeRecord<ButtonProps> {
  return {
    id: 'node:b',
    typeName: 'node',
    type: 'button',
    canvasId: 'canvas:1',
    parentId: 'canvas:1',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a0',
    opacity: 1,
    locked: false,
    props: { ...buttonType.defaultProps(), ...props },
    meta: {},
  } as NodeRecord<ButtonProps>
}

describe('button', () => {
  it('fits its width to the label when sizing is auto, and wraps long labels at the maximum width', () => {
    const short = buttonSize(node({ label: '短く' }).props)
    const long = buttonSize(node({ label: 'もっと簡単な言葉で、初めての人にもわかるように書き直す（とても長い文字）' }).props)
    expect(short.w).toBeGreaterThanOrEqual(48)
    expect(long.w).toBeGreaterThan(short.w)
    expect(long.w).toBeLessThanOrEqual(260)
    expect(long.h).toBeGreaterThan(short.h)
  })

  it('resizing changes only the width and fixes it; the height follows the label', () => {
    const before = node({ label: 'Mac 向けにする' })
    const resized = buttonType.resize!(before, { w: 200, h: 999 })
    expect(resized).toMatchObject({ w: 200, sizing: 'fixed' })
    expect(buttonSize(resized).w).toBe(200)
    expect(buttonSize(resized).h).toBe(buttonSize(before.props).h)
    // 幅を変えなかった（高さだけ動かした）ときは、文字に合わせたまま
    expect(buttonType.resize!(before, { w: buttonSize(before.props).w, h: 10 })).toBe(before.props)
  })

  it('a button with a fixed height (the ＋ and the version bars) keeps it, also when resized, and may be narrow', () => {
    const plus = node({ label: '＋', w: 28, h: 90, sizing: 'fixed', action: 'ask-left' })
    expect(buttonSize(plus.props)).toEqual({ w: 28, h: 90 })
    const bar = node({ label: '', w: 48, h: 10, sizing: 'fixed', action: 'version', version: 0 })
    expect(buttonSize(bar.props)).toEqual({ w: 48, h: 10 })
    expect(buttonType.resize!(plus, { w: 30, h: 120 })).toMatchObject({ w: 30, h: 120, sizing: 'fixed' })
  })

  it('is pressable and edits its label on one line', () => {
    expect(buttonType.pressable).toBe(true)
    const spec = buttonType.editText!(node({ label: 'iOS 向け' }))
    expect(spec.text).toBe('iOS 向け')
    expect(spec.update('Mac\n向け').label).toBe('Mac 向け')
    expect(spec.deleteIfEmpty).toBe(false)
    // Enter で編集を終える（1 行）
    expect(spec.singleLine).toBe(true)
  })

  it('sends the prompt, or the label when the prompt is empty', () => {
    expect(buttonInstruction({ label: 'もっと簡単に', prompt: '中学生にもわかる言葉で書き直す' })).toBe('中学生にもわかる言葉で書き直す')
    expect(buttonInstruction({ label: ' もっと簡単に ', prompt: '  ' })).toBe('もっと簡単に')
  })

  it('copies point at the copied question notes, and keep the original ones that were not copied', () => {
    const b = node({ label: 'Mac', hint: true, questionIds: ['node:q1', 'node:q2'] })
    const map = new Map([['node:q1', 'node:copy1']])
    expect(buttonType.remapIds!(b, (id) => map.get(id)).questionIds).toEqual(['node:copy1', 'node:q2'])
    const plain = node({ label: 'Mac' })
    expect(buttonType.remapIds!(plain, () => undefined)).toBe(plain.props)
  })

  it('hits inside its box only', () => {
    const b = node({ label: 'Mac' })
    const { w, h } = buttonSize(b.props)
    expect(buttonType.hitTest(b, { x: w / 2, y: h / 2 }, 0, 1)).toBe(true)
    expect(buttonType.hitTest(b, { x: w + 5, y: h / 2 }, 0, 1)).toBe(false)
  })
})
