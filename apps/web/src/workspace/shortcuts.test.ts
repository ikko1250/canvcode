import { describe, expect, it } from 'vitest'
import { isClaudePanelKey, isParentCanvasKey } from './shortcuts.ts'

const key = (key: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

describe('isParentCanvasKey', () => {
  it('U だけを押したときに親キャンバスに戻る', () => {
    expect(isParentCanvasKey(key('u'))).toBe(true)
    // CapsLock
    expect(isParentCanvasKey(key('U'))).toBe(true)
  })

  it('修飾キーを押していれば別のキーとして扱う', () => {
    expect(isParentCanvasKey(key('u', { ctrlKey: true }))).toBe(false)
    expect(isParentCanvasKey(key('u', { metaKey: true }))).toBe(false)
    expect(isParentCanvasKey(key('u', { altKey: true }))).toBe(false)
    expect(isParentCanvasKey(key('U', { shiftKey: true }))).toBe(false)
  })

  it('ほかのキーでは戻らない', () => {
    expect(isParentCanvasKey(key('i'))).toBe(false)
    expect(isParentCanvasKey(key('Escape'))).toBe(false)
    expect(isParentCanvasKey(key('Backspace'))).toBe(false)
  })
})

describe('isClaudePanelKey', () => {
  it('C だけを押したときに Claude のパネルを開く', () => {
    expect(isClaudePanelKey(key('c'))).toBe(true)
    // CapsLock
    expect(isClaudePanelKey(key('C'))).toBe(true)
  })

  it('修飾キーを押していれば別のキーとして扱う（Ctrl+C はコピー）', () => {
    expect(isClaudePanelKey(key('c', { ctrlKey: true }))).toBe(false)
    expect(isClaudePanelKey(key('c', { metaKey: true }))).toBe(false)
    expect(isClaudePanelKey(key('c', { altKey: true }))).toBe(false)
    expect(isClaudePanelKey(key('C', { shiftKey: true }))).toBe(false)
  })

  it('ほかのキーでは開かない', () => {
    expect(isClaudePanelKey(key('u'))).toBe(false)
    expect(isClaudePanelKey(key('Escape'))).toBe(false)
  })
})
