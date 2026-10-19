import type { AlignEdge, Axis, PageDirection, ReorderDirection, ToolId } from '@canvcode/canvas'
import { FILTER_OP_LABELS, filterNeedsValue, type SlideLayoutKind, type SlideRatio, type TableFilterOp, type TextAlign } from '@canvcode/nodes'
import type { PieEntry, PieMenuDef } from './pieMenu.ts'

// パイメニューの中身（MAI-39。以前は画面の下端のツールバーに並べていたもの）。
// 項目を足すときは、ここに足す。1 つの輪は 8 項目くらいまでにして、多ければサブメニューにまとめる。
// ツール（MAI-42）：選択 / 手のひら / フリーハンド / 消しゴム / 図形 ›（矩形・楕円・ブロック矢印 ›・円グラフ・フレーム・スライド 16:9・スライド 4:3・矢印・線）/ 文字 › テキスト・タイトル・付箋 / Portal › 空・PDF・Python・Markdown / Card › Python・Markdown
// 操作（MAI-57、キー o）：今の選択とキャンバスに応じた項目（スライドがあれば「スライドを PDF に出力」も、スライドの表・箇条書きの中なら「行を足す」「行を消す」も、
// 手で高さを決めた行のセルを選んでいれば「行の高さを自動に戻す」も、
// 子の無いスライドを 1 つだけ選んでいれば「テンプレート ›」も）。
// 項目が 1 つもなければ、メニューそのものを出さない

