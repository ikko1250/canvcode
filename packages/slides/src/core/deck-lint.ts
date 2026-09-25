/**
 * デッキ lint（export 時の警告と行高リバランス）の単一ソース。
 * Node（deck-loader / export）とブラウザ（GUI エディタ）の両方から利用する。
 * 警告の順序は「全スライドの構造警告（code / figures）→ 全スライドの容量警告」で、
 * tests/fixtures/warnings-baseline.txt と一致させる。
 */
import { computeSlideGeometry, TABLE_IMAGES_SPEC } from "./slide-layout-spec.ts";
import {
  analyzeBulletItems,
  analyzeSlideRows,
  analyzeTitleSlide,
} from "./slide-row-capacity.ts";
import type { DeckData, SlideData } from "./slide-schema.ts";

export const CODE_WARN_MAX_LINES = 20;
export const CODE_WARN_MAX_LINE_CHARS = 70;
export const CODE_WARN_MAX_TOTAL_CHARS = 1400;

/** 警告文に使うスライドの呼び名（name があれば name、なければ「スライド N」） */
export function slideLabel(slide: Pick<SlideData, "name">, index: number): string {
  return slide.name ?? `スライド ${index + 1}`;
}

export function codeBlockCapacityWarning(slide: SlideData, label: string): string | null {
  if (slide.layout !== "table-image" || !slide.code) {
    return null;
  }

  const lines = slide.code.lines;
  const lineCount = lines.length;
  const maxLineChars = Math.max(...lines.map((line) => [...line].length));
  const totalChars = lines.reduce((sum, line) => sum + [...line].length, 0);
  const reasons: string[] = [];

  if (lineCount > CODE_WARN_MAX_LINES) {
    reasons.push(`行数 ${lineCount} が上限 ${CODE_WARN_MAX_LINES} を超過`);
  }
  if (maxLineChars > CODE_WARN_MAX_LINE_CHARS) {
    reasons.push(`最長行 ${maxLineChars} 字が上限 ${CODE_WARN_MAX_LINE_CHARS} 字を超過`);
  }
  if (totalChars > CODE_WARN_MAX_TOTAL_CHARS) {
    reasons.push(`総文字数 ${totalChars} が上限 ${CODE_WARN_MAX_TOTAL_CHARS} を超過`);
  }
  if (reasons.length === 0) {
    return null;
  }

  return (
    `警告 [${label}]: table-image コードブロック容量超過 — ` +
    `行数=${lineCount}, 最長行=${maxLineChars}字, 総文字数=${totalChars} — ${reasons.join("; ")}`
  );
}

export function figuresAreaWarning(slide: SlideData, label: string): string | null {
  if (slide.layout !== "table-images" || !slide.rows) {
    return null;
  }
  const geometry = computeSlideGeometry("table-images", slide.rows.length);
  const height = geometry.figuresHeightPx ?? 0;
  if (height >= TABLE_IMAGES_SPEC.warnFiguresHeightPx) {
    return null;
  }
  return `警告 [${label}]: table-images rows=${slide.rows.length} では下図領域が ${height}px と狭くなります。行数の削減を検討してください。`;
}

export type SlideLint = {
  index: number;
  label: string;
  /** code / figures の構造警告（この順） */
  structuralWarnings: string[];
  /** 行容量 lint の警告・情報 */
  capacityWarnings: string[];
  /** partial 超過のときだけ: リバランス後の行高 */
  computedRowHeights?: number[];
  /** compact パネルに収まらず全高パネルに切り替えたときだけ true */
  computedFullPanel?: true;
};

type CapacityResult = { warnings: string[]; rowHeights: number[] | null; fullPanel: boolean };

function analyzeCapacity(slide: SlideData): CapacityResult {
  const layout = slide.layout ?? "table";
  const slideName = slide.name !== undefined ? { slideName: slide.name } : {};

  if (layout === "title") {
    const analysis = analyzeTitleSlide({
      title: slide.title,
      ...(slide.subtitle ? { subtitle: slide.subtitle } : {}),
      ...(slide.credits ? { credits: slide.credits } : {}),
      ...slideName,
    });
    return { warnings: analysis.warnings, rowHeights: null, fullPanel: false };
  }

  if (layout === "bullets" && slide.items) {
    const analysis = analyzeBulletItems({ items: slide.items, ...slideName });
    return {
      warnings: analysis.warnings,
      rowHeights: analysis.classification === "partial" ? analysis.rowHeights : null,
      fullPanel: analysis.fullPanel,
    };
  }

  if (!slide.rows) {
    return { warnings: [], rowHeights: null, fullPanel: false };
  }

  const analysis = analyzeSlideRows({ layout, rows: slide.rows, ...slideName });
  return {
    warnings: analysis.warnings,
    rowHeights: analysis.classification === "partial" ? analysis.rowHeights : null,
    fullPanel: analysis.fullPanel,
  };
}

/** 1 スライドの lint。structuralWarnings / capacityWarnings は分けて返す */
export function lintSlide(slide: SlideData, index: number): SlideLint {
  const label = slideLabel(slide, index);
  const structuralWarnings: string[] = [];
  const codeWarning = codeBlockCapacityWarning(slide, label);
  if (codeWarning) structuralWarnings.push(codeWarning);
  const figuresWarning = figuresAreaWarning(slide, label);
  if (figuresWarning) structuralWarnings.push(figuresWarning);

  const capacity = analyzeCapacity(slide);
  const result: SlideLint = {
    index,
    label,
    structuralWarnings,
    capacityWarnings: capacity.warnings,
  };
  if (capacity.rowHeights) {
    result.computedRowHeights = capacity.rowHeights;
  }
  if (capacity.fullPanel) {
    result.computedFullPanel = true;
  }
  return result;
}

export type DeckLint = {
  slides: SlideLint[];
  /** export と同じ順序で並べた全警告 */
  warnings: string[];
};

/** デッキ全体の lint。warnings の順序は export の出力と同一 */
export function lintDeck(deck: DeckData): DeckLint {
  const slides = deck.slides.map((slide, index) => lintSlide(slide, index));
  const warnings = [
    ...slides.flatMap((slide) => slide.structuralWarnings),
    ...slides.flatMap((slide) => slide.capacityWarnings),
  ];
  return { slides, warnings };
}
