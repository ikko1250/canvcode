/**
 * スライド v2：キャンバスのスライドの中にテンプレートでノードを並べるための幾何（DOM に依存しない純関数）。
 *
 * - 値は v1 のスライドエンジン（computeSlideGeometry・computeCoverGeometry・各 *_SPEC）から取り、数値を写し直さない。
 * - 箱はスライドのローカル座標（左上が 0,0）で返す。文字の箱はセルの箱（地を塗る範囲）で、
 *   セルの中の文字の余白は canvas-slide-theme.ts のテーマで持つ。
 * - 行の高さは、渡されなければ v1 の defaultRowPx（一律）を使う。行ごとの高さ（rowHeights。v1 の computedRowHeights にあたる）を
 *   渡せば、その高さで上から gap を挟んで積む。内容から高さを決めるのは canvas-slide-rows.ts（canvasSlideRowHeights）。
 * - 4:3 は横の寸法（x と幅）をすべて 1440/1920 倍にする。縦と文字の大きさは変えない。
 */

import {
  clampTableImageWidth,
  computeCoverGeometry,
  computeSlideGeometry,
  lineBoxHeight,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  TABLE_IMAGE_SPEC,
  TABLE_IMAGES_SPEC,
  TABLE_SPEC,
  TITLE_SPEC,
  TITLE_TYPOGRAPHY,
  type SlideGeometry,
} from "../core/slide-layout-spec.ts";

/** キャンバスのスライドの縦横比（packages/nodes の slide ノードの ratio と同じ文字列） */
export type CanvasSlideRatio = "16:9" | "4:3";

/** スライド v2 のテンプレートが扱うレイアウト */
export type CanvasSlideLayout = "title" | "bullets" | "table" | "table-image" | "table-images";

/** 行グリッドを持つレイアウト */
export type CanvasGridSlideLayout = Exclude<CanvasSlideLayout, "title">;

export const CANVAS_SLIDE_LAYOUTS: readonly CanvasSlideLayout[] = [
  "title",
  "bullets",
  "table",
  "table-image",
  "table-images",
];

/** 縦横比ごとのスライドの大きさ。高さはどちらも v1 と同じ */
export const CANVAS_SLIDE_SIZES: Record<CanvasSlideRatio, { w: number; h: number }> = {
  "16:9": { w: SLIDE_WIDTH, h: SLIDE_HEIGHT },
  "4:3": { w: 1440, h: SLIDE_HEIGHT },
};

/** table-image の図の枠線の太さ（v1 の slide.css の .figure-panel） */
export const FIGURE_BORDER_WIDTH = 1;

/** スライドのローカル座標の箱 */
export type CanvasBox = { x: number; y: number; w: number; h: number };

/** 1 行の箱。label は table / table-image / table-images だけ（bullets は null） */
export type CanvasSlideRowBoxes = {
  label: CanvasBox | null;
  body: CanvasBox;
};

/** table / bullets / table-image / table-images の箱 */
export type CanvasGridSlideBoxes = {
  layout: CanvasGridSlideLayout;
  ratio: CanvasSlideRatio;
  /** スライドの大きさ */
  size: { w: number; h: number };
  rowCount: number;
  /** v1 の compact 規則（行が少ないときにタイトルとパネルを上下中央に寄せる）が効いているか */
  compact: boolean;
  /** スライドのタイトル（v1 の h1）。高さは 1 行分＋titleExtraPx（2 行以上のときの増えた分） */
  title: CanvasBox;
  /** 灰色の地のパネル */
  panel: CanvasBox;
  /** パネルの中の行グリッドの領域（パネルの padding の内側） */
  grid: CanvasBox;
  rows: CanvasSlideRowBoxes[];
  /** 一律の行の高さ（v1 の defaultRowPx。rowHeights を渡したときも、この幾何の既定の値）と行の間隔 */
  rowPx: number;
  gapPx: number;
  /** table-image の図の枠（枠線を含む外形）。table-images は下の左の図の枠。他のレイアウトは null */
  figure: CanvasBox | null;
  /** table-images の下の右の図の枠。他のレイアウトは null */
  figure2: CanvasBox | null;
  /** table-image の図の中身を置く範囲（枠線と padding の内側）。他のレイアウトは null */
  figureContent: CanvasBox | null;
};

