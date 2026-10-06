/**
 * 行の容量の規則（v1 のスライドエンジンから残したもの）。スライド v2 の行の高さの配分（canvas/canvas-slide-rows.ts）が使う。
 *
 * - 行ごとの必要高さを ok / partial / uniform / over_budget に分類し、partial なら予算の中で行の高さを配り直す。
 * - compact パネルに収まらなければ、全高パネルで分類し直す。
 * - 必要高さは呼び出し側（v2 は描画と同じ配置で測った高さ）が渡す。
 */

import {
  getLayoutProfile,
  minRowPx,
  type LayoutProfile,
  type SlideLayout,
} from "./slide-layout-spec.ts";

export type RowCapacityClassification = "ok" | "partial" | "uniform" | "over_budget";

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

/**
 * 行ごとの必要高さを呼び出し側が測って渡し、分類・partial の再配分・全高パネルへの切り替えの規則を通す。
 * スライド v2（キャンバスのスライド）が、描画と同じ配置で測った高さで使う。
 * measure は幾何（compact / 全高）ごとに呼ばれる。行の幅はどちらも同じなので、同じ値を返してよい
 */
export function analyzeMeasuredRows(
  layout: SlideLayout,
  rowCount: number,
  measure: (profile: LayoutProfile) => number[],
  slideName?: string,
): AnalyzeSlideRowsResult {
  return classifyWithFullPanelFallback(layout, rowCount, measure, slideName);
}
