import { describe, expect, it } from 'vitest'
import { viewportOf } from './usePresence.ts'

describe('viewportOf', () => {
  it('画面に見えている範囲をワールド座標で返す', () => {
    expect(viewportOf({ x: 100, y: -50, zoom: 2 }, 800, 600)).toEqual({ x: 100, y: -50, w: 400, h: 300 })
  })
})