// ツールの名前（並びは以前のツールバーと同じ）
export const TOOL_LABELS: Record<ToolId, string> = {
  select: '選択',
  hand: '手のひら',
  rect: '矩形',
  ellipse: '楕円',
  // ブロック矢印（MAI-87。図形 › ブロック矢印 ›）
  blockArrow: '右向き',
  blockArrowBoth: '両向き',
  blockArrowBent: '曲がった矢印',
  chevron: 'シェブロン',
  // 円グラフ（MAI-88。図形 › 円グラフ）
  pieChart: '円グラフ',
  text: 'テキスト',
  // テキストと同じノードで、文字が大きいだけ（MAI-62）
  title: 'タイトル',
  note: '付箋',
  frame: 'フレーム',
  draw: 'フリーハンド',
  eraser: '消しゴム',
  // 矢じりなしにすれば線になるので「矢印・線」（ノードの型は arrow のまま）
  arrow: '矢印・線',
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
  // Card › CSV：CSV・TSV を選んで、表のカードを置く
  importTable(): void
  // Portal › Markdown / Python：新しい File を置いたキャンバスとその Portal を作る（MAI-42）
  createFileCanvas(kind: 'markdown' | 'code'): void
  // 図形 › スライド 16:9 / 4:3：パイメニューを開いた位置を中心にスライドを置いて選ぶ（スライド v2）
  placeSlide(ratio: SlideRatio): void
  undo(): void
  redo(): void
  showStats: boolean
  toggleStats(): void
  benchRunning: boolean
  cardBenchRunning: boolean
  addBenchNodes(): void
  // 影付きの 1 万ノード（MAI-86）
  addBenchShadowNodes(): void
  clearNodes(): void
  runBenchmark(): void
  addMarkdownCards(): void
  runCardBenchmark(): void
  markdownCardCount: number
  // 操作（MAI-57）：PDF のページの Canvas と、選んでいるもの
  pdf: PdfMenuContext
  selection: SelectionMenuContext
  // パイメニューを開いた位置の下にある表のカード（なければ null）
  table: TableMenuContext | null
  // 表のカードの、開いた位置の列を並び替える（null なら並び替えをやめる）・絞り込む（値の要る条件は、値を尋ねてから）・
  // 絞り込みの条件を外す（'column' はその列だけ）・折り返しを切り替える
  sortTable(dir: 'asc' | 'desc' | null): void
  filterTable(op: TableFilterOp): void
  clearTableFilters(scope: 'column' | 'all'): void
  toggleTableWrap(): void
  // 次（前）のページへ（倍率はそのまま）
  panToPage(direction: PageDirection): void
  unlockAndSelectPdfPages(): void
  lockPdfPages(): void
  // 選んでいるテキスト・付箋の文字を 1 段階大きく（1）・小さく（-1）する
  stepFontSize(direction: 1 | -1): void
  setTextAlign(align: TextAlign): void
  alignSelection(edge: AlignEdge): void
  distributeSelection(axis: Axis): void
  reorderSelection(direction: ReorderDirection): void
  lockSelection(): void
  duplicateSelection(): void
  // 選んでいるスライドの比率を切り替える・非表示にする／表示する（スライド v2）
  toggleSlideRatio(): void
  toggleSlidesHidden(): void
  // 選んでいるスライドの中身（表・箇条書き・表＋画像）に行を足す・選んでいるセルの行を消す（スライド v2）
  addSlideRow(): void
  removeSlideRow(): void
  // 選んでいるセルの行の高さを自動に戻す（手で決めた高さを外す。スライド v2）
  resetSlideRowHeight(): void
  // 選んでいるスライド（子が無いもの）にテンプレート（表紙・箇条書き・表・表＋画像）を置く（スライド v2）
  applySlideTemplate(kind: SlideLayoutKind): void
  // 今のキャンバスにスライドがあるか（非表示のものも数える）と、スライドを PDF に出力する（スライド v2）
  hasSlides: boolean
  exportSlidesPdf(): void
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

export interface TableMenuContext {
  // 開いた位置の列（列の上でなければ null）
  column: { numeric: boolean; sorted: boolean; filtered: boolean } | null
  // 並び替えているか・絞り込みの条件の数・折り返しているか
  sorted: boolean
  filterCount: number
  wrap: boolean
}

export interface SelectionMenuContext {
  // 選んでいるノードの数
  count: number
  // 整列・等間隔の対象の数（固定していないもの。group は 1 つ）
  arrangeCount: number
  // 重なり順を変える対象の数（フレームの中のもの）
  reorderCount: number
  // テキストか付箋を選んでいるか
  hasText: boolean
  // 選んでいるスライドの数と、それが全部非表示か（スライド v2）
  slideCount: number
  slidesHidden: boolean
  // 表・箇条書き・表＋画像の slide-layout の中（またはそのスライド）を選んでいれば、選んでいるセルの行を消せるか・
  // その行が手で決めた高さを持つか。そうでなければ null（スライド v2）
  slideRows: { canRemove: boolean; manualHeight?: boolean } | null
  // スライドを 1 つだけ選んでいて、そのスライドに子が無いか。テンプレートを置ける（スライド v2）
  slideTemplate: boolean
}

const ALIGN_EDGES: [AlignEdge, string][] = [
  ['left', '左'],
  ['hcenter', '左右中央'],
  ['right', '右'],
  ['top', '上'],
  ['vcenter', '上下中央'],
  ['bottom', '下'],
]

const REORDERS: [ReorderDirection, string][] = [
  ['front', '最前面'],
  ['forward', '前面'],
  ['backward', '背面'],
  ['back', '最背面'],
]

const SLIDE_TEMPLATES: [SlideLayoutKind, string][] = [
  ['title', '表紙'],
  ['bullets', '箇条書き'],
  ['table', '表'],
  ['table-image', '表＋画像'],
  ['table-images', '表＋2画像'],
]

// 絞り込みの条件（文字の列と数の列。値の要るものは「…」を付け、選んだあとに値を尋ねる）
const TEXT_FILTERS: TableFilterOp[] = ['contains', 'notContains', 'equals', 'notEquals', 'empty', 'notEmpty']
const NUMBER_FILTERS: TableFilterOp[] = ['equals', 'notEquals', 'gt', 'ge', 'lt', 'le', 'empty', 'notEmpty']

// 表のカードの項目：列の上なら「並び替え ›」「フィルター ›」、条件があれば「フィルターを外す」、いつも「折り返す」
function buildTableItems(ctx: PieMenuContext, table: TableMenuContext): PieEntry[] {
  const items: PieEntry[] = []
  const column = table.column
  if (column) {
    const sort: PieEntry[] = [
      { label: '昇順', onSelect: () => ctx.sortTable('asc') },
      { label: '降順', onSelect: () => ctx.sortTable('desc') },
    ]
    if (table.sorted) sort.push({ label: '並び替えをやめる', onSelect: () => ctx.sortTable(null) })
    items.push({ label: '並び替え', items: sort })
    const ops = column.numeric ? NUMBER_FILTERS : TEXT_FILTERS
    items.push({
      label: 'フィルター',
      items: ops.map((op) => ({ label: FILTER_OP_LABELS[op] + (filterNeedsValue(op) ? '…' : ''), onSelect: () => ctx.filterTable(op) })),
    })
  }
  if (table.filterCount > 0) {
    // この列に条件があり、ほかの列にもあれば、どちらを外すかを選ぶ
    if (column?.filtered && table.filterCount > 1) {
      items.push({
        label: 'フィルターを外す',
        items: [
          { label: 'この列', onSelect: () => ctx.clearTableFilters('column') },
          { label: 'すべて', onSelect: () => ctx.clearTableFilters('all') },
        ],
      })
    } else {
      items.push({ label: 'フィルターを外す', onSelect: () => ctx.clearTableFilters(column?.filtered ? 'column' : 'all') })
    }
  }
  items.push({ label: table.wrap ? '折り返さない' : '折り返す', onSelect: ctx.toggleTableWrap })
  return items
}

const TEXT_ALIGNS: [TextAlign, string][] = [
  ['left', '左'],
  ['center', '中央'],
  ['right', '右'],
]

// 操作のメニューの項目（MAI-57）。出す必要のないものは入れない。
// ページの項目（最大 4 つ）と選択の項目（最大 8 つ）を合わせて 8 つを超えるときは、ページの項目を「ページ ›」にまとめる。
// スライドの項目（選んでいるスライドの 2 つと、子の無いスライドを 1 つだけ選んでいるときの「テンプレート ›」、
// 行を持つスライドの中身を選んでいるときの「行を足す」「行を消す」「行の高さを自動に戻す」、キャンバスにスライドがあるときの「スライドを PDF に出力」）を足して
// 8 つを超えるときは、まず文字の項目（3 つ）を「文字 ›」にまとめ、まだ超えるならスライドの項目を「スライド ›」にまとめる
// （まとめれば選択の項目は 8 つに収まる）
function buildActionItems(ctx: PieMenuContext): PieEntry[] {
  const { pdf, selection } = ctx
  const pages: PieEntry[] = []
  if (pdf.hasPages) {
    if (pdf.canNext) pages.push({ label: '次のページ', onSelect: () => ctx.panToPage('next') })
    if (pdf.canPrev) pages.push({ label: '前のページ', onSelect: () => ctx.panToPage('prev') })
    if (!pdf.noneLocked) pages.push({ label: 'ページをすべて選ぶ（固定を外す）', onSelect: ctx.unlockAndSelectPdfPages })
    if (!pdf.allLocked) pages.push({ label: 'ページを固定する', onSelect: ctx.lockPdfPages })
  }
  const text: PieEntry[] = []
  if (selection.hasText) {
    text.push({ label: '文字を大きく', onSelect: () => ctx.stepFontSize(1) })
    text.push({ label: '文字を小さく', onSelect: () => ctx.stepFontSize(-1) })
    text.push({ label: '揃え', items: TEXT_ALIGNS.map(([align, label]) => ({ label, onSelect: () => ctx.setTextAlign(align) })) })
  }
  const items: PieEntry[] = []
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
  if (selection.reorderCount >= 1) {
    items.push({ label: '重なり順', items: REORDERS.map(([direction, label]) => ({ label, onSelect: () => ctx.reorderSelection(direction) })) })
  }
  if (selection.count >= 1) {
    items.push({ label: '固定する', onSelect: ctx.lockSelection })
    items.push({ label: '複製', onSelect: ctx.duplicateSelection })
  }
  const slides: PieEntry[] = []
  if (selection.slideCount >= 1) {
    slides.push({ label: '比率を切り替え', onSelect: ctx.toggleSlideRatio })
    slides.push({ label: selection.slidesHidden ? '表示する' : '非表示にする', onSelect: ctx.toggleSlidesHidden })
  }
  // テンプレートは子の無いスライドにだけ置けるので、行の項目（中身のあるスライド）とは一緒に出ない
  if (selection.slideTemplate) {
    slides.push({ label: 'テンプレート', items: SLIDE_TEMPLATES.map(([kind, label]) => ({ label, onSelect: () => ctx.applySlideTemplate(kind) })) })
  }
  if (selection.slideRows) {
    slides.push({ label: '行を足す', onSelect: ctx.addSlideRow })
    if (selection.slideRows.canRemove) slides.push({ label: '行を消す', onSelect: ctx.removeSlideRow })
    if (selection.slideRows.manualHeight) slides.push({ label: '行の高さを自動に戻す', onSelect: ctx.resetSlideRowHeight })
  }
  if (ctx.hasSlides) slides.push({ label: 'スライドを PDF に出力', onSelect: ctx.exportSlidesPdf })
  const foldText = text.length > 0 && text.length + items.length + slides.length > 8
  const foldSlides = slides.length > 1 && (foldText ? 1 : text.length) + items.length + slides.length > 8
  items.unshift(...(foldText ? [{ label: '文字', items: text }] : text))
  items.push(...(foldSlides ? [{ label: 'スライド', items: slides }] : slides))
  // 表の項目は先頭に置く（ポインタの下の列への操作なので）。合わせて 8 つを超えるときは「表 ›」にまとめる
  if (ctx.table) {
    const table = buildTableItems(ctx, ctx.table)
    items.unshift(...(table.length + items.length > 8 ? [{ label: '表', items: table }] : table))
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
        {
          label: '図形',
          items: [
            tool('rect'),
            tool('ellipse'),
            group('ブロック矢印', ['blockArrow', 'blockArrowBoth', 'blockArrowBent', 'chevron']),
            tool('pieChart'),
            tool('frame'),
            { label: 'スライド 16:9', onSelect: () => ctx.placeSlide('16:9') },
            { label: 'スライド 4:3', onSelect: () => ctx.placeSlide('4:3') },
            tool('arrow'),
          ],
        },
        group('文字', ['text', 'title', 'note']),
        {
          label: 'Portal',
          items: [
            tool('portal'),
            { label: 'PDF', onSelect: ctx.importPdf },
            { label: 'Python', onSelect: () => ctx.createFileCanvas('code') },
            { label: 'Markdown', onSelect: () => ctx.createFileCanvas('markdown') },
          ],
        },
        { label: 'Card', items: [tool('code'), tool('markdown'), { label: 'CSV', onSelect: ctx.importTable }] },
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
            { label: '影付きの 1 万ノードを追加', onSelect: ctx.addBenchShadowNodes },
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
