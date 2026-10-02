// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { OWN_KEYS_ATTRIBUTE, isEditableKeyboardTarget } from './imeGuard.ts'

// キャンバスのショートカットに渡さないキー入力の場所（MAI-73：デザインパネルの中のキーを奪わない）

describe('editable keyboard target', () => {
  it('treats inputs and elements inside a key-owning container as editable', () => {
    const panel = document.createElement('div')
    panel.setAttribute(OWN_KEYS_ATTRIBUTE, '')
    const button = document.createElement('button')
    panel.appendChild(button)
    document.body.appendChild(panel)
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    expect(isEditableKeyboardTarget(document.createElement('input'))).toBe(true)
    expect(isEditableKeyboardTarget(button)).toBe(true)
    expect(isEditableKeyboardTarget(panel)).toBe(true)
    expect(isEditableKeyboardTarget(outside)).toBe(false)
    expect(isEditableKeyboardTarget(null)).toBe(false)
  })
})
