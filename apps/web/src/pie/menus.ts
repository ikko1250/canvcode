import type { ToolId } from '@canvcode/canvas'
import type { PieEntry, PieMenuDef } from './pieMenu.ts'

// パイメニューの中身（MAI-39。以前は画面の下端のツールバーに並べていたもの）。
// 項目を足すときは、ここに足す。1 つの輪は 8 項目くらいまでにして、多ければサブメニューにまとめる

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
  portal: 'Portal',
  markdown: 'Markdown',
  code: 'Python',
}

// メニューを作るのに要る、画面の状態と操作
export interface PieMenuContext {
  toolId: ToolId
  setTool(id: ToolId): void
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
}

export function buildPieMenus(ctx: PieMenuContext): PieMenuDef[] {
  const tool = (id: ToolId): PieEntry => ({ label: TOOL_LABELS[id], active: ctx.toolId === id, onSelect: () => ctx.setTool(id) })
  const group = (label: string, ids: ToolId[]): PieEntry => ({ label, items: ids.map(tool) })
  return [
    {
      id: 'tools',
      key: '-',
      label: 'ツール',
      items: [
        tool('select'),
        tool('hand'),
        group('図形', ['rect', 'ellipse', 'frame']),
        group('文字', ['text', 'note']),
        group('描く', ['draw', 'eraser', 'arrow']),
        tool('portal'),
        tool('markdown'),
        tool('code'),
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
  ]
}