/** 表紙（title）の箱 */
export type CanvasCoverBoxes = {
  layout: "title";
  ratio: CanvasSlideRatio;
  size: { w: number; h: number };
  hasCredits: boolean;
  /**
   * 見出し（タイトル＋副題）を上下中央に置く領域。
   * 文字の高さはここでは測れないので、上下中央に寄せるのは placeCoverHeading（呼び出し側）でする。
   */
  headingArea: CanvasBox;
  /** 見出しの中心 Y（headingArea の上下中央） */
  headingCenterY: number;
  /** タイトルと副題の間隔（副題の margin-top） */
  subtitleGap: number;
  /** credits の灰色の帯。credits がなければ null */
  credits: CanvasBox | null;
};

export type CanvasSlideBoxes = CanvasGridSlideBoxes | CanvasCoverBoxes;

export type CanvasSlideLayoutOptions = {
  /** title レイアウトで credits があるか */
  hasCredits?: boolean;
  /** compact に収まる行数でも全高パネルを使う（v1 の computedFullPanel） */
  forceFull?: boolean;
  /** 行ごとの高さ（v1 の computedRowHeights）。行数と数が合わなければ使わず、一律（defaultRowPx）にする */
  rowHeights?: readonly number[];
  /** table-image の左表パネルの幅（1920 幅の px）。右図枠は右端を変えずに、その分だけ狭く（広く）なる */
  tableWidth?: number;
  /**
   * 表パネル（灰色の外枠）の高さ（手で決めた高さ）。決めれば compact の規則を使わず、パネルは全高のときの上端から下へこの高さになる。
   * table-images は下の図の枠がその分だけ低く（高く）なる。範囲は clampTablePanelHeight で収める
   */
  tableHeight?: number;
  /** 表パネル（中の行を含む）をずらす量（1920 幅の px）。4:3 では横を縮める */
  tableOffset?: CanvasSlideOffset;
  /** table-image の右図枠をずらす量（1920 幅の px） */
  figureOffset?: CanvasSlideOffset;
  /**
   * タイトルが 1 行より高い分（呼び出し側が測る。2 行以上に折り返した・改行したとき）。
   * タイトルは下端を変えずに上へ伸ばす（compact の table / bullets はタイトルとパネルをまとめて上下中央に寄せ直す）。computeSlideGeometry の titleExtraPx
   */
  titleExtraPx?: number;
};

/** 手でずらした量（右・下が正） */
export type CanvasSlideOffset = { dx: number; dy: number };

/** 横の寸法の倍率（16:9 は 1、4:3 は 1440/1920） */
export function canvasSlideScaleX(ratio: CanvasSlideRatio): number {
  return CANVAS_SLIDE_SIZES[ratio].w / SLIDE_WIDTH;
}

function box(x: number, y: number, w: number, h: number, scaleX: number): CanvasBox {
  return { x: x * scaleX, y, w: w * scaleX, h };
}

