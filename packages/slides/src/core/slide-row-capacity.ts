import {
  bulletLevelSpec,
  getLayoutProfile,
  lineBoxHeight,
  minRowPx,
  textWidthPx,
  TITLE_SPEC,
  type LayoutProfile,
  type SlideLayout,
  type TypographySpec,
} from "./slide-layout-spec.ts";
import { stripInlineMarkup } from "./inline-markup.ts";
import type { BulletItem } from "./slide-schema.ts";

export type SlideRowInput = {
  labelLines: string[];
  bodyLines: string[];
};

export type RowCapacityClassification = "ok" | "partial" | "uniform" | "over_budget";

export type AnalyzeSlideRowsInput = {
  layout: SlideLayout;
  rows: SlideRowInput[];
  slideName?: string;
};

export type AnalyzeSlideRowsResult = {
  classification: RowCapacityClassification;
  rowHeights: number[] | null;
  /** compact 幾何に収まらず全高パネルに切り替えたとき true（描画は forceFull で幾何を求める）。もともと全高の行数では false */
  fullPanel: boolean;
  warnings: string[];
  requiredPx: number[];
  defaultRowPx: number;
  budgetPx: number;
  gapPx: number;
};

const EPSILON_PX = 1;

function countVisualLines(text: string, charsPerLine: number): number {
  const charCount = [...stripInlineMarkup(text)].length;
  if (charCount === 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(charCount / charsPerLine));
}

/** 1 文字の送り幅。全角文字は fontSize 幅に letter-spacing が加わる（負なら詰まる） */
function charAdvancePx(typography: Pick<TypographySpec, "fontSize" | "letterSpacingEm">): number {
  return typography.fontSize * (1 + typography.letterSpacingEm);
}

function estimateColumnVisualLines(
  lines: string[],
  typography: TypographySpec,
  columnWidthPx: number,
): number {
  const charsPerLine = Math.max(
    1,
    Math.floor(textWidthPx(typography, columnWidthPx) / charAdvancePx(typography)),
  );

  return lines.reduce((total, line) => total + countVisualLines(line, charsPerLine), 0);
}

function estimateColumnRequiredPx(visualLines: number, typography: TypographySpec): number {
  return typography.padV * 2 + visualLines * lineBoxHeight(typography);
}

function estimateRowRequiredPx(row: SlideRowInput, profile: LayoutProfile): number {
  const labelVisualLines = estimateColumnVisualLines(
    row.labelLines,
    profile.labelTypography,
    profile.labelWidthPx,
  );
  const bodyVisualLines = estimateColumnVisualLines(
    row.bodyLines,
    profile.bodyTypography,
    profile.bodyWidthPx,
  );

  const labelRequiredPx = estimateColumnRequiredPx(labelVisualLines, profile.labelTypography);
  const bodyRequiredPx = estimateColumnRequiredPx(bodyVisualLines, profile.bodyTypography);

  return Math.ceil(Math.max(labelRequiredPx, bodyRequiredPx));
}

function totalGapsPx(profile: LayoutProfile): number {
  return (profile.rowCount - 1) * profile.gapPx;
}

function minimumRequiredSum(requiredPx: number[], minRowPxValue: number): number {
  return requiredPx.reduce((sum, value) => sum + Math.max(Math.ceil(value), minRowPxValue), 0);
}

function rebalancePartialHeights(
  requiredPx: number[],
  profile: LayoutProfile,
  minRowPxValue: number,
): number[] | null {
  const n = requiredPx.length;
  const gaps = totalGapsPx(profile);
  const budgetForRows = profile.budgetPx - gaps;

  const heights = requiredPx.map((value) => Math.max(Math.ceil(value), minRowPxValue));

  let sum = heights.reduce((total, height) => total + height, 0);
  if (sum > budgetForRows) {
    return null;
  }

  const leftover = budgetForRows - sum;

  if (leftover > 0) {
    const baseAdd = Math.floor(leftover / n);
    let remainder = leftover - baseAdd * n;
    for (let i = 0; i < n; i += 1) {
      heights[i] = (heights[i] ?? 0) + baseAdd;
    }
    for (let i = 0; remainder > 0; i = (i + 1) % n) {
      heights[i] = (heights[i] ?? 0) + 1;
      remainder -= 1;
    }
  }

  sum = heights.reduce((total, height) => total + height, 0);
  const diff = budgetForRows - sum;
  if (diff !== 0) {
    const lastIndex = n - 1;
    const adjusted = (heights[lastIndex] ?? 0) + diff;
    if (adjusted < minRowPxValue) {
      return null;
    }
    heights[lastIndex] = adjusted;
  }

  sum = heights.reduce((total, height) => total + height, 0);
  if (sum + gaps !== profile.budgetPx) {
    return null;
  }

  for (const height of heights) {
    if (height < minRowPxValue) {
      return null;
    }
  }

  return heights;
}

