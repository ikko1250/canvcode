import { describe, expect, it } from 'vitest'
import { COLOR_PRESET_GROUPS, DADS_COLOR_PRESET_GROUPS } from './colorPresets.ts'

// カラーピッカーのテンプレートの色（MAI-81）と、DADS の色（MAI-114）

describe('color presets', () => {
  it('has the DADS key, neutral and semantic colors after the app colors, as #rrggbb from the design tokens', () => {
    expect(COLOR_PRESET_GROUPS.map((group) => group.name)).toEqual(['スライド', 'キャンバス', 'DADS キーカラー', 'DADS ニュートラル', 'DADS セマンティック'])
    const named = (group: number) => Object.fromEntries(DADS_COLOR_PRESET_GROUPS[group].colors.map(({ name, color }) => [name, color]))
    expect(named(0)).toEqual({
      'Blue-50': '#e8f1fe',
      'Blue-100': '#d9e6ff',
      'Blue-200': '#c5d7fb',
      'Blue-900': '#0017c1',
      'Blue-1000': '#00118f',
      'Blue-1200': '#000060',
    })
    expect(named(1)).toEqual({
      White: '#ffffff',
      'Solid Gray-50': '#f2f2f2',
      'Solid Gray-420': '#949494',
      'Solid Gray-536': '#767676',
      'Solid Gray-600': '#666666',
      'Solid Gray-800': '#333333',
      'Solid Gray-900': '#1a1a1a',
      Black: '#000000',
    })
    expect(named(2)).toEqual({
      'Success-1': '#259d63',
      'Success-2': '#197a4b',
      'Error-1': '#ec0000',
      'Error-2': '#ce0000',
      'Warning-Yellow-1': '#b78f00',
      'Warning-Yellow-2': '#927200',
      'Warning-Orange-1': '#fb5b01',
      'Warning-Orange-2': '#c74700',
    })
  })

  it('has no duplicate colors in a group (the swatches are keyed by color)', () => {
    for (const group of COLOR_PRESET_GROUPS) {
      const colors = group.colors.map(({ color }) => color.toLowerCase())
      expect(new Set(colors).size, group.name).toBe(colors.length)
    }
  })
})