/** v1 の幾何（1920 幅）から、表・箇条書き・表＋画像の箱を作る */
function gridBoxes(
  layout: CanvasGridSlideLayout,
  geometry: SlideGeometry,
  ratio: CanvasSlideRatio,
  options: CanvasSlideLayoutOptions,
): CanvasGridSlideBoxes {
  const sx = canvasSlideScaleX(ratio);
  const { grid } = geometry;
  const { rowHeights } = options;
  const isTableImage = layout === "table-image";
  const isTableImages = layout === "table-images";
  const tableWidth = clampTableImageWidth(options.tableWidth);
  const table = options.tableOffset ?? { dx: 0, dy: 0 };

  // パネルの横位置・幅と padding。table-image は左表パネル（右図枠の左）
  // table-images は上の表（全幅）。padding は v1 の table-images-panel
  const panelLeft = (isTableImage ? TABLE_IMAGE_SPEC.left : isTableImages ? TABLE_IMAGES_SPEC.left : TABLE_SPEC.left) + table.dx;
  const panelTop = geometry.panelTop + table.dy;
  const panelWidth = isTableImage ? tableWidth : isTableImages ? TABLE_IMAGES_SPEC.width : TABLE_SPEC.width;
  const padLeft = isTableImage ? TABLE_IMAGE_SPEC.panelPadding : isTableImages ? TABLE_IMAGES_SPEC.padding.x : TABLE_SPEC.padding.x;
  const padTop = isTableImage ? TABLE_IMAGE_SPEC.panelPadding : isTableImages ? TABLE_IMAGES_SPEC.padding.top : TABLE_SPEC.padding.top;

  const gridLeft = panelLeft + padLeft;
  const gridTop = panelTop + padTop;
  const rowPx = grid.defaultRowPx;
  const gapPx = grid.gapPx;

  const heights =
    rowHeights && rowHeights.length === geometry.rowCount
      ? rowHeights
      : Array.from({ length: geometry.rowCount }, () => rowPx);
  const rows: CanvasSlideRowBoxes[] = [];
  let y = gridTop;
  for (const h of heights) {
    if (layout === "bullets") {
      rows.push({ label: null, body: box(gridLeft, y, grid.contentWidthPx, h, sx) });
    } else {
      const bodyLeft = gridLeft + grid.labelWidthPx + grid.columnGapPx;
      rows.push({
        label: box(gridLeft, y, grid.labelWidthPx, h, sx),
        body: box(bodyLeft, y, grid.bodyWidthPx, h, sx),
      });
    }
    y += h + gapPx;
  }

  let figure: CanvasBox | null = null;
  let figure2: CanvasBox | null = null;
  let figureContent: CanvasBox | null = null;
  if (isTableImages) {
    // 下の 2 つの図の枠（v1 の figures-row：2 列・列の間隔 figuresGap）。上端は表パネル（ずらす前）の下から figuresGap 空け、
    // 下端はほかのレイアウトのパネル・図の枠の下端（table-image の図の枠の下端）にそろえる
    const s = TABLE_IMAGES_SPEC;
    const top = geometry.panelTop + geometry.panelHeight + s.figuresGap;
    const bottom = TABLE_IMAGE_SPEC.top + TABLE_IMAGE_SPEC.height;
    const h = Math.max(0, bottom - top);
    figure = box(s.left, top, s.figureColumnWidth, h, sx);
    figure2 = box(s.left + s.figureColumnWidth + s.figuresGap, top, s.figureColumnWidth, h, sx);
  }
  if (isTableImage) {
    const s = TABLE_IMAGE_SPEC;
    const offset = options.figureOffset ?? { dx: 0, dy: 0 };
    // 表を広げた分だけ右図枠を狭くする（ずらす前の右端は変えない）
    const figureWidth = s.figureWidth - (tableWidth - s.tableWidth);
    const figureLeft = s.left + tableWidth + s.columnGap + offset.dx;
    const figureTop = s.top + offset.dy;
    // 枠線と padding は border-box の内側に入る
    const inset = s.figurePadding + FIGURE_BORDER_WIDTH;
    figure = box(figureLeft, figureTop, figureWidth, s.height, sx);
    figureContent = box(
      figureLeft + inset,
      figureTop + inset,
      figureWidth - inset * 2,
      s.height - inset * 2,
      sx,
    );
  }

  // v1 の h1 は幅の指定がなく、left からスライドの右端までで折り返す
  const titleLeft = TABLE_SPEC.left;
  const titleExtra =
    typeof options.titleExtraPx === "number" && Number.isFinite(options.titleExtraPx) ? Math.max(0, options.titleExtraPx) : 0;
  return {
    layout,
    ratio,
    size: { ...CANVAS_SLIDE_SIZES[ratio] },
    rowCount: geometry.rowCount,
    compact: geometry.compact,
    title: box(
      titleLeft,
      geometry.titleTop,
      SLIDE_WIDTH - titleLeft,
      lineBoxHeight(TITLE_TYPOGRAPHY) + titleExtra,
      sx,
    ),
    panel: box(panelLeft, panelTop, panelWidth, geometry.panelHeight, sx),
    grid: box(gridLeft, gridTop, grid.contentWidthPx, grid.budgetPx, sx),
    rows,
    rowPx,
    gapPx,
    figure,
    figure2,
    figureContent,
  };
}

