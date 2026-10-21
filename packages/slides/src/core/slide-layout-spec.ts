/**
 * スライド幾何の単一ソース（v1 のスライドエンジンから残したもの）。
 *
 * - スライド v2 の幾何（canvas/canvas-slide-layout.ts）とテーマ（canvas/canvas-slide-theme.ts）は、ここの値と computeSlideGeometry から作る。
 * - 行の容量の規則（slide-row-capacity.ts）は getLayoutProfile から寸法を得る。
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
  /**
   * 詰めた配置（table・bullets）。標準の配置（compact・全高）に入らない行数のときだけ使う。
   * パネルを上下に広げ、上下の余白と行の間隔を詰める。入る行数は 1 行の最低の高さ（文字の大きさで決まる）から出す（maxTightRowCount）
   */
  tight: { titleTop: 58, panelTop: 126, panelHeight: 880, paddingV: 40, gapPx: 17 },
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

/** table-image の左表パネルの幅の範囲。下限は本文の列が 100px 残る幅、上限は右図枠が 240px 残る幅 */
export const TABLE_IMAGE_WIDTH_RANGE = { min: 400, max: 1400 } as const;

/** table-image の左表パネルの幅。数でなければ既定の幅、範囲外なら範囲に収める */
export function clampTableImageWidth(width: number | undefined): number {
  if (typeof width !== "number" || !Number.isFinite(width)) return TABLE_IMAGE_SPEC.tableWidth;
  return Math.min(TABLE_IMAGE_WIDTH_RANGE.max, Math.max(TABLE_IMAGE_WIDTH_RANGE.min, width));
}

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
  /** table-image の左表パネルの幅（手で決めた幅）。無ければ TABLE_IMAGE_SPEC.tableWidth。範囲は clampTableImageWidth で収める */
  tableWidth?: number;
  /**
   * 表パネル（灰色の外枠）の高さ（手で決めた高さ）。決めれば compact の規則を使わず、パネルは全高のときの上端
   * （tablePanelTop）から下へこの高さになり、行はこの中で配分する。範囲は clampTablePanelHeight で収める。forceFull より優先する
   */
  tableHeight?: number;
  /**
   * タイトルが 1 行より高い分（2 行以上に折り返した・改行したときの、増えた高さ）。無ければ 0。
   * タイトルの下端（パネルとの間隔）は変えずに、タイトルを上へ伸ばす。compact の table / bullets は、
   * タイトルとパネルをまとめて上下中央に寄せ直す（パネルも増えた分の半分だけ下がる）。タイトルの上端はスライドの上端（0）より上に出さない
   */
  titleExtraPx?: number;
  /**
   * 1 行の最低の高さ（行のセルの文字 1 行分の高さ＋上下の余白。呼び出し側が描画と同じ配置で測る）。無ければ minRowPx。
   * 詰めた配置に入る行数の上限と、詰めた配置での行の高さの下限に使う（標準の配置の行数・幾何には使わない）
   */
  rowFloorPx?: number;
};

/** タイトルの増えた高さ（数でない・負のものは 0） */
function titleExtraOf(options: GeometryOptions): number {
  const extra = options.titleExtraPx;
  return typeof extra === "number" && Number.isFinite(extra) && extra > 0 ? extra : 0;
}

