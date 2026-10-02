import { useRef } from 'react'
import type { AssetRecord } from '@canvcode/core'
import type { ImagePaint, ImageScaleMode } from '@canvcode/nodes'
import { NumberField, type ValueEditor } from './controls.tsx'
import type { FillChange } from './sections.ts'

// 画像の塗りの編集（MAI-83）。塗りの項目（ColorPicker.tsx の PaintField）で種類を「画像」にしたとき、ピッカーの代わりに出す。
// - 表示のしかた：塗りつぶし（fill）・全体を収める（fit）・切り抜き（crop）・タイル（tile）
// - 切り抜きは、画像のどの範囲を図形の箱に合わせるかを数値（画像に対する %：左・上・幅・高さ）で決める。
//   図形の上でハンドルを動かす操作は作らない（Figma の切り抜きのハンドルは操作が多く、数値で足りるため）
// - タイルは、画像の元の大きさに対する倍率（%）
// - 画像の選び方：ファイルから、クリップボードから貼り付け、ワークスペースの画像の一覧から
//   （キャンバスでは、Alt を押しながら図形へドロップ・Ctrl（⌘）+Alt+V でも入れられる。packages/canvas の imageFill.ts）

// 画像を選ぶ先（DesignPanel が CanvasView から作る）
export interface PaintImageSource {
  // ワークスペースの画像の Asset
  list(): AssetRecord[]
  get(assetId: string): AssetRecord | undefined
  // 一覧・見本に見せる縮小版の URL
  url(assetId: string): string | null
  // ファイル・クリップボードの画像を Asset にする（読めなければ、知らせて null）
  importFile(file: File): Promise<AssetRecord | null>
  importClipboard(): Promise<AssetRecord | null>
}

const SCALE_MODE_OPTIONS: readonly { value: ImageScaleMode; label: string; title: string }[] = [
  { value: 'fill', label: '塗りつぶし', title: '図形を覆うように拡大・縮小する' },
  { value: 'fit', label: '収める', title: '画像の全体を図形に収める' },
  { value: 'crop', label: '切り抜き', title: '画像の一部を切り抜いて、図形に合わせる' },
  { value: 'tile', label: 'タイル', title: '画像を敷き詰める' },
]

// 一覧に出す画像の数の上限（多いワークスペースでも、パネルが重くならないように。新しいものから）
const MAX_LISTED_IMAGES = 60

export function ImagePaintEditor(props: {
  label: string
  // 選んでいるノードの画像の塗り（まだ画像を選んでいなければ空）
  paints: readonly ImagePaint[]
  images: PaintImageSource | null
  editor: ValueEditor<FillChange>
  onDone?: () => void
}) {
  const { label, paints, images, editor, onDone } = props
  const fileInput = useRef<HTMLInputElement>(null)
  const first = paints[0]
  const same = <T,>(read: (paint: ImagePaint) => T): T | null => (first && paints.every((paint) => read(paint) === read(first)) ? read(first) : null)
  const scaleMode = same((paint) => paint.scaleMode)
  const assetId = same((paint) => paint.assetId)
  const asset = assetId ? images?.get(assetId) : undefined

  const choose = (record: AssetRecord | null) => {
    if (record) editor.set({ change: 'image', assetId: record.id })
  }
  const numberEditor = (toChange: (value: number) => FillChange): ValueEditor<number> => ({
    set: (value) => editor.set(toChange(value)),
    preview: (value) => editor.preview(toChange(value)),
    end: (commit) => editor.end(commit),
  })
  const percent = (value: number) => Math.round(value * 1000) / 10
  const cropField = (key: 'x' | 'y' | 'w' | 'h', fieldLabel: string) => {
    const value = same((paint) => paint.crop[key])
    return (
      <NumberField
        key={key}
        label={fieldLabel}
        value={value === null ? { kind: 'mixed', values: paints.map((paint) => paint.crop[key]) } : { kind: 'same', value }}
        control={{ kind: 'number', min: key === 'w' || key === 'h' ? 1 : 0, max: 100, step: 0.1, unit: '%', toDisplay: percent, fromDisplay: (v) => v / 100 }}
        editor={numberEditor((v) => ({ change: 'crop', crop: { [key]: v } }))}
        onDone={onDone}
      />
    )
  }
  const tileScale = same((paint) => paint.tileScale)
  const listed = images ? images.list().slice(-MAX_LISTED_IMAGES).reverse() : []

  return (
    <div className="design-image-paint" aria-label={`${label}の画像`}>
      {paints.length > 0 && (
        <div className="design-segmented design-image-modes" role="group" aria-label="表示のしかた">
          {SCALE_MODE_OPTIONS.map((option) => {
            const active = scaleMode === option.value
            return (
              <button
                key={option.value}
                title={option.title}
                aria-pressed={active}
                className={active ? 'active' : ''}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => editor.set({ change: 'scaleMode', scaleMode: option.value, image: asset ? { width: asset.width, height: asset.height } : undefined })}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      )}
      {scaleMode === 'crop' && (
        <div className="design-image-crop">
          {cropField('x', '左')}
          {cropField('y', '上')}
          {cropField('w', '幅')}
          {cropField('h', '高さ')}
        </div>
      )}
      {scaleMode === 'tile' && (
        <NumberField
          label="倍率"
          value={tileScale === null ? { kind: 'mixed', values: paints.map((paint) => paint.tileScale) } : { kind: 'same', value: tileScale }}
          control={{ kind: 'number', min: 1, max: 10000, step: 1, unit: '%', toDisplay: (v) => Math.round(v * 1000) / 10, fromDisplay: (v) => v / 100 }}
          editor={numberEditor((v) => ({ change: 'tileScale', tileScale: v }))}
          onDone={onDone}
        />
      )}
      <div className="design-image-actions">
        <button title="画像のファイルを選ぶ" onPointerDown={(e) => e.preventDefault()} onClick={() => fileInput.current?.click()} disabled={!images}>
          ファイル…
        </button>
        <button title="クリップボードの画像を使う（キャンバスでは Ctrl+Alt+V）" onPointerDown={(e) => e.preventDefault()} onClick={() => void images?.importClipboard().then(choose)} disabled={!images}>
          貼り付け
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          aria-label={`${label}の画像のファイル`}
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file && images) void images.importFile(file).then(choose)
          }}
        />
      </div>
      {listed.length > 0 && (
        <div className="design-color-group">
          <div className="design-color-group-title">ワークスペースの画像</div>
          <div className="design-image-list" role="group" aria-label="ワークスペースの画像">
            {listed.map((record) => {
              const url = images?.url(record.id)
              const selected = record.id === assetId
              return (
                <button
                  key={record.id}
                  className={selected ? 'design-image-chip selected' : 'design-image-chip'}
                  title={`${record.width}×${record.height}`}
                  aria-label={`画像 ${record.width}×${record.height}`}
                  aria-pressed={selected}
                  data-asset-id={record.id}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => choose(record)}
                >
                  {url && <img src={url} alt="" loading="lazy" draggable={false} />}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