/** 表紙（title）の箱 */
export function canvasCoverLayout(
  hasCredits: boolean,
  ratio: CanvasSlideRatio = "16:9",
): CanvasCoverBoxes {
  const sx = canvasSlideScaleX(ratio);
  const geometry = computeCoverGeometry(hasCredits);
  const s = TITLE_SPEC;
  return {
    layout: "title",
    ratio,
    size: { ...CANVAS_SLIDE_SIZES[ratio] },
    hasCredits,
    headingArea: box(s.left, 0, s.width, geometry.headingAreaHeight, sx),
    headingCenterY: geometry.headingAreaHeight / 2,
    subtitleGap: s.subtitle.gap,
    credits: hasCredits
      ? box(s.left, geometry.bandTop, s.width, geometry.bandHeight, sx)
      : null,
  };
}

/**
 * 表紙の見出し（タイトル＋副題）を上下中央に置いた箱を返す。
 * titleHeight / subtitleHeight は呼び出し側が測った文字の高さ（副題がなければ subtitleHeight を省く）。
 * v1 の .cover-heading（grid の align-content: center）と同じく、タイトル・間隔・副題をまとめて中央に寄せる。
 */
export function placeCoverHeading(
  cover: CanvasCoverBoxes,
  titleHeight: number,
  subtitleHeight?: number,
): { title: CanvasBox; subtitle: CanvasBox | null } {
  const hasSubtitle = subtitleHeight !== undefined;
  const blockHeight = titleHeight + (hasSubtitle ? cover.subtitleGap + subtitleHeight : 0);
  const top = cover.headingCenterY - blockHeight / 2;
  const { x, w } = cover.headingArea;
  return {
    title: { x, y: top, w, h: titleHeight },
    subtitle: hasSubtitle
      ? { x, y: top + titleHeight + cover.subtitleGap, w, h: subtitleHeight }
      : null,
  };
}

/**
 * レイアウトの箱をスライドのローカル座標で返す。
 * 行数が v1 の getMaxRowCount(layout) を超える（または 1 未満の）ときは例外にする。title は rowCount を見ない。
 */
export function canvasSlideLayout(
  layout: "title",
  rowCount: number,
  ratio?: CanvasSlideRatio,
  options?: CanvasSlideLayoutOptions,
): CanvasCoverBoxes;
export function canvasSlideLayout(
  layout: CanvasGridSlideLayout,
  rowCount: number,
  ratio?: CanvasSlideRatio,
  options?: CanvasSlideLayoutOptions,
): CanvasGridSlideBoxes;
export function canvasSlideLayout(
  layout: CanvasSlideLayout,
  rowCount: number,
  ratio?: CanvasSlideRatio,
  options?: CanvasSlideLayoutOptions,
): CanvasSlideBoxes;
export function canvasSlideLayout(
  layout: CanvasSlideLayout,
  rowCount: number,
  ratio: CanvasSlideRatio = "16:9",
  options: CanvasSlideLayoutOptions = {},
): CanvasSlideBoxes {
  if (layout === "title") {
    return canvasCoverLayout(options.hasCredits === true, ratio);
  }
  const geometry = computeSlideGeometry(layout, rowCount, {
    forceFull: options.forceFull,
    tableWidth: options.tableWidth,
    tableHeight: options.tableHeight,
    titleExtraPx: options.titleExtraPx,
  });
  return gridBoxes(layout, geometry, ratio, options);
}
