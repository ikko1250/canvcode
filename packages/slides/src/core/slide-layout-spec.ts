/**
 * スライド幾何の単一ソース。
 *
 * - CSS（styles/slide.css）はここから生成したカスタムプロパティ（cssTokens）を参照する。
 * - ブラウザ描画（src/browser/renderer.ts）は computeSlideGeometry の結果をインラインスタイルで適用する。
 * - 行容量 lint（slide-row-capacity.ts）は getLayoutProfile から寸法を得る。
 *
 * 行数は列挙ではなく計算で扱う。承認済みのピクセル値（rows=2/3/4、table-images rows=1/2）は
 * 計算式と compactOverrides で再現し、それ以外の行数は同じ式から導出する。
 */

export type SlideLayout = "table" | "table-image" | "table-images" | "title" | "bullets";

export const SLIDE_LAYOUTS: readonly SlideLayout[] = [
  "table",
  "table-image",
  "table-images",
  "title",
  "bullets",
];

/** rows（ラベル＋本文の表）キーを持つレイアウト */
export const ROW_LAYOUTS: readonly SlideLayout[] = ["table", "table-image", "table-images"];

/** パネル内の行グリッド（行高・gap・compact 規則）を持つレイアウト。bullets は items を行として扱う */
export const GRID_LAYOUTS: readonly SlideLayout[] = [...ROW_LAYOUTS, "bullets"];

export function layoutUsesRows(layout: SlideLayout): boolean {
  return ROW_LAYOUTS.includes(layout);
}

export function layoutUsesRowGrid(layout: SlideLayout): boolean {
  return GRID_LAYOUTS.includes(layout);
}

export function isSlideLayout(value: unknown): value is SlideLayout {
  return typeof value === "string" && (SLIDE_LAYOUTS as readonly string[]).includes(value);
}

export const SLIDE_WIDTH = 1920;
export const SLIDE_HEIGHT = 1080;

export type TypographySpec = {
  fontSize: number;
  lineHeight: number;
  padV: number;
  padH: number;
  letterSpacingEm: number;
};

export const FONT_FAMILY = `"M PLUS 1p", sans-serif`;
export const CODE_FONT_FAMILY = `ui-monospace, "Cascadia Code", "Consolas", "Monaco", "Courier New", monospace`;
export const WEB_FONT_NAME = "M PLUS 1p";

export const COLORS = {
  panel: "#d9d9d9",
  paper: "#ffffff",
  creamA: "#fff7e2",
  creamB: "#fff5dc",
  ink: "#000000",
  figureBorder: "#cfcfcf",
} as const;

export const TITLE_TYPOGRAPHY = {
  fontSize: 46,
  lineHeight: 1.18,
  letterSpacingEm: -0.02,
} as const;

export const LABEL_TYPOGRAPHY: TypographySpec = {
  fontSize: 37,
  lineHeight: 1.38,
  padV: 8,
  padH: 18,
  letterSpacingEm: -0.015,
};

export const BODY_TYPOGRAPHY: TypographySpec = {
  fontSize: 31,
  lineHeight: 1.38,
  padV: 12,
  padH: 38,
  letterSpacingEm: -0.025,
};

export const CODE_TYPOGRAPHY = {
  fontSize: 20,
  lineHeight: 1.5,
} as const;

/** 全幅表（layout: "table"） */
export const TABLE_SPEC = {
  left: 150,
  width: 1660,
  fullTitleTop: 128,
  fullPanelTop: 197,
  fullPanelHeight: 772,
  padding: { top: 64, x: 70, bottom: 62 },
  /** compact 時: タイトル上端からパネル上端までの帯 */
  compactTitleBand: 68,
  compactRowPx: 150,
  compactGapPx: 40,
  fullGapPx: 41,
  labelWidthPx: 394,
  columnGapPx: 21,
} as const;

