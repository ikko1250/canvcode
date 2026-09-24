import { defineNodeType, type FileContentSource } from './defineNodeType.ts'
import { normalizeDeckData } from '@canvcode/slides/core/slide-schema'
import { parseMarkdownDeck } from '@canvcode/slides/core/markdown-deck'

export interface SlideDeckCardProps {
  fileId: string
  w: number
  h: number
  role: 'owner' | 'shortcut'
}

export const SLIDE_DECK_CARD_SIZE = { w: 480, h: 320 }

function line(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, color: string, height = 1): void {
  ctx.fillStyle = color
  ctx.fillRect(x, y, w, height)
}

export function createSlideDeckCardType(files: FileContentSource) {
  const cache = new Map<string, { title: string; slideCount: number; layout: string; rows: number }>()
  const summary = (fileId: string) => {
    const content = files.get(fileId)
    if (!content) return null
    const cached = cache.get(content.version)
    if (cached) return cached
    try {
      const parsed = content.path?.toLowerCase().endsWith('.json')
        ? JSON.parse(content.text)
        : parseMarkdownDeck(content.text, content.path ?? 'deck.slide.md')
      const deck = normalizeDeckData(parsed, content.path ?? 'deck.slide.md')
      const first = deck.slides[0]
      if (!first) return null
      const result = { title: first.title, slideCount: deck.slides.length, layout: first.layout ?? 'table', rows: first.rows?.length ?? first.items?.length ?? 0 }
      cache.set(content.version, result)
      if (cache.size > 200) cache.delete(cache.keys().next().value as string)
      return result
    } catch {
      return null
    }
  }

  return defineNodeType<SlideDeckCardProps>({
    type: 'slide-deck-card',
    version: 1,
    defaultProps: () => ({ fileId: '', ...SLIDE_DECK_CARD_SIZE, role: 'owner' }),
    getBounds: (node) => ({ x: 0, y: 0, w: node.props.w, h: node.props.h }),
    hitTest: (node, point, margin) => point.x >= -margin && point.y >= -margin && point.x <= node.props.w + margin && point.y <= node.props.h + margin,
    render(ctx, node, info) {
      const { w, h, fileId, role } = node.props
      const doc = info.documents?.get(fileId)
      const card = summary(fileId)
      ctx.save()
      ctx.fillStyle = '#fbfaf7'
      ctx.fillRect(0, 0, w, h)
      ctx.strokeStyle = '#c9c4ba'
      ctx.lineWidth = 1
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1)
      ctx.fillStyle = '#24364b'
      ctx.fillRect(0, 0, w, 34)
      ctx.fillStyle = '#fff'
      ctx.font = '600 14px sans-serif'
      ctx.textBaseline = 'middle'
      ctx.fillText('SLIDE DECK', 14, 17)
      if (doc?.status !== 'ok' || !card) {
        ctx.fillStyle = '#666'
        ctx.font = '14px sans-serif'
        ctx.textBaseline = 'middle'
        ctx.fillText(doc?.status === 'nofile' ? 'デッキファイルが見つかりません' : '読み込み中、または形式エラー', 14, 82, w - 28)
      } else {
        const pageX = 18
        const pageY = 48
        const pageW = w - 36
        const pageH = Math.min(h - 94, pageW * 9 / 16)
        ctx.fillStyle = '#f3f1eb'
        ctx.fillRect(pageX, pageY, pageW, pageH)
        ctx.fillStyle = '#292d33'
        ctx.font = 'bold 20px "M PLUS 1p", sans-serif'
        ctx.textBaseline = 'alphabetic'
        ctx.fillText(card.title, pageX + 22, pageY + 46, pageW - 44)
        line(ctx, pageX + 22, pageY + 60, pageW - 44, '#8a8173', 2)
        ctx.fillStyle = '#65717b'
        ctx.font = '12px sans-serif'
        ctx.fillText(`${card.layout} · ${card.rows} 項目`, pageX + 22, pageY + 83)
        const count = Math.min(card.rows || 3, 5)
        for (let index = 0; index < count; index++) {
          const y = pageY + 102 + index * 22
          line(ctx, pageX + 22, y, pageW - 44, index % 2 ? '#c6c1b9' : '#d9d4ca', 3)
          line(ctx, pageX + 22, y + 7, Math.max(40, pageW * 0.62), '#e0dcd4', 2)
        }
        ctx.fillStyle = '#59616a'
        ctx.font = '12px sans-serif'
        ctx.textBaseline = 'middle'
        ctx.fillText(`${card.slideCount} 枚`, 18, h - 24)
      }
      if (role === 'shortcut') {
        ctx.strokeStyle = '#8d70bf'
        ctx.setLineDash([5, 4])
        ctx.strokeRect(2, 2, w - 4, h - 4)
      }
      ctx.restore()
    },
    roughColor: () => '#f3f1eb',
    resize(node, size) { return { ...node.props, w: size.w, h: size.h } },
    minSize: { w: 260, h: 180 },
    reference: (node) => (node.props.fileId ? { targetId: node.props.fileId, role: node.props.role } : null),
    withRole: (node, role) => ({ ...node.props, role }),
  })
}
