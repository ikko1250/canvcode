import {
  createId,
  indicesBetween,
  unionBoxes,
  type AssetRecord,
  type BindingRecord,
  type Box,
  type NodeRecord,
  type Vec,
} from '@canvcode/core'
import type { ArrowProps, ImageProps } from '@canvcode/nodes'
import { freezeTerminal } from './bindings.ts'
import type { Editor } from './editor.ts'

// コピー・貼り付け・複製（MAI-12 の「8. クリップボード」、MAI-26）。
// クリップボードには、アプリ内の形式（ノードの JSON）と、プレーンテキスト（ノードの文字）を両方載せる。

export const CLIPBOARD_MIME = 'application/x-canvcode+json'
const HTML_ATTRIBUTE = 'data-canvcode'

export interface ClipboardPayload {
  kind: 'canvcode/nodes'
  version: 1
  // 選んだノード（ワールドでの形。parentId は元の親）と、その子孫（親のローカル座標のまま）
  nodes: NodeRecord[]
  // 選んだノードの id（重なり順）
  roots: string[]
  // 選んだノード全体のワールドでのバウンディングボックス
  bounds: Box
  // 画像ノードが参照している Asset（別のタブに貼り付けても読めるように）
  assets: AssetRecord[]
  // 矢印の Binding のうち、両端がコピーに入っているもの（MAI-28）
  bindings: BindingRecord[]
}

// 選んでいるノードを、クリップボードに載せる形にする。何も選んでいなければ null
export function copySelection(editor: Editor, resolveAsset?: (id: string) => AssetRecord | undefined): ClipboardPayload | null {
  const selected = new Set(editor.session.get().selectedIds)
  // 祖先も選ばれているノードは、祖先と一緒に入るので除く
  const roots = editor.index.sortByOrder(
    [...selected].filter((id) => editor.getNode(id) && !editor.index.ancestorsOf(id).some((a) => selected.has(a))),
  )
  if (roots.length === 0) return null
  const nodes: NodeRecord[] = []
  const boxes: Box[] = []
  for (const id of roots) {
    nodes.push(editor.toWorld(editor.getNode(id)!))
    for (const child of editor.index.descendantsOf(id)) nodes.push(editor.getNode(child)!)
    const entry = editor.index.get(id)
    if (entry) boxes.push(entry.worldBounds)
  }
  // 矢印の Binding は、つながっている先もコピーに入っていれば一緒に持っていく。
  // 入っていなければ、その端を今見えている位置に固定する
  const copied = new Set(nodes.map((n) => n.id))
  const bindings: BindingRecord[] = []
  for (const [i, node] of nodes.entries()) {
    if (node.type !== 'arrow') continue
    let props = node.props as ArrowProps
    for (const binding of editor.bindingsOfArrow(node.id)) {
      if (copied.has(binding.toId)) bindings.push(binding)
      else props = freezeTerminal(props, binding.props.terminal)
    }
    if (props !== node.props) nodes[i] = { ...node, props }
  }
  const assets = new Map<string, AssetRecord>()
  for (const node of nodes) {
    if (node.type !== 'image') continue
    const assetId = (node.props as ImageProps).assetId
    const asset = resolveAsset?.(assetId)
    if (asset) assets.set(assetId, asset)
  }
  return {
    kind: 'canvcode/nodes',
    version: 1,
    nodes,
    roots,
    bounds: unionBoxes(boxes) ?? { x: 0, y: 0, w: 0, h: 0 },
    assets: [...assets.values()],
    bindings,
  }
}

// ノードの文字（テキスト・付箋・図形のラベル）を、重なり順に改行でつなぐ
export function payloadText(editor: Editor, payload: ClipboardPayload): string {
  const texts: string[] = []
  for (const node of payload.nodes) {
    const type = editor.types.get(node.type)
    const text = type?.editText?.(node).text.trim()
    if (text) texts.push(text)
  }
  return texts.join('\n')
}

export interface InsertOptions {
  // 選んだノードの箱の中心を置く位置（ワールド座標）
  center?: Vec
  // 元の位置からずらす量（複製で使う）。center と一緒には使わない
  offset?: Vec
  // 選んだノードの新しい親。既定は Canvas 直下。'original' なら元の親（複製で使う）
  parentId?: string | 'original'
}