/** 左表・右図（layout: "table-image"） */
export const TABLE_IMAGE_SPEC = {
  left: 150,
  top: 197,
  width: 1660,
  height: 772,
  tableWidth: 680,
  columnGap: 20,
  figureWidth: 960,
  panelPadding: 40,
  fullTitleTop: 128,
  compactTitleBand: 68,
  fullGapPx: 44,
  compactGapPx: 40,
  /** 目視承認済みの compact 行高・gap（2026-07-20 rows-2-compact-design 案B ほか） */
  compactOverrides: {
    2: { rowPx: 170, gapPx: 46 },
    3: { rowPx: 162, gapPx: 45 },
  } as Record<number, { rowPx: number; gapPx: number } | undefined>,
  labelWidthPx: 200,
  rowColumnGapPx: 20,
  figurePadding: 20,
  figureBorderRadius: 16,
} as const;

/** 上表・下2図（layout: "table-images"） */
export const TABLE_IMAGES_SPEC = {
  left: 150,
  top: 165,
  width: 1660,
  height: 915,
  titleTop: 96,
  padding: { top: 32, x: 70, bottom: 31 },
  rowPx: 150,
  gapPx: 40,
  figuresGap: 20,
  figureColumnWidth: 820,
  figureTitle: { fontSize: 31, lineHeight: 1.38, gap: 16 },
  /** 下図領域がこれを下回る行数は許可しない */
  minFiguresHeightPx: 300,
  /** 下図領域がこれを下回る行数は警告する */
  warnFiguresHeightPx: 400,
  labelWidthPx: 394,
  columnGapPx: 21,
} as const;

/** 表紙（layout: "title"） */
export const TITLE_SPEC = {
  /** 表スライドのパネルと同じ横枠（150〜1810）に揃える */
  left: 150,
  width: 1660,
  textPaddingX: 40,
  title: { fontSize: 64, lineHeight: 1.25, letterSpacingEm: -0.02, maxLines: 2 },
  subtitle: { fontSize: 40, lineHeight: 1.4, gap: 28, maxLines: 2 },
  /** 見出しブロック（タイトル＋副題）の中心 Y。credits 帯があるときは上寄り */
  headingCenterY: 430,
  headingCenterYWithoutCredits: 540,
  credits: {
    fontSize: 31,
    lineHeight: 1.6,
    maxLines: 3,
    bandTop: 800,
    bandHeight: 180,
    paddingX: 70,
  },
} as const;

export type BulletLevelSpec = {
  fontSize: number;
  lineHeight: number;
  /** セル本文の左端からのインデント */
  indentPx: number;
  /** 行頭記号（CSS の content 用。空文字なら記号なし） */
  marker: string;
};

/** 箇条書き（layout: "bullets"）。パネル・行グリッド・compact 規則は table と共通、ラベル列なし */
export const BULLETS_SPEC = {
  maxDepth: 3,
  levels: [
    { fontSize: 31, lineHeight: 1.38, indentPx: 0, marker: "" },
    { fontSize: 28, lineHeight: 1.38, indentPx: 48, marker: "・" },
    { fontSize: 25, lineHeight: 1.38, indentPx: 96, marker: "－" },
  ] as readonly BulletLevelSpec[],
} as const;

export function bulletLevelSpec(depth: number): BulletLevelSpec {
  const index = Math.min(Math.max(depth, 0), BULLETS_SPEC.levels.length - 1);
  const level = BULLETS_SPEC.levels[index];
  if (!level) {
    throw new Error("箇条書きの階層スペックが定義されていません。");
  }
  return level;
}

export type CoverGeometry = {
  layout: "title";
  hasCredits: boolean;
  /** 見出しブロックを上下中央に置く領域の高さ（top 0 から。中心 = 高さ / 2） */
  headingAreaHeight: number;
  bandTop: number;
  bandHeight: number;
};

export function computeCoverGeometry(hasCredits: boolean): CoverGeometry {
  const s = TITLE_SPEC;
  const centerY = hasCredits ? s.headingCenterY : s.headingCenterYWithoutCredits;
  return {
    layout: "title",
    hasCredits,
    headingAreaHeight: centerY * 2,
    bandTop: s.credits.bandTop,
    bandHeight: s.credits.bandHeight,
  };
}