function formatSlideRef(slideName?: string): string {
  return slideName ? `（name=${slideName}）` : "";
}

function buildWarnings(
  classification: RowCapacityClassification,
  requiredPx: number[],
  profile: LayoutProfile,
  slideName: string | undefined,
  rowHeights: number[] | null,
): string[] {
  const ref = formatSlideRef(slideName);
  const warnings: string[] = [];
  const overDefaultIndices = requiredPx
    .map((value, index) => (value > profile.defaultRowPx + EPSILON_PX ? index + 1 : null))
    .filter((index): index is number => index !== null);

  if (classification === "ok") {
    return warnings;
  }

  if (classification === "over_budget") {
    const minSum = minimumRequiredSum(requiredPx, minRowPx()) + totalGapsPx(profile);
    warnings.push(
      `警告: スライド${ref} — 合計必要高さ ${minSum}px が予算 ${profile.budgetPx}px を超過しています。文案の短縮を検討してください。`,
    );
    return warnings;
  }

  if (classification === "uniform") {
    warnings.push(
      `警告: スライド${ref} — 行全体で均一に容量超過（${overDefaultIndices.length}/${requiredPx.length} 行が既定行高 ${profile.defaultRowPx}px を超過）。行高リバランス不可。文案の短縮を検討してください。`,
    );
    return warnings;
  }

  if (classification === "partial") {
    const overRows = overDefaultIndices.join("、");
    warnings.push(
      `警告: スライド${ref} — partial 超過。行 ${overRows} が既定行高 ${profile.defaultRowPx}px を超過。行高リバランスを適用します。`,
    );
    if (rowHeights) {
      warnings.push(
        `情報: スライド${ref} — リバランス後行高 [${rowHeights.join(", ")}]px（gap ${profile.gapPx}px 固定）`,
      );
    }
  }

  return warnings;
}

/** 必要高さの配列を ok / partial / uniform / over_budget に分類し、partial なら行高を再配分する */
function classifyRowCapacity(
  profile: LayoutProfile,
  requiredPx: number[],
  slideName: string | undefined,
): AnalyzeSlideRowsResult {
  const minRowPxValue = minRowPx();

  const base = {
    requiredPx,
    defaultRowPx: profile.defaultRowPx,
    budgetPx: profile.budgetPx,
    gapPx: profile.gapPx,
    // 全高への切り替えは classifyWithFullPanelFallback だけが true にする（もともと全高の行数では false のまま）
    fullPanel: false,
  };

  const allWithinDefault = requiredPx.every(
    (value) => value <= profile.defaultRowPx + EPSILON_PX,
  );

  if (allWithinDefault) {
    return { classification: "ok", rowHeights: null, warnings: [], ...base };
  }

  const overDefaultCount = requiredPx.filter(
    (value) => value > profile.defaultRowPx + EPSILON_PX,
  ).length;

  const minSum = minimumRequiredSum(requiredPx, minRowPxValue) + totalGapsPx(profile);

  if (minSum > profile.budgetPx) {
    const majorityOver = overDefaultCount >= Math.ceil(requiredPx.length * 0.75);
    const allOver = overDefaultCount === requiredPx.length;
    const classification: RowCapacityClassification =
      allOver || majorityOver ? "uniform" : "over_budget";

    const warnings = buildWarnings(classification, requiredPx, profile, slideName, null);
    return { classification, rowHeights: null, warnings, ...base };
  }

  const underDefaultCount = requiredPx.length - overDefaultCount;

  const rowHeights = rebalancePartialHeights(requiredPx, profile, minRowPxValue);

  if (rowHeights && overDefaultCount > 0 && underDefaultCount > 0) {
    const warnings = buildWarnings("partial", requiredPx, profile, slideName, rowHeights);
    return { classification: "partial", rowHeights, warnings, ...base };
  }

  const classification: RowCapacityClassification =
    rowHeights === null ? "over_budget" : "uniform";

  const warnings = buildWarnings(classification, requiredPx, profile, slideName, null);

  return { classification, rowHeights: null, warnings, ...base };
}

function fitsGrid(result: AnalyzeSlideRowsResult): boolean {
  return result.classification === "ok" || result.classification === "partial";
}

/**
 * compact 幾何（行数だけで決まる小さいパネル）に収まらないときは、全高パネルで見積もり直す。
 * 全高で収まれば fullPanel: true の結果を返し、compact の警告は出さない。全高でも収まらなければ compact の結果をそのまま返す
 */
