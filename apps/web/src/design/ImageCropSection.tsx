import type { NodeRecord } from '@canvcode/core'
import { editNodes, startCropEditing, uncropImage } from '@canvcode/canvas'
import type { ImageProps } from '@canvcode/nodes'
import type { DesignSectionProps } from './registry.ts'

// 画像ノードの切り抜き（トリミング）。キャンバスの上の切り抜きモード（packages/canvas の cropHandles.ts。画像のダブルクリックでも入れる）に入るボタンと、
// 切り抜きをやめる（画像全体に戻す）ボタン

export function ImageCropSection(props: DesignSectionProps) {
  const { editor, nodes } = props
  const images = nodes.filter((node): node is NodeRecord<ImageProps> => node.type === 'image')
  if (images.length !== nodes.length || images.length === 0) return null
  const cropped = images.some((node) => node.props.crop !== null)
  return (
    <div className="design-image-actions">
      {images.length === 1 && (
        <button
          title="画像の上で、見せる範囲を決める（画像のダブルクリックでも入れる。Enter・Esc で終える）"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => startCropEditing(editor, images[0].id)}
        >
          切り抜く
        </button>
      )}
      <button
        title="切り抜きをやめて、画像の全体を見せる"
        disabled={!cropped}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => {
          editor.session.set({ cropEditing: null })
          editNodes(editor, images.map((node) => node.id), (node) => (node.type === 'image' ? uncropImage(node as NodeRecord<ImageProps>) : node), 'uncrop image')
        }}
      >
        切り抜きを戻す
      </button>
    </div>
  )
}