export type RowGridSpec = {
  rowCount: number;
  defaultRowPx: number;
  gapPx: number;
  /** 行グリッドに使える内容高（パネル高 − 上下 padding） */
  budgetPx: number;
  contentWidthPx: number;
  labelWidthPx: number;
  bodyWidthPx: number;
  columnGapPx: number;
};

export type GeometryOptions = {
  /** compact 幾何に収まる行数でも、全高パネル（fullPanelHeight / height）を使う。行容量 lint が内容量から決める */
  forceFull?: boolean;
};

export type SlideGeometry = {
  layout: SlideLayout;
  rowCount: number;
  compact: boolean;
  titleTop: number;
  /** 灰色表パネルのスライド座標での上端・高さ */
  panelTop: number;
  panelHeight: number;
  grid: RowGridSpec;
  /** table-images: 下図領域の高さ */
  figuresHeightPx?: number;
};

export function lineBoxHeight(typography: Pick<TypographySpec, "fontSize" | "lineHeight">): number {
  return typography.fontSize * typography.lineHeight;
}

export function textWidthPx(typography: TypographySpec, columnWidthPx: number): number {
  return columnWidthPx - typography.padH * 2;
}

/** 1 視覚行分の行高下限（label / body の大きい方） */
export function minRowPx(): number {
  const labelFloor = LABEL_TYPOGRAPHY.padV * 2 + lineBoxHeight(LABEL_TYPOGRAPHY);
  const bodyFloor = BODY_TYPOGRAPHY.padV * 2 + lineBoxHeight(BODY_TYPOGRAPHY);
  return Math.ceil(Math.max(labelFloor, bodyFloor));
}

/** 全幅パネルの幾何。table はラベル列あり、bullets はラベル列なし（本文が全幅） */
function panelGeometry(
  layout: "table" | "bullets",
  rowCount: number,
  options: GeometryOptions = {},
): SlideGeometry {
  const s = TABLE_SPEC;
  const padV = s.padding.top + s.padding.bottom;
  const natural = rowCount * s.compactRowPx + (rowCount - 1) * s.compactGapPx;
  const compact = !options.forceFull && natural + padV <= s.fullPanelHeight;

  let panelHeight: number;
  let panelTop: number;
  let titleTop: number;
  let rowPx: number;
  let gapPx: number;

  if (compact) {
    panelHeight = natural + padV;
    const block = s.compactTitleBand + panelHeight;
    titleTop = Math.round((SLIDE_HEIGHT - block) / 2);
    panelTop = titleTop + s.compactTitleBand;
    rowPx = s.compactRowPx;
    gapPx = s.compactGapPx;
  } else {
    panelHeight = s.fullPanelHeight;
    panelTop = s.fullPanelTop;
    titleTop = s.fullTitleTop;
    gapPx = s.fullGapPx;
    rowPx = Math.round((panelHeight - padV - (rowCount - 1) * gapPx) / rowCount);
  }

  const contentWidthPx = s.width - s.padding.x * 2;
  const labelWidthPx = layout === "bullets" ? 0 : s.labelWidthPx;
  const columnGapPx = layout === "bullets" ? 0 : s.columnGapPx;
  return {
    layout,
    rowCount,
    compact,
    titleTop,
    panelTop,
    panelHeight,
    grid: {
      rowCount,
      defaultRowPx: rowPx,
      gapPx,
      budgetPx: panelHeight - padV,
      contentWidthPx,
      labelWidthPx,
      bodyWidthPx: contentWidthPx - labelWidthPx - columnGapPx,
      columnGapPx,
    },
  };
}

