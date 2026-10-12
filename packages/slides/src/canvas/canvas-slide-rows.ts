/**
 * スライド v2：表・箇条書き・表＋画像の行の高さを、パネルの中で配分する（DOM に依存しない純関数）。
 *
 * - 自動（既定）：行ごとの必要高さ（呼び出し側が描画と同じ配置で測った、文字の高さ＋上下の余白）を、
 *   v1 の行容量の規則（analyzeMeasuredRows。v1 の lint と同じ分類と再配分）に通す。
 *   - ok（全部の行が一律の高さに収まる）：v1 の defaultRowPx を一律に使う（今までと同じ見た目）
 *   - partial（収まらない行と収まる行がある）：v1 の再配分（rowHeights）を使う
 *   - uniform / over_budget（配分しても収まらない）：v1 と同じく一律にして、あふれは警告に任せる
 *   - compact のパネルに収まらず、全高のパネルなら収まるときは、全高のパネルにする（v1 の computedFullPanel → forceFull）
 * - 手で決めた行（fixed）：その高さを優先し、残りを自動の行で分ける。全高にするかは、手で決めた行の必要高さを
 *   その高さとして、上の規則で決める。配分の規則は distributeWithFixed に書く。
 * - 表パネルの高さを手で決めた（options.tableHeight）ときは、compact / 全高を選ばず、その高さの予算で同じ規則で配分する。
 */

import { analyzeMeasuredRows, type RowCapacityClassification } from "../core/slide-row-capacity.ts";
import { getLayoutProfile, minRowPx, type GeometryOptions, type LayoutProfile } from "../core/slide-layout-spec.ts";
import type { CanvasGridSlideLayout } from "./canvas-slide-layout.ts";

export type CanvasSlideRowHeights = {
  /** 行ごとの高さ（canvasSlideLayout の rowHeights に渡す） */
  rowHeights: number[];
  /** 全高のパネルにするか（canvasSlideLayout の forceFull に渡す） */
  forceFull: boolean;
  /** v1 の分類（手で決めた行の高さを必要高さとして数えたもの） */
  classification: RowCapacityClassification;
};

/**
 * 行の高さを配分する。required は行ごとの必要高さ（自動の行に使う）、fixed は手で決めた高さ（無い行は undefined）。
 * options.tableHeight は手で決めた表パネルの高さ（canvasSlideLayout にも同じ値を渡す）。
 * 行数は 1 から getMaxRowCount(layout) まで（幾何と同じく、外れれば例外）
 */
export function canvasSlideRowHeights(
  layout: CanvasGridSlideLayout,
  required: readonly number[],
  fixed: readonly (number | undefined)[] = [],
  options: Pick<GeometryOptions, "tableHeight"> = {},
): CanvasSlideRowHeights {
  const manual = required.map((_, i) => validHeight(fixed[i]));
  const needs = required.map((value, i) => manual[i] ?? value);
  const { tableHeight } = options;
  const analysis = analyzeMeasuredRows(layout, required.length, () => needs, undefined, { tableHeight });
  const forceFull = analysis.fullPanel;
  const profile = getLayoutProfile(layout, required.length, { forceFull, tableHeight });
  const { classification } = analysis;
  if (manual.every((h) => h === undefined)) {
    const rowHeights =
      classification === "partial" && analysis.rowHeights
        ? analysis.rowHeights
        : required.map(() => profile.defaultRowPx);
    return { rowHeights, forceFull, classification };
  }
  return { rowHeights: distributeWithFixed(profile, required, manual), forceFull, classification };
}

function validHeight(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 手で決めた行があるときの配分。行に使える高さ（予算 − 行の間隔）を、次の順に分ける。
 * 1. 手で決めた行はその高さ、自動の行は必要高さ（v1 の minRowPx より低くはしない）。余りは自動の行で等しく分ける
 *    （v1 の再配分と同じく 1px 単位で、端数は上の行から足す）。自動の行が無ければ、余りは下に空けておく
 * 2. 入らなければ、自動の行を必要高さの大きい行から縮める（低い行は必要高さのまま、高い行をそろえて詰める）。最小は minRowPx
 * 3. 自動の行をすべて minRowPx にしても入らなければ、手で決めた行を高さの比で縮めて収める（文字のあふれは警告に任せる）
 */
function distributeWithFixed(
  profile: LayoutProfile,
  required: readonly number[],
  manual: readonly (number | undefined)[],
): number[] {
  const budget = profile.budgetPx - (required.length - 1) * profile.gapPx;
  const floor = minRowPx();
  const auto = required.flatMap((_, i) => (manual[i] === undefined ? [i] : []));
  const manualSum = manual.reduce<number>((sum, h) => sum + (h ?? 0), 0);
  const heights = required.map((value, i) => manual[i] ?? Math.max(Math.ceil(value), floor));
  const autoSum = auto.reduce((sum, i) => sum + heights[i]!, 0);

  // 1. そのまま入る
  if (manualSum + autoSum <= budget) {
    if (auto.length === 0) return heights;
    const leftover = Math.floor(budget - manualSum - autoSum);
    const share = Math.floor(leftover / auto.length);
    let remainder = leftover - share * auto.length;
    for (const i of auto) {
      heights[i] = heights[i]! + share + (remainder > 0 ? 1 : 0);
      remainder -= 1;
    }
    return heights;
  }

  // 2. 自動の行を縮めれば入る：高い行から同じ高さ（level）にそろえて詰める
  const autoRoom = budget - manualSum;
  if (auto.length > 0 && autoRoom >= auto.length * floor) {
    const sorted = [...auto].sort((a, b) => heights[a]! - heights[b]!);
    let room = autoRoom;
    for (const [k, i] of sorted.entries()) {
      const level = room / (sorted.length - k);
      if (heights[i]! <= level) {
        room -= heights[i]!;
        continue;
      }
      for (const j of sorted.slice(k)) heights[j] = level;
      break;
    }
    return heights;
  }

  // 3. 自動の行は最小にし、手で決めた行を比で縮める
  for (const i of auto) heights[i] = floor;
  const scale = Math.max(0, budget - auto.length * floor) / manualSum;
  for (const [i, h] of manual.entries()) if (h !== undefined) heights[i] = h * scale;
  return heights;
}