// クリップボードの中身を、新しい id を振ってキャンバスに入れる。入れたノード（選んだノードに当たるもの）の id を返す
export function insertPayload(editor: Editor, payload: ClipboardPayload, options: InsertOptions, label = 'paste'): string[] {
  const offset = options.center
    ? {
        x: options.center.x - (payload.bounds.x + payload.bounds.w / 2),
        y: options.center.y - (payload.bounds.y + payload.bounds.h / 2),
      }
    : (options.offset ?? { x: 0, y: 0 })
  const idMap = new Map(payload.nodes.map((node) => [node.id, createId('node')]))
  const rootSet = new Set(payload.roots)

  // 選んだノードの新しい親を決める（元の親がもうなければ Canvas 直下）
  const parentOf = (root: NodeRecord): string => {
    if (options.parentId === 'original') {
      return root.parentId === editor.canvasId || editor.getNode(root.parentId) ? root.parentId : editor.canvasId
    }
    return options.parentId ?? editor.canvasId
  }
  // 親ごとに、最も手前に並べるための index をまとめて作る
  const rootsByParent = new Map<string, NodeRecord[]>()
  for (const id of payload.roots) {
    const root = payload.nodes.find((n) => n.id === id)
    if (!root) continue
    const parentId = parentOf(root)
    rootsByParent.set(parentId, [...(rootsByParent.get(parentId) ?? []), root])
  }

  const inserted: string[] = []
  editor.transact(label, (tx) => {
    for (const [parentId, roots] of rootsByParent) {
      const indices = indicesBetween(editor.index.topmost(parentId)?.index ?? null, null, roots.length)
      for (const [i, root] of roots.entries()) {
        const world = { ...root, id: idMap.get(root.id)!, x: root.x + offset.x, y: root.y + offset.y }
        tx.put({ ...editor.fromWorld(world, parentId), index: indices[i] })
        inserted.push(world.id)
      }
    }
    for (const node of payload.nodes) {
      if (rootSet.has(node.id)) continue
      const parentId = idMap.get(node.parentId)
      // 親がコピーに入っていない子孫はない（copySelection が子孫ごと入れる）が、念のため飛ばす
      if (!parentId) continue
      tx.put({ ...node, id: idMap.get(node.id)!, parentId })
    }
    for (const binding of payload.bindings) {
      const fromId = idMap.get(binding.fromId)
      const toId = idMap.get(binding.toId)
      if (fromId && toId) tx.put({ ...binding, id: createId('binding'), fromId, toId })
    }
    editor.setSelection(inserted)
  })
  return inserted
}

// 選んでいるノードを複製する（Ctrl+D）。元の親の中の最も手前に、少しずらして置く
export function duplicateSelection(editor: Editor, offset: Vec): string[] {
  const payload = copySelection(editor)
  if (!payload) return []
  return insertPayload(editor, payload, { offset, parentId: 'original' }, 'duplicate')
}

// ---- クリップボードとの受け渡し ----

// text/html にも載せておく（アプリ内の形式を読めない貼り付け先や、ブラウザの違いに備える）
export function payloadToHtml(payload: ClipboardPayload): string {
  return `<div ${HTML_ATTRIBUTE}="${encodeBase64(JSON.stringify(payload))}"></div>`
}

export function parsePayload(data: { json?: string; html?: string }): ClipboardPayload | null {
  try {
    if (data.json) return validPayload(JSON.parse(data.json))
    if (data.html) {
      const match = new RegExp(`${HTML_ATTRIBUTE}="([A-Za-z0-9+/=]+)"`).exec(data.html)
      if (match) return validPayload(JSON.parse(decodeBase64(match[1])))
    }
  } catch {
    // 壊れたデータは、アプリ内の形式ではないとみなす
  }
  return null
}

function validPayload(value: unknown): ClipboardPayload | null {
  const p = value as ClipboardPayload
  if (p?.kind !== 'canvcode/nodes' || p.version !== 1 || !Array.isArray(p.nodes) || !Array.isArray(p.roots)) return null
  return { ...p, assets: Array.isArray(p.assets) ? p.assets : [], bindings: Array.isArray(p.bindings) ? p.bindings : [] }
}

function encodeBase64(text: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeBase64(base64: string): string {
  const binary = atob(base64)
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
}

// ---- 外からの貼り付け ----

// 貼り付けた文字列から作るテキストノード。長い行があれば幅を決めて折り返す
const WRAP_LINE_CHARS = 80
const WRAP_WIDTH = 600

export function insertText(editor: Editor, text: string, center: Vec): string | null {
  const trimmed = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  if (!trimmed) return null
  const wrap = trimmed.split('\n').some((line) => line.length > WRAP_LINE_CHARS)
  const node = editor.makeNode('text', {
    x: 0,
    y: 0,
    props: wrap ? { text: trimmed, autoWidth: false, w: WRAP_WIDTH } : { text: trimmed, autoWidth: true },
  })
  // 大きさは作ってみないとわからないので、索引に入れてから中心を合わせる
  editor.transact('paste text', (tx) => {
    const bounds = editor.getType(node).getBounds(node)
    tx.put({ ...node, x: center.x - bounds.w / 2, y: center.y - bounds.h / 2 })
    editor.setSelection([node.id])
  })
  return node.id
}

// 画像ノードを、center を中心に横に並べて置く。maxSize（ワールド座標）に収まるよう縮める
const IMAGE_GAP = 20

export function insertImages(editor: Editor, assets: AssetRecord[], center: Vec, maxSize: { w: number; h: number }): string[] {
  if (assets.length === 0) return []
  const sizes = assets.map((asset) => {
    const s = Math.min(1, maxSize.w / asset.width, maxSize.h / asset.height)
    return { w: asset.width * s, h: asset.height * s }
  })
  const total = sizes.reduce((sum, size) => sum + size.w, 0) + IMAGE_GAP * (sizes.length - 1)
  let x = center.x - total / 2
  const nodes = assets.map((asset, i) => {
    const { w, h } = sizes[i]
    const node = editor.makeNode('image', { x, y: center.y - h / 2, props: { assetId: asset.id, w, h, crop: null } })
    x += w + IMAGE_GAP
    return node
  })
  const indices = indicesBetween(editor.index.topmost()?.index ?? null, null, nodes.length)
  editor.transact('paste image', (tx) => {
    for (const [i, node] of nodes.entries()) tx.put({ ...node, index: indices[i] })
    editor.setSelection(nodes.map((n) => n.id))
  })
  return nodes.map((n) => n.id)
}