function tableImageGeometry(rowCount: number, options: GeometryOptions = {}): SlideGeometry {
  const s = TABLE_IMAGE_SPEC;
  const t = TABLE_SPEC;
  // compact 時のパネル高は全幅表と同じ式（466 / 656）に揃える。
  const tablePadV = t.padding.top + t.padding.bottom;
  const natural = rowCount * t.compactRowPx + (rowCount - 1) * t.compactGapPx;
  const compact = !options.forceFull && natural + tablePadV <= s.height;
  const panelHeight = compact ? natural + tablePadV : s.height;
  // 左表パネルは右図枠（高さ s.height）内で上下中央（align-self: center）
  const panelTop = s.top + Math.round((s.height - panelHeight) / 2);
  const titleTop = compact ? panelTop - s.compactTitleBand : s.fullTitleTop;
  const budgetPx = panelHeight - s.panelPadding * 2;

  let rowPx: number;
  let gapPx: number;
  const override = compact ? s.compactOverrides[rowCount] : undefined;
  if (override) {
    rowPx = override.rowPx;
    gapPx = override.gapPx;
  } else {
    gapPx = compact ? s.compactGapPx : s.fullGapPx;
    rowPx = Math.round((budgetPx - (rowCount - 1) * gapPx) / rowCount);
  }

  const contentWidthPx = s.tableWidth - s.panelPadding * 2;
  return {
    layout: "table-image",
    rowCount,
    compact,
    titleTop,
    panelTop,
    panelHeight,
    grid: {
      rowCount,
      defaultRowPx: rowPx,
      gapPx,
      budgetPx,
      contentWidthPx,
      labelWidthPx: s.labelWidthPx,
      bodyWidthPx: contentWidthPx - s.labelWidthPx - s.rowColumnGapPx,
      columnGapPx: s.rowColumnGapPx,
    },
  };
}

function tableImagesGeometry(rowCount: number): SlideGeometry {
  const s = TABLE_IMAGES_SPEC;
  const padV = s.padding.top + s.padding.bottom;
  const budgetPx = rowCount * s.rowPx + (rowCount - 1) * s.gapPx;
  const panelHeight = budgetPx + padV;
  const contentWidthPx = s.width - s.padding.x * 2;
  return {
    layout: "table-images",
    rowCount,
    compact: false,
    titleTop: s.titleTop,
    panelTop: s.top,
    panelHeight,
    figuresHeightPx: s.height - panelHeight,
    grid: {
      rowCount,
      defaultRowPx: s.rowPx,
      gapPx: s.gapPx,
      budgetPx,
      contentWidthPx,
      labelWidthPx: s.labelWidthPx,
      bodyWidthPx: contentWidthPx - s.labelWidthPx - s.columnGapPx,
      columnGapPx: s.columnGapPx,
    },
  };
}

function rawGeometry(
  layout: SlideLayout,
  rowCount: number,
  options: GeometryOptions = {},
): SlideGeometry {
  switch (layout) {
    case "table":
      return panelGeometry("table", rowCount, options);
    case "bullets":
      return panelGeometry("bullets", rowCount, options);
    case "table-image":
      return tableImageGeometry(rowCount, options);
    case "table-images":
      return tableImagesGeometry(rowCount);
    case "title":
      throw new Error("title レイアウトは行グリッドを持ちません。");
  }
}

function isFeasible(geometry: SlideGeometry): boolean {
  if (geometry.grid.defaultRowPx < minRowPx()) {
    return false;
  }
  if (
    geometry.figuresHeightPx !== undefined &&
    geometry.figuresHeightPx < TABLE_IMAGES_SPEC.minFiguresHeightPx
  ) {
    return false;
  }
  return true;
}

const MAX_ROW_COUNT_SEARCH = 20;
const maxRowCountCache = new Map<SlideLayout, number>();

/** レイアウトごとに幾何上許容できる最大行数（列挙ではなく計算で導出） */
export function getMaxRowCount(layout: SlideLayout): number {
  if (!layoutUsesRowGrid(layout)) {
    return 0;
  }
  const cached = maxRowCountCache.get(layout);
  if (cached !== undefined) {
    return cached;
  }
  let max = 0;
  for (let n = 1; n <= MAX_ROW_COUNT_SEARCH; n += 1) {
    if (!isFeasible(rawGeometry(layout, n))) {
      break;
    }
    max = n;
  }
  maxRowCountCache.set(layout, max);
  return max;
}