export type SlideGeometry = {
  layout: SlideLayout;
  rowCount: number;
  compact: boolean;
  /** 詰めた配置（TABLE_SPEC.tight）か。table・bullets で標準の配置に入らない行数のとき */
  tight: boolean;
  /** タイトルの上端。titleExtraPx があれば、その分だけ上（compact の table / bullets は上下中央に寄せ直した位置） */
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

/** 表パネルの上下の padding（パネルの高さ − 行グリッドの予算） */
function panelPaddingV(layout: SlideLayout, rowCount: number): number {
  if (isTightRowCount(layout, rowCount)) return TABLE_SPEC.tight.paddingV * 2;
  switch (layout) {
    case "table-image":
      return TABLE_IMAGE_SPEC.panelPadding * 2;
    case "table-images":
      return TABLE_IMAGES_SPEC.padding.top + TABLE_IMAGES_SPEC.padding.bottom;
    default:
      return TABLE_SPEC.padding.top + TABLE_SPEC.padding.bottom;
  }
}

/** 高さを手で決めた表パネルの行の間隔（全高パネルの間隔。詰めた配置なら詰めた間隔） */
function fixedHeightGapPx(layout: SlideLayout, rowCount: number): number {
  if (isTightRowCount(layout, rowCount)) return TABLE_SPEC.tight.gapPx;
  switch (layout) {
    case "table-image":
      return TABLE_IMAGE_SPEC.fullGapPx;
    case "table-images":
      return TABLE_IMAGES_SPEC.gapPx;
    default:
      return TABLE_SPEC.fullGapPx;
  }
}

/**
 * 高さを手で決めた表パネルの上端（全高パネルの上端。ずらす前。詰めた配置の行数なら詰めた配置の上端）。
 * 行グリッドを持たないレイアウトでは例外
 */
export function tablePanelTop(layout: SlideLayout, rowCount = 1): number {
  if (isTightRowCount(layout, rowCount)) return TABLE_SPEC.tight.panelTop;
  switch (layout) {
    case "table":
    case "bullets":
      return TABLE_SPEC.fullPanelTop;
    case "table-image":
      return TABLE_IMAGE_SPEC.top;
    case "table-images":
      return TABLE_IMAGES_SPEC.top;
    case "title":
      throw new Error("title レイアウトは表パネルを持ちません。");
  }
}

/**
 * 表パネルの高さを手で決めるときの範囲。
 * 下限は行がみな 1 視覚行分（minRowPx）の高さで入る高さ。上限は、パネルの下端がスライドの下端まで
 * （table-images は下の図の領域が minFiguresHeightPx 残る高さ）
 */
export function tablePanelHeightRange(layout: SlideLayout, rowCount: number): { min: number; max: number } {
  const rows = Math.max(1, rowCount);
  const min = rows * minRowPx() + (rows - 1) * fixedHeightGapPx(layout, rows) + panelPaddingV(layout, rows);
  const max =
    layout === "table-images"
      ? TABLE_IMAGES_SPEC.height - TABLE_IMAGES_SPEC.minFiguresHeightPx
      : SLIDE_HEIGHT - tablePanelTop(layout, rows);
  return { min: Math.min(min, max), max };
}

/** 表パネルの手で決めた高さを範囲に収める（1px に丸める）。数でなければ undefined（高さは行数と内容から決める） */
export function clampTablePanelHeight(
  layout: SlideLayout,
  rowCount: number,
  height: number | undefined,
): number | undefined {
  if (typeof height !== "number" || !Number.isFinite(height)) return undefined;
  const { min, max } = tablePanelHeightRange(layout, rowCount);
  return Math.round(Math.min(max, Math.max(min, height)));
}

/** 高さを手で決めた表パネルの、行グリッドの縦の値（compact にしない） */
function fixedHeightRows(
  layout: SlideLayout,
  rowCount: number,
  panelHeight: number,
): { budgetPx: number; gapPx: number; rowPx: number } {
  const gapPx = fixedHeightGapPx(layout, rowCount);
  const budgetPx = panelHeight - panelPaddingV(layout, rowCount);
  const rowPx = Math.round((budgetPx - (rowCount - 1) * gapPx) / rowCount);
  return { budgetPx, gapPx, rowPx };
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
  const fixedHeight = clampTablePanelHeight(layout, rowCount, options.tableHeight);
  const compact = fixedHeight === undefined && !options.forceFull && natural + padV <= s.fullPanelHeight;

  let panelHeight: number;
  let panelTop: number;
  let titleTop: number;
  let rowPx: number;
  let gapPx: number;
  const extra = titleExtraOf(options);

  if (fixedHeight !== undefined) {
    panelHeight = fixedHeight;
    panelTop = s.fullPanelTop;
    titleTop = Math.max(0, s.fullTitleTop - extra);
    ({ rowPx, gapPx } = fixedHeightRows(layout, rowCount, panelHeight));
  } else if (compact) {
    panelHeight = natural + padV;
    // タイトルが増えた分も含めて、タイトルとパネルをまとめて上下中央に寄せる
    const block = extra + s.compactTitleBand + panelHeight;
    titleTop = Math.max(0, Math.round((SLIDE_HEIGHT - block) / 2));
    panelTop = titleTop + extra + s.compactTitleBand;
    rowPx = s.compactRowPx;
    gapPx = s.compactGapPx;
  } else {
    panelHeight = s.fullPanelHeight;
    panelTop = s.fullPanelTop;
    titleTop = Math.max(0, s.fullTitleTop - extra);
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
    tight: false,
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

/**
 * 詰めた配置（TABLE_SPEC.tight）の全幅パネルの幾何。標準の配置に入らない行数の table・bullets で使う。
 * タイトル・パネルの位置は固定（compact のように上下中央に寄せない）。タイトルが 2 行以上なら上へ伸ばす。
 * 高さを手で決めれば、パネルは詰めた配置の上端から下へその高さになる（上下の余白・行の間隔は詰めた配置のまま）
 */
function tightPanelGeometry(
  layout: "table" | "bullets",
  rowCount: number,
  options: GeometryOptions = {},
): SlideGeometry {
  const s = TABLE_SPEC;
  const t = s.tight;
  const padV = t.paddingV * 2;
  const panelHeight = clampTablePanelHeight(layout, rowCount, options.tableHeight) ?? t.panelHeight;
  const budgetPx = panelHeight - padV;
  const rowPx = Math.round((budgetPx - (rowCount - 1) * t.gapPx) / rowCount);
  const contentWidthPx = s.width - s.padding.x * 2;
  const labelWidthPx = layout === "bullets" ? 0 : s.labelWidthPx;
  const columnGapPx = layout === "bullets" ? 0 : s.columnGapPx;
  return {
    layout,
    rowCount,
    compact: false,
    tight: true,
    titleTop: Math.max(0, t.titleTop - titleExtraOf(options)),
    panelTop: t.panelTop,
    panelHeight,
    grid: {
      rowCount,
      defaultRowPx: rowPx,
      gapPx: t.gapPx,
      budgetPx,
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
  const fixedHeight = clampTablePanelHeight("table-image", rowCount, options.tableHeight);
  const compact = fixedHeight === undefined && !options.forceFull && natural + tablePadV <= s.height;
  const panelHeight = fixedHeight ?? (compact ? natural + tablePadV : s.height);
  // 左表パネルは右図枠（高さ s.height）内で上下中央（align-self: center）。高さを手で決めたら右図枠の上端にそろえる
  const panelTop = fixedHeight !== undefined ? s.top : s.top + Math.round((s.height - panelHeight) / 2);
  const titleTop = Math.max(0, (compact ? panelTop - s.compactTitleBand : s.fullTitleTop) - titleExtraOf(options));
  const budgetPx = panelHeight - s.panelPadding * 2;

  let rowPx: number;
  let gapPx: number;
  const override = compact ? s.compactOverrides[rowCount] : undefined;
  if (fixedHeight !== undefined) {
    ({ rowPx, gapPx } = fixedHeightRows("table-image", rowCount, panelHeight));
  } else if (override) {
    rowPx = override.rowPx;
    gapPx = override.gapPx;
  } else {
    gapPx = compact ? s.compactGapPx : s.fullGapPx;
    rowPx = Math.round((budgetPx - (rowCount - 1) * gapPx) / rowCount);
  }

  const contentWidthPx = clampTableImageWidth(options.tableWidth) - s.panelPadding * 2;
  return {
    layout: "table-image",
    rowCount,
    compact,
    tight: false,
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

function tableImagesGeometry(rowCount: number, options: GeometryOptions = {}): SlideGeometry {
  const s = TABLE_IMAGES_SPEC;
  const padV = s.padding.top + s.padding.bottom;
  const fixedHeight = clampTablePanelHeight("table-images", rowCount, options.tableHeight);
  const fixedRows = fixedHeight !== undefined ? fixedHeightRows("table-images", rowCount, fixedHeight) : undefined;
  const budgetPx = fixedRows?.budgetPx ?? rowCount * s.rowPx + (rowCount - 1) * s.gapPx;
  const panelHeight = budgetPx + padV;
  const contentWidthPx = s.width - s.padding.x * 2;
  return {
    layout: "table-images",
    rowCount,
    compact: false,
    tight: false,
    titleTop: Math.max(0, s.titleTop - titleExtraOf(options)),
    panelTop: s.top,
    panelHeight,
    figuresHeightPx: s.height - panelHeight,
    grid: {
      rowCount,
      defaultRowPx: fixedRows?.rowPx ?? s.rowPx,
      gapPx: s.gapPx,
      budgetPx,
      contentWidthPx,
      labelWidthPx: s.labelWidthPx,
      bodyWidthPx: contentWidthPx - s.labelWidthPx - s.columnGapPx,
      columnGapPx: s.columnGapPx,
    },
  };
}

/** 標準の配置（compact・全高）の幾何 */
function standardGeometry(
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
      return tableImagesGeometry(rowCount, options);
    case "title":
      throw new Error("title レイアウトは行グリッドを持ちません。");
  }
}

/** 標準の配置に入らない行数なら、詰めた配置（table・bullets だけ） */
function rawGeometry(
  layout: SlideLayout,
  rowCount: number,
  options: GeometryOptions = {},
): SlideGeometry {
  if ((layout === "table" || layout === "bullets") && isTightRowCount(layout, rowCount)) {
    return tightPanelGeometry(layout, rowCount, options);
  }
  return standardGeometry(layout, rowCount, options);
}

/** 標準の配置で、行がみな 1 視覚行分（minRowPx）の高さで入るか */
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
const standardMaxCache = new Map<SlideLayout, number>();

/** 標準の配置（compact・全高）に入る最大行数（列挙ではなく計算で導出。文字の大きさによらない） */
export function getStandardMaxRowCount(layout: SlideLayout): number {
  if (!layoutUsesRowGrid(layout)) {
    return 0;
  }
  const cached = standardMaxCache.get(layout);
  if (cached !== undefined) {
    return cached;
  }
  let max = 0;
  for (let n = 1; n <= MAX_ROW_COUNT_SEARCH; n += 1) {
    if (!isFeasible(standardGeometry(layout, n))) {
      break;
    }
    max = n;
  }
  standardMaxCache.set(layout, max);
  return max;
}

/** 標準の配置に入らず、詰めた配置にする行数か（table・bullets だけ） */
export function isTightRowCount(layout: SlideLayout, rowCount: number): boolean {
  return (layout === "table" || layout === "bullets") && rowCount > getStandardMaxRowCount(layout);
}

/** 1 行の最低の高さ（rowFloorPx。無い・数でないものは minRowPx）。1px に切り上げる */
export function rowFloorOf(rowFloorPx: number | undefined): number {
  return typeof rowFloorPx === "number" && Number.isFinite(rowFloorPx) && rowFloorPx > 0 ? Math.ceil(rowFloorPx) : minRowPx();
}

/** 詰めた配置に入る行数：floor((行に使える高さ + 間隔) / (1 行の最低の高さ + 間隔)) */
export function maxTightRowCount(rowFloorPx?: number): number {
  const t = TABLE_SPEC.tight;
  return Math.floor((t.panelHeight - t.paddingV * 2 + t.gapPx) / (rowFloorOf(rowFloorPx) + t.gapPx));
}

/**
 * レイアウトの最大行数。table・bullets は、標準の配置に入る行数と、詰めた配置に入る行数（1 行の最低の高さ rowFloorPx で決まる）の
 * 大きい方（標準の配置に入る行数より減らさない）。table-image・table-images は標準の配置に入る行数
 */
export function getMaxRowCount(layout: SlideLayout, rowFloorPx?: number): number {
  const standard = getStandardMaxRowCount(layout);
  if (layout !== "table" && layout !== "bullets") {
    return standard;
  }
  return Math.max(standard, maxTightRowCount(rowFloorPx));
}

export function isValidRowCount(layout: SlideLayout, rowCount: number, rowFloorPx?: number): boolean {
  return Number.isInteger(rowCount) && rowCount >= 1 && rowCount <= getMaxRowCount(layout, rowFloorPx);
}

export function rowCountRangeMessage(
  layout: SlideLayout,
  rowCount: number,
  keyName = "rows",
  rowFloorPx?: number,
): string {
  return `${layout} レイアウトでは ${keyName} は 1〜${getMaxRowCount(layout, rowFloorPx)} 件にしてください（現在 ${rowCount} 件）。`;
}

export function computeSlideGeometry(
  layout: SlideLayout,
  rowCount: number,
  options: GeometryOptions = {},
): SlideGeometry {
  if (!layoutUsesRowGrid(layout)) {
    throw new Error(`${layout} レイアウトは行グリッドを持ちません。`);
  }
  if (!isValidRowCount(layout, rowCount, options.rowFloorPx)) {
    throw new Error(rowCountRangeMessage(layout, rowCount, "rows", options.rowFloorPx));
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
  /** 行の高さの下限。標準の配置は minRowPx、詰めた配置は 1 行の最低の高さ（GeometryOptions の rowFloorPx） */
  rowFloorPx: number;
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
    rowFloorPx: geometry.tight ? rowFloorOf(options.rowFloorPx) : minRowPx(),
    labelTypography: LABEL_TYPOGRAPHY,
    bodyTypography: BODY_TYPOGRAPHY,
  };
}
