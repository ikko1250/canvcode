import type { AlignEdge, Axis, PageDirection, ToolId } from '@canvcode/canvas'
import type { TextAlign } from '@canvcode/nodes'
import type { PieEntry, PieMenuDef } from './pieMenu.ts'

// パイメニューの中身（MAI-39。以前は画面の下端のツールバーに並べていたもの）。
// 項目を足すときは、ここに足す。1 つの輪は 8 項目くらいまでにして、多ければサブメニューにまとめる。
// ツール（MAI-42）：選択 / 手のひら / フリーハンド / 消しゴム / 図形 › / 文字 › / Portal › 空・PDF・Python・Markdown / Card › Python・Markdown
// 操作（MAI-57、キー o）：今の選択とキャンバスに応じた項目。項目が 1 つもなければ、メニューそのものを出さない

// ツールの名前（並びは以前のツールバーと同じ）
export const TOOL_LABELS: Record<ToolId, string> = {
  select: '選択',
  hand: '手のひら',
  rect: '矩形',
  ellipse: '楕円',
  text: 'テキスト',
  note: '付箋',
  frame: 'フレーム',
  draw: 'フリーハンド',
  eraser: '消しゴム',
  arrow: '矢印',
  // Portal › 空（空のキャンバスとその Portal）
  portal: '空',
  // Card › Markdown / Python（その場にカードを置く）
  markdown: 'Markdown',
  code: 'Python',
}

// メニューを作るのに要る、画面の状態と操作
export interface PieMenuContext {
  toolId: ToolId
  setTool(id: ToolId): void
  // Portal › PDF：PDF を選んで、ページを並べたキャンバスとその Portal を作る
  importPdf(): void
  // Portal › Markdown / Python：空の「無題.md」「無題.py」を置いたキャンバスとその Portal を作る（MAI-42）
  createFileCanvas(kind: 'markdown' | 'code'): void
  undo(): void
  redo(): void
  showStats: boolean
  toggleStats(): void
  benchRunning: boolean
  cardBenchRunning: boolean
  addBenchNodes(): void
  clearNodes(): void
  runBenchmark(): void
  addMarkdownCards(): void
  runCardBenchmark(): void
  markdownCardCount: number
  // 操作（MAI-57）：PDF のページの Canvas と、選んでいるもの
  pdf: PdfMenuContext
  selection: SelectionMenuContext
  // 次（前）のページへ（倍率はそのまま）
  panToPage(direction: PageDirection): void
  unlockAndSelectPdfPages(): void
  lockPdfPages(): void
  // 選んでいるテキスト・付箋の文字を 1 段階大きく（1）・小さく（-1）する
  stepFontSize(direction: 1 | -1): void
  setTextAlign(align: TextAlign): void
  alignSelection(edge: AlignEdge): void
  distributeSelection(axis: Axis): void
  lockSelection(): void
  duplicateSelection(): void
}

export interface PdfMenuContext {
  // この Canvas に PDF のページがあるか
  hasPages: boolean
  canNext: boolean
  canPrev: boolean
  // すべてのページが固定されている（「固定する」は出さない）・どれも固定されていない（「固定を外して選ぶ」は出さない）
  allLocked: boolean
  noneLocked: boolean
}

export interface SelectionMenuContext {
  // 選んでいるノードの数
  count: number
  // 整列・等間隔の対象の数（固定していないもの。group は 1 つ）
  arrangeCount: number
  // テキストか付箋を選んでいるか
  hasText: boolean
}

const ALIGN_EDGES: [AlignEdge, string][] = [
  ['left', '左'],
  ['hcenter', '左右中央'],
  ['right', '右'],
  ['top', '上'],
  ['vcenter', '上下中央'],
  ['bottom', '下'],
]

const TEXT_ALIGNS: [TextAlign, string][] = [
  ['left', '左'],
  ['center', '中央'],
  ['right', '右'],
]