export function isValidRowCount(layout: SlideLayout, rowCount: number): boolean {
  return Number.isInteger(rowCount) && rowCount >= 1 && rowCount <= getMaxRowCount(layout);
}

export function rowCountRangeMessage(
  layout: SlideLayout,
  rowCount: number,
  keyName = "rows",
): string {
  return `${layout} レイアウトでは ${keyName} は 1〜${getMaxRowCount(layout)} 件にしてください（現在 ${rowCount} 件）。`;
}

export function computeSlideGeometry(
  layout: SlideLayout,
  rowCount: number,
  options: GeometryOptions = {},
): SlideGeometry {
  if (!layoutUsesRowGrid(layout)) {
    throw new Error(`${layout} レイアウトは行グリッドを持ちません。`);
  }
  if (!isValidRowCount(layout, rowCount)) {
    throw new Error(rowCountRangeMessage(layout, rowCount));
  }
  return rawGeometry(layout, rowCount, options);
}

/** 行容量 lint 向けプロファイル（幾何 + タイポグラフィ） */
export type LayoutProfile = {
  layout: SlideLayout;
  rowCount: number;
  compact: boolean;
  contentWidthPx: number;
  contentHeightPx: number;
  labelWidthPx: number;
  bodyWidthPx: number;
  columnGapPx: number;
  defaultRowPx: number;
  gapPx: number;
  budgetPx: number;
  labelTypography: TypographySpec;
  bodyTypography: TypographySpec;
};

export function getLayoutProfile(
  layout: SlideLayout,
  rowCount: number,
  options: GeometryOptions = {},
): LayoutProfile {
  const geometry = computeSlideGeometry(layout, rowCount, options);
  const { grid } = geometry;
  return {
    layout,
    rowCount,
    compact: geometry.compact,
    contentWidthPx: grid.contentWidthPx,
    contentHeightPx: grid.budgetPx,
    labelWidthPx: grid.labelWidthPx,
    bodyWidthPx: grid.bodyWidthPx,
    columnGapPx: grid.columnGapPx,
    defaultRowPx: grid.defaultRowPx,
    gapPx: grid.gapPx,
    budgetPx: grid.budgetPx,
    labelTypography: LABEL_TYPOGRAPHY,
    bodyTypography: BODY_TYPOGRAPHY,
  };
}

function px(value: number): string {
  return `${value}px`;
}

