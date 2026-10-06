/**
 * スライド v2：キャンバスのノード（文字・矩形・画像）を作る側が使うテーマ。
 *
 * - 値は v1 の COLORS・*_TYPOGRAPHY・TITLE_SPEC・BULLETS_SPEC と、v1 の描画 CSS（slide.css。v1 とともに消した）の
 *   セルの地の色・余白・揃え方から取る。数値は写し直さない。
 * - packages/slides は packages/nodes に依存できないので、ノードの props の型には依存せず中立の形で返す。
 * - 余白（padding）は 16:9 の値。4:3 でも縮めない（文字の大きさと同じく、幾何の横の縮小には含めない）。
 */

import {
  BODY_TYPOGRAPHY,
  bulletLevelSpec,
  BULLETS_SPEC,
  COLORS,
  LABEL_TYPOGRAPHY,
  TABLE_IMAGE_SPEC,
  TITLE_SPEC,
  TITLE_TYPOGRAPHY,
  WEB_FONT_NAME,
} from "../core/slide-layout-spec.ts";
import { FIGURE_BORDER_WIDTH } from "./canvas-slide-layout.ts";

/** キャンバスのフォント名。packages/nodes の BUNDLED_FONT_FAMILY（"M PLUS 1p"）と同じ文字列 */
export const CANVAS_SLIDE_FONT_FAMILY: string = WEB_FONT_NAME;

export type CanvasPadding = { top: number; right: number; bottom: number; left: number };

/** 文字の箱（セル）の見た目 */
export type CanvasTextStyle = {
  fontFamily: string;
  fontSize: number;
  /** 行の高さ（フォントの大きさに対する倍率） */
  lineHeight: number;
  /** 字間（em） */
  letterSpacingEm: number;
  fontWeight: 400 | 700;
  /** 文字の色 */
  color: string;
  /** セルの地の色。地を塗らないときは null */
  fill: string | null;
  /** セルの箱の内側の余白 */
  padding: CanvasPadding;
  /** 横の揃え方 */
  align: "left" | "center" | "right";
  /** 縦の揃え方 */
  verticalAlign: "top" | "middle" | "bottom";
};

/** 地の矩形（パネル・図の枠）の見た目 */
export type CanvasRectStyle = {
  fill: string;
  /** 枠線の色。枠線がないときは null */
  stroke: string | null;
  strokeWidth: number;
  cornerRadius: number;
  /** 中身を置く範囲までの余白（図の枠だけ。枠線の太さを含まない） */
  padding: number;
};

/** 箇条書きの 1 段の見た目 */
export type CanvasBulletLevelStyle = {
  fontSize: number;
  lineHeight: number;
  /** セル本文の左端（セルの padding の内側）から文字までのインデント */
  indentPx: number;
  /** 行頭記号（空文字なら記号なし） */
  marker: string;
  /** セル本文の左端から行頭記号までのインデント（v1 では 1 つ上の段のインデント） */
  markerIndentPx: number;
};

function padding(vertical: number, horizontal: number): CanvasPadding {
  return { top: vertical, right: horizontal, bottom: vertical, left: horizontal };
}

/** スライドのタイトル（v1 の h1） */
export const CANVAS_SLIDE_TITLE_STYLE: CanvasTextStyle = {
  fontFamily: CANVAS_SLIDE_FONT_FAMILY,
  fontSize: TITLE_TYPOGRAPHY.fontSize,
  lineHeight: TITLE_TYPOGRAPHY.lineHeight,
  letterSpacingEm: TITLE_TYPOGRAPHY.letterSpacingEm,
  fontWeight: 700,
  color: COLORS.ink,
  fill: null,
  padding: padding(0, 0),
  align: "left",
  verticalAlign: "top",
};

/** 表の左ラベルのセル（v1 の .citation）。白地・太字・上下左右中央 */
export const CANVAS_SLIDE_LABEL_STYLE: CanvasTextStyle = {
  fontFamily: CANVAS_SLIDE_FONT_FAMILY,
  fontSize: LABEL_TYPOGRAPHY.fontSize,
  lineHeight: LABEL_TYPOGRAPHY.lineHeight,
  letterSpacingEm: LABEL_TYPOGRAPHY.letterSpacingEm,
  fontWeight: 700,
  color: COLORS.ink,
  fill: COLORS.paper,
  padding: padding(LABEL_TYPOGRAPHY.padV, LABEL_TYPOGRAPHY.padH),
  align: "center",
  verticalAlign: "middle",
};

/**
 * 本文の地の色（v1 の .summary）。1・2 行目は creamA、3 行目からは creamB
 * （.row:nth-child(n + 3) .summary）。表と箇条書きで同じ。rowIndex は 0 始まり。
 */
