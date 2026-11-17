import type { NodeRecord } from '@canvcode/core'
import { editNodes } from '@canvcode/canvas'
import type { ButtonProps } from '@canvcode/nodes'
import { useDraft } from './useDraft.ts'
import type { DesignSectionProps } from './registry.ts'

// ボタン（押すと Claude に指示を送る）の、出す文字と、押したときに送る指示。1 つだけ選んでいるときに変えられる（いくつも選んでいれば、そう知らせる）。
// どちらも、Enter（指示は Ctrl+Enter）かフォーカスを外したときに確かめ、Esc でやめる。キャンバスで文字を編集中なら、その編集を終えてから変える
// （編集中は、ほかのトランザクションを開けない）。それでも変えられなければ、打った文字を残す

export function ButtonSection(props: DesignSectionProps) {
  const { editor, nodes, textEditor } = props
  const button = nodes.length === 1 && nodes[0].type === 'button' ? (nodes[0] as NodeRecord<ButtonProps>) : null
  const label = useDraft()
  const prompt = useDraft()
  if (!button) return <p className="design-button-hint">ボタンを 1 つだけ選ぶと、出す文字と押したときの指示を変えられます。</p>
  const commit = (key: 'label' | 'prompt', text: string | null) => {
    if (text === null) return
    const value = key === 'label' ? text.replace(/\s*\n\s*/g, ' ').trim() : text.trim()
    if (value === button.props[key] || (key === 'label' && !value)) return
    if (textEditor?.editingId) textEditor.finish()
    const update = (node: NodeRecord) => (node.type === 'button' ? { ...node, props: { ...(node.props as ButtonProps), [key]: value } } : node)
    if (!editNodes(editor, [button.id], update, `button ${key}`)) (key === 'label' ? label : prompt).setDraft(text)
  }
  return (
    <div className="design-button-fields">
      <label className="design-button-field">
        <span>文字</span>
        <input
          type="text"
          value={label.draft ?? button.props.label}
          onChange={(e) => label.setDraft(e.target.value)}
          onBlur={() => commit('label', label.take())}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              label.setDraft(null)
              e.currentTarget.blur()
            }
          }}
        />
      </label>
      <label className="design-button-field">
        <span>押したときの指示</span>
        <textarea
          rows={3}
          placeholder="空なら、出す文字をそのまま送る"
          value={prompt.draft ?? button.props.prompt}
          onChange={(e) => prompt.setDraft(e.target.value)}
          onBlur={() => commit('prompt', prompt.take())}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.currentTarget.blur()
            if (e.key === 'Escape') {
              prompt.setDraft(null)
              e.currentTarget.blur()
            }
          }}
        />
      </label>
      <p className="design-button-hint">選んでいないボタンをクリックすると押せます。フレームの中のボタンは、そのフレームの付箋を書き直します。</p>
    </div>
  )
}