/** styles/slide.css が参照する CSS カスタムプロパティ */
export function cssTokens(): Record<string, string> {
  return {
    "--slide-width": px(SLIDE_WIDTH),
    "--slide-height": px(SLIDE_HEIGHT),
    "--font-family": FONT_FAMILY,
    "--code-font-family": CODE_FONT_FAMILY,
    "--panel": COLORS.panel,
    "--paper": COLORS.paper,
    "--cream-a": COLORS.creamA,
    "--cream-b": COLORS.creamB,
    "--ink": COLORS.ink,
    "--figure-border": COLORS.figureBorder,
    "--title-font-size": px(TITLE_TYPOGRAPHY.fontSize),
    "--title-line-height": String(TITLE_TYPOGRAPHY.lineHeight),
    "--title-letter-spacing": `${TITLE_TYPOGRAPHY.letterSpacingEm}em`,
    "--label-font-size": px(LABEL_TYPOGRAPHY.fontSize),
    "--label-line-height": String(LABEL_TYPOGRAPHY.lineHeight),
    "--label-padding": `${px(LABEL_TYPOGRAPHY.padV)} ${px(LABEL_TYPOGRAPHY.padH)}`,
    "--label-letter-spacing": `${LABEL_TYPOGRAPHY.letterSpacingEm}em`,
    "--body-font-size": px(BODY_TYPOGRAPHY.fontSize),
    "--body-line-height": String(BODY_TYPOGRAPHY.lineHeight),
    "--body-padding": `${px(BODY_TYPOGRAPHY.padV)} ${px(BODY_TYPOGRAPHY.padH)}`,
    "--body-letter-spacing": `${BODY_TYPOGRAPHY.letterSpacingEm}em`,
    "--code-font-size": px(CODE_TYPOGRAPHY.fontSize),
    "--code-line-height": String(CODE_TYPOGRAPHY.lineHeight),
    "--content-left": px(TABLE_SPEC.left),
    "--content-width": px(TABLE_SPEC.width),
    "--table-panel-padding": `${px(TABLE_SPEC.padding.top)} ${px(TABLE_SPEC.padding.x)} ${px(TABLE_SPEC.padding.bottom)}`,
    "--table-label-width": px(TABLE_SPEC.labelWidthPx),
    "--table-column-gap": px(TABLE_SPEC.columnGapPx),
    "--mixed-top": px(TABLE_IMAGE_SPEC.top),
    "--mixed-height": px(TABLE_IMAGE_SPEC.height),
    "--mixed-table-width": px(TABLE_IMAGE_SPEC.tableWidth),
    "--mixed-column-gap": px(TABLE_IMAGE_SPEC.columnGap),
    "--mixed-figure-width": px(TABLE_IMAGE_SPEC.figureWidth),
    "--mixed-panel-padding": px(TABLE_IMAGE_SPEC.panelPadding),
    "--mixed-label-width": px(TABLE_IMAGE_SPEC.labelWidthPx),
    "--mixed-row-column-gap": px(TABLE_IMAGE_SPEC.rowColumnGapPx),
    "--figure-padding": px(TABLE_IMAGE_SPEC.figurePadding),
    "--figure-radius": px(TABLE_IMAGE_SPEC.figureBorderRadius),
    "--table-images-top": px(TABLE_IMAGES_SPEC.top),
    "--table-images-height": px(TABLE_IMAGES_SPEC.height),
    "--table-images-panel-padding": `${px(TABLE_IMAGES_SPEC.padding.top)} ${px(TABLE_IMAGES_SPEC.padding.x)} ${px(TABLE_IMAGES_SPEC.padding.bottom)}`,
    "--table-images-figures-gap": px(TABLE_IMAGES_SPEC.figuresGap),
    "--table-images-figure-column-width": px(TABLE_IMAGES_SPEC.figureColumnWidth),
    "--table-images-figure-title-font-size": px(TABLE_IMAGES_SPEC.figureTitle.fontSize),
    "--table-images-figure-title-line-height": String(TABLE_IMAGES_SPEC.figureTitle.lineHeight),
    "--table-images-figure-title-gap": px(TABLE_IMAGES_SPEC.figureTitle.gap),
    "--cover-text-padding-x": px(TITLE_SPEC.textPaddingX),
    "--cover-title-font-size": px(TITLE_SPEC.title.fontSize),
    "--cover-title-line-height": String(TITLE_SPEC.title.lineHeight),
    "--cover-title-letter-spacing": `${TITLE_SPEC.title.letterSpacingEm}em`,
    "--cover-subtitle-font-size": px(TITLE_SPEC.subtitle.fontSize),
    "--cover-subtitle-line-height": String(TITLE_SPEC.subtitle.lineHeight),
    "--cover-subtitle-gap": px(TITLE_SPEC.subtitle.gap),
    "--cover-credits-font-size": px(TITLE_SPEC.credits.fontSize),
    "--cover-credits-line-height": String(TITLE_SPEC.credits.lineHeight),
    "--cover-credits-padding-x": px(TITLE_SPEC.credits.paddingX),
    "--bullet-l2-font-size": px(bulletLevelSpec(1).fontSize),
    "--bullet-l2-line-height": String(bulletLevelSpec(1).lineHeight),
    "--bullet-l2-indent": px(bulletLevelSpec(1).indentPx),
    "--bullet-l2-marker": JSON.stringify(bulletLevelSpec(1).marker),
    "--bullet-l3-font-size": px(bulletLevelSpec(2).fontSize),
    "--bullet-l3-line-height": String(bulletLevelSpec(2).lineHeight),
    "--bullet-l3-indent": px(bulletLevelSpec(2).indentPx),
    "--bullet-l3-marker": JSON.stringify(bulletLevelSpec(2).marker),
  };
}
