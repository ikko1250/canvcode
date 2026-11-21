import { describe, expect, it } from 'vitest'
import { withDraft } from './promptDraft.ts'

const TABLE = 'この表（CSV）の中身に合うグラフを作って。'
const IMAGE = 'このグラフを、元の表（CSV）の中身に合わせて描き直して。'

describe('withDraft', () => {
  it('puts the draft into an empty prompt box', () => {
    expect(withDraft('', TABLE, [])).toBe(TABLE)
    expect(withDraft(' \n', TABLE, [])).toBe(TABLE)
  })

  it('adds the draft after what was written, with a blank line between', () => {
    expect(withDraft('先に書いた文', TABLE, [])).toBe(`先に書いた文\n\n${TABLE}`)
    expect(withDraft('先に書いた文\n\n', TABLE, [])).toBe(`先に書いた文\n\n${TABLE}`)
  })

  it('does not add the same draft twice', () => {
    expect(withDraft(`先に書いた文\n\n${TABLE}`, TABLE, [TABLE])).toBe(`先に書いた文\n\n${TABLE}`)
  })

  it('replaces a draft put in before and left as it was, but keeps one that was written into', () => {
    expect(withDraft(TABLE, IMAGE, [TABLE])).toBe(IMAGE)
    expect(withDraft(`  ${TABLE}\n`, IMAGE, [TABLE])).toBe(IMAGE)
    expect(withDraft(`${TABLE}列は「値」で。`, IMAGE, [TABLE])).toBe(`${TABLE}列は「値」で。\n\n${IMAGE}`)
    // 手で書いた文が、まだ入れていない下書きと同じでも、置き換えない
    expect(withDraft(TABLE, IMAGE, [])).toBe(`${TABLE}\n\n${IMAGE}`)
  })
})