export function canvasSlideBodyFill(rowIndex: number): string {
  return rowIndex >= 2 ? COLORS.creamB : COLORS.creamA;
}

/** 本文のセル（v1 の .summary。箇条書きの項目も同じ）。左揃え・上下中央 */
export function canvasSlideBodyStyle(rowIndex: number): CanvasTextStyle {
  return {
    fontFamily: CANVAS_SLIDE_FONT_FAMILY,
    fontSize: BODY_TYPOGRAPHY.fontSize,
    lineHeight: BODY_TYPOGRAPHY.lineHeight,
    letterSpacingEm: BODY_TYPOGRAPHY.letterSpacingEm,
    fontWeight: 400,
    color: COLORS.ink,
    fill: canvasSlideBodyFill(rowIndex),
    padding: padding(BODY_TYPOGRAPHY.padV, BODY_TYPOGRAPHY.padH),
    align: "left",
    verticalAlign: "middle",
  };
}

/**
 * 箇条書きの段（depth は 0 始まり。範囲外は端の段に寄せる）。
 * 1 段目は本文と同じ。2・3 段目は記号付きで、記号は 1 つ上の段のインデントに置く（v1 の ::before）。
 */
export function canvasSlideBulletLevelStyle(depth: number): CanvasBulletLevelStyle {
  const index = Math.min(Math.max(depth, 0), BULLETS_SPEC.levels.length - 1);
  const level = bulletLevelSpec(index);
  return {
    fontSize: level.fontSize,
    lineHeight: level.lineHeight,
    indentPx: level.indentPx,
    marker: level.marker,
    markerIndentPx: index > 0 ? bulletLevelSpec(index - 1).indentPx : 0,
  };
}

/** 灰色の地のパネル（v1 の .research-panel / .mixed-table-panel） */
export const CANVAS_SLIDE_PANEL_STYLE: CanvasRectStyle = {
  fill: COLORS.panel,
  stroke: null,
  strokeWidth: 0,
  cornerRadius: 0,
  padding: 0,
};

/** table-image の図の枠（v1 の .figure-panel）。白地・灰色の枠線・角丸。画像は枠の中に収める（contain） */
export const CANVAS_SLIDE_FIGURE_STYLE: CanvasRectStyle = {
  fill: COLORS.paper,
  stroke: COLORS.figureBorder,
  strokeWidth: FIGURE_BORDER_WIDTH,
  cornerRadius: TABLE_IMAGE_SPEC.figureBorderRadius,
  padding: TABLE_IMAGE_SPEC.figurePadding,
};

/** 表紙のタイトル（v1 の .cover-title）。見出しの領域の左右の余白（textPaddingX）を padding に持つ */
export const CANVAS_COVER_TITLE_STYLE: CanvasTextStyle = {
  fontFamily: CANVAS_SLIDE_FONT_FAMILY,
  fontSize: TITLE_SPEC.title.fontSize,
  lineHeight: TITLE_SPEC.title.lineHeight,
  letterSpacingEm: TITLE_SPEC.title.letterSpacingEm,
  fontWeight: 700,
  color: COLORS.ink,
  fill: null,
  padding: padding(0, TITLE_SPEC.textPaddingX),
  align: "center",
  verticalAlign: "top",
};

/** 表紙の副題（v1 の .cover-subtitle）。字間は本文と同じ */
export const CANVAS_COVER_SUBTITLE_STYLE: CanvasTextStyle = {
  fontFamily: CANVAS_SLIDE_FONT_FAMILY,
  fontSize: TITLE_SPEC.subtitle.fontSize,
  lineHeight: TITLE_SPEC.subtitle.lineHeight,
  letterSpacingEm: BODY_TYPOGRAPHY.letterSpacingEm,
  fontWeight: 400,
  color: COLORS.ink,
  fill: null,
  padding: padding(0, TITLE_SPEC.textPaddingX),
  align: "center",
  verticalAlign: "top",
};

/** 表紙の credits の帯（v1 の .cover-credits）。灰色の地・上下左右中央。字間は本文と同じ */
export const CANVAS_COVER_CREDITS_STYLE: CanvasTextStyle = {
  fontFamily: CANVAS_SLIDE_FONT_FAMILY,
  fontSize: TITLE_SPEC.credits.fontSize,
  lineHeight: TITLE_SPEC.credits.lineHeight,
  letterSpacingEm: BODY_TYPOGRAPHY.letterSpacingEm,
  fontWeight: 400,
  color: COLORS.ink,
  fill: COLORS.panel,
  padding: padding(0, TITLE_SPEC.credits.paddingX),
  align: "center",
  verticalAlign: "middle",
};

/** スライドの地（v1 の .slide） */
export const CANVAS_SLIDE_BACKGROUND: string = COLORS.paper;