function classifyWithFullPanelFallback(
  layout: SlideLayout,
  rowCount: number,
  estimate: (profile: LayoutProfile) => number[],
  slideName: string | undefined,
): AnalyzeSlideRowsResult {
  const profile = getLayoutProfile(layout, rowCount);
  const result = classifyRowCapacity(profile, estimate(profile), slideName);
  if (fitsGrid(result) || !profile.compact) {
    return result;
  }
  const fullProfile = getLayoutProfile(layout, rowCount, { forceFull: true });
  const fullResult = classifyRowCapacity(fullProfile, estimate(fullProfile), slideName);
  if (!fitsGrid(fullResult)) {
    return result;
  }
  const ref = formatSlideRef(slideName);
  return {
    ...fullResult,
    fullPanel: true,
    warnings: [
      `情報: スライド${ref} — 内容が compact パネル（予算 ${profile.budgetPx}px）に収まらないため、全高パネル（予算 ${fullProfile.budgetPx}px）で描画します。`,
      ...fullResult.warnings,
    ],
  };
}

export function analyzeSlideRows(input: AnalyzeSlideRowsInput): AnalyzeSlideRowsResult {
  return classifyWithFullPanelFallback(
    input.layout,
    input.rows.length,
    (profile) => input.rows.map((row) => estimateRowRequiredPx(row, profile)),
    input.slideName,
  );
}

// ---------------------------------------------------------------------------
// 箇条書き（bullets レイアウト）: 項目ごとの必要高を階層別フォントで見積もる
// ---------------------------------------------------------------------------

export type AnalyzeBulletItemsInput = {
  items: BulletItem[];
  slideName?: string;
};

function estimateBulletItemRequiredPx(item: BulletItem, profile: LayoutProfile): number {
  const textWidth = textWidthPx(profile.bodyTypography, profile.bodyWidthPx);
  let total = 0;

  const walk = (node: BulletItem, depth: number): void => {
    const level = bulletLevelSpec(depth);
    const charsPerLine = Math.max(
      1,
      Math.floor(
        (textWidth - level.indentPx) /
          charAdvancePx({ fontSize: level.fontSize, letterSpacingEm: profile.bodyTypography.letterSpacingEm }),
      ),
    );
    const text = typeof node === "string" ? node : node.text;
    total += countVisualLines(text, charsPerLine) * level.fontSize * level.lineHeight;
    if (typeof node !== "string") {
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    }
  };

  walk(item, 0);
  return Math.ceil(profile.bodyTypography.padV * 2 + total);
}

export function analyzeBulletItems(input: AnalyzeBulletItemsInput): AnalyzeSlideRowsResult {
  return classifyWithFullPanelFallback(
    "bullets",
    input.items.length,
    (profile) => input.items.map((item) => estimateBulletItemRequiredPx(item, profile)),
    input.slideName,
  );
}

// ---------------------------------------------------------------------------
// 表紙（title レイアウト）の文字数 lint
// ---------------------------------------------------------------------------

export type AnalyzeTitleSlideInput = {
  title: string;
  subtitle?: string[];
  credits?: string[];
  slideName?: string;
};

export type AnalyzeTitleSlideResult = {
  titleLines: number;
  subtitleLines: number;
  creditLines: number;
  warnings: string[];
};

function estimateVisualLines(lines: string[], fontSize: number, widthPx: number): number {
  const charsPerLine = Math.max(1, Math.floor(widthPx / fontSize));
  return lines.reduce((total, line) => total + countVisualLines(line, charsPerLine), 0);
}

/** 表紙のタイトル・副題・credits が推奨行数に収まるか推定し、超過を警告する（出力は継続） */
export function analyzeTitleSlide(input: AnalyzeTitleSlideInput): AnalyzeTitleSlideResult {
  const s = TITLE_SPEC;
  const ref = formatSlideRef(input.slideName);
  const textWidth = s.width - s.textPaddingX * 2;
  const creditsWidth = s.width - s.credits.paddingX * 2;

  const titleLines = estimateVisualLines([input.title], s.title.fontSize, textWidth);
  const subtitleLines = input.subtitle
    ? estimateVisualLines(input.subtitle, s.subtitle.fontSize, textWidth)
    : 0;
  const creditLines = input.credits
    ? estimateVisualLines(input.credits, s.credits.fontSize, creditsWidth)
    : 0;

  const warnings: string[] = [];
  if (titleLines > s.title.maxLines) {
    warnings.push(
      `警告: スライド${ref} — 表紙タイトルが約 ${titleLines} 行になります（推奨 ${s.title.maxLines} 行以内）。短縮を検討してください。`,
    );
  }
  if (subtitleLines > s.subtitle.maxLines) {
    warnings.push(
      `警告: スライド${ref} — 表紙の副題が約 ${subtitleLines} 行になります（推奨 ${s.subtitle.maxLines} 行以内）。短縮を検討してください。`,
    );
  }
  if (creditLines > s.credits.maxLines) {
    warnings.push(
      `警告: スライド${ref} — 表紙の credits が約 ${creditLines} 行あり、灰帯（${s.credits.maxLines} 行分）に収まらない可能性があります。`,
    );
  }

  return { titleLines, subtitleLines, creditLines, warnings };
}