// 操作のメニューの項目（MAI-57）。出す必要のないものは入れない。
// ページの項目（最大 4 つ）と選択の項目（最大 7 つ）を合わせて 8 つを超えるときは、ページの項目を「ページ ›」にまとめる
function buildActionItems(ctx: PieMenuContext): PieEntry[] {
  const { pdf, selection } = ctx
  const pages: PieEntry[] = []
  if (pdf.hasPages) {
    if (pdf.canNext) pages.push({ label: '次のページ', onSelect: () => ctx.panToPage('next') })
    if (pdf.canPrev) pages.push({ label: '前のページ', onSelect: () => ctx.panToPage('prev') })
    if (!pdf.noneLocked) pages.push({ label: 'ページをすべて選ぶ（固定を外す）', onSelect: ctx.unlockAndSelectPdfPages })
    if (!pdf.allLocked) pages.push({ label: 'ページを固定する', onSelect: ctx.lockPdfPages })
  }
  const items: PieEntry[] = []
  if (selection.hasText) {
    items.push({ label: '文字を大きく', onSelect: () => ctx.stepFontSize(1) })
    items.push({ label: '文字を小さく', onSelect: () => ctx.stepFontSize(-1) })
    items.push({ label: '揃え', items: TEXT_ALIGNS.map(([align, label]) => ({ label, onSelect: () => ctx.setTextAlign(align) })) })
  }
  if (selection.arrangeCount >= 2) {
    items.push({ label: '整列', items: ALIGN_EDGES.map(([edge, label]) => ({ label, onSelect: () => ctx.alignSelection(edge) })) })
  }
  if (selection.arrangeCount >= 3) {
    items.push({
      label: '等間隔',
      items: [
        { label: '横', onSelect: () => ctx.distributeSelection('x') },
        { label: '縦', onSelect: () => ctx.distributeSelection('y') },
      ],
    })
  }
  if (selection.count >= 1) {
    items.push({ label: '固定する', onSelect: ctx.lockSelection })
    items.push({ label: '複製', onSelect: ctx.duplicateSelection })
  }
  if (pages.length === 0) return items
  return pages.length + items.length <= 8 ? [...pages, ...items] : [{ label: 'ページ', items: pages }, ...items]
}

export function buildPieMenus(ctx: PieMenuContext): PieMenuDef[] {
  const tool = (id: ToolId): PieEntry => ({ label: TOOL_LABELS[id], active: ctx.toolId === id, onSelect: () => ctx.setTool(id) })
  const group = (label: string, ids: ToolId[]): PieEntry => ({ label, items: ids.map(tool) })
  const actions = buildActionItems(ctx)
  return [
    {
      id: 'tools',
      key: 'a',
      label: 'ツール',
      items: [
        tool('select'),
        tool('hand'),
        tool('draw'),
        tool('eraser'),
        group('図形', ['rect', 'ellipse', 'frame', 'arrow']),
        group('文字', ['text', 'note']),
        {
          label: 'Portal',
          items: [
            tool('portal'),
            { label: 'PDF', onSelect: ctx.importPdf },
            { label: 'Python', onSelect: () => ctx.createFileCanvas('code') },
            { label: 'Markdown', onSelect: () => ctx.createFileCanvas('markdown') },
          ],
        },
        group('Card', ['code', 'markdown']),
      ],
    },
    {
      id: 'others',
      key: '.',
      label: 'そのほか',
      items: [
        { label: '元に戻す', onSelect: ctx.undo },
        { label: 'やり直す', onSelect: ctx.redo },
        { label: ctx.showStats ? '計測を隠す' : '計測を表示', onSelect: ctx.toggleStats },
        {
          label: 'テスト用データ',
          items: [
            { label: '1 万ノードを追加', onSelect: ctx.addBenchNodes },
            { label: `Markdown カード ${ctx.markdownCardCount} 枚を追加`, onSelect: ctx.addMarkdownCards },
            { label: 'すべて消す', onSelect: ctx.clearNodes },
          ],
        },
        {
          label: 'ベンチマーク',
          items: [
            { label: ctx.benchRunning ? 'ベンチマーク実行中…' : 'ベンチマーク', disabled: ctx.benchRunning, onSelect: ctx.runBenchmark },
            {
              label: ctx.cardBenchRunning ? 'カードのベンチマーク実行中…' : 'カードのズームのベンチマーク',
              disabled: ctx.cardBenchRunning,
              onSelect: ctx.runCardBenchmark,
            },
          ],
        },
      ],
    },
    ...(actions.length > 0 ? [{ id: 'actions', key: 'o', label: '操作', items: actions }] : []),
  ]
}
