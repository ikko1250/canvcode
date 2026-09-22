import { describe, expect, it } from 'vitest'
import { renamedTitle } from './rename.ts'

describe('renamedTitle', () => {
  it('前後の空白を落とした名前を返す', () => {
    expect(renamedTitle('  設計メモ ', 'ホーム')).toBe('設計メモ')
  })

  it('空や空白だけなら名前を変えない', () => {
    expect(renamedTitle('', 'ホーム')).toBeNull()
    expect(renamedTitle(' \t　', 'ホーム')).toBeNull()
  })

  it('元の名前と同じなら名前を変えない', () => {
    expect(renamedTitle('ホーム', 'ホーム')).toBeNull()
    expect(renamedTitle(' ホーム ', 'ホーム')).toBeNull()
  })
})
