import { describe, expect, it } from 'vitest'
import { SOURCE_LINK_PREFIX } from '@canvcode/nodes'
import { linkHintText } from './linkHint.ts'

// カードのリンクの上に出す札の文言

describe('linkHintText', () => {
  it('shows the URL and how to open a web link', () => {
    expect(linkHintText('https://example.com/a?b=1', false)).toEqual({ target: 'https://example.com/a?b=1', action: 'Ctrl+クリックで開く' })
  })

  it('uses ⌘ on Mac', () => {
    expect(linkHintText('http://example.com/', true)).toEqual({ target: 'http://example.com/', action: '⌘+クリックで開く' })
  })

  it('shows only the address of a mailto link', () => {
    expect(linkHintText('mailto:someone@example.com', false)).toEqual({ target: 'someone@example.com', action: 'Ctrl+クリックで開く' })
  })

  it('describes the source band of a quote note', () => {
    expect(linkHintText(`${SOURCE_LINK_PREFIX}anchor-1`, false)).toEqual({ target: '出典', action: 'Ctrl+クリックで出典へ移る' })
  })

  it('says a link it cannot open cannot be opened', () => {
    expect(linkHintText('javascript:alert(1)', false)).toEqual({ target: 'javascript:alert(1)', action: 'このリンクは開けません' })
    expect(linkHintText('notes/a.md', false)).toEqual({ target: 'notes/a.md', action: 'このリンクは開けません' })
  })
})
