/**
 * デッキ / スライドの検証と正規化の単一ソース。
 * Node（export）とブラウザ（renderer バンドル）の両方から利用する。
 */
import {
  BULLETS_SPEC,
  getMaxRowCount,
  GRID_LAYOUTS,
  isSlideLayout,
  isValidRowCount,
  layoutUsesRows,
  ROW_LAYOUTS,
  rowCountRangeMessage,
  SLIDE_LAYOUTS,
  type SlideLayout,
} from "./slide-layout-spec.ts";

export const SLIDE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type TableRow = {
  labelLines: string[];
  bodyLines: string[];
};

export type SlideImage = {
  path: string;
  alt: string;
};

export type SlideCodeBlock = {
  lines: string[];
  language?: string;
};

export type TableImagesImage = {
  path: string;
  alt: string;
  title: string;
};

/** 箇条書きの項目。子を持たない項目は文字列、子を持つ項目は { text, children } */
export type BulletItem = string | { text: string; children: BulletItem[] };

export type SlideData = {
  name?: string;
  layout?: SlideLayout;
  title: string;
  /** rows を持つレイアウト（table / table-image / table-images）で必須 */
  rows?: TableRow[];
  /** bullets レイアウトで必須（1〜最大行数、3 階層まで） */
  items?: BulletItem[];
  image?: SlideImage;
  code?: SlideCodeBlock;
  images?: TableImagesImage[];
  /** title レイアウト: 副題（行配列） */
  subtitle?: string[];
  /** title レイアウト: 発表者・所属・日付など（行配列） */
  credits?: string[];
};

export type DeckData = {
  $schema?: string;
  deckTitle?: string;
  slides: SlideData[];
};

/** ブラウザ描画に渡す形（画像は Data URL 済み） */
export type RenderSlideData = {
  name?: string;
  layout?: SlideLayout;
  title: string;
  rows?: TableRow[];
  items?: BulletItem[];
  image?: { src: string; alt: string };
  code?: SlideCodeBlock;
  images?: { src: string; alt: string; title: string }[];
  subtitle?: string[];
  credits?: string[];
  computedRowHeights?: number[];
  /** compact 幾何に収まる行数でも全高パネルで描く（行容量 lint が内容量から決める） */
  computedFullPanel?: boolean;
};

export const ROOT_KEYS = ["$schema", "deckTitle", "slides"] as const;
export const SLIDE_KEYS = [
  "name",
  "layout",
  "title",
  "rows",
  "items",
  "image",
  "code",
  "images",
  "subtitle",
  "credits",
] as const;
export const ROW_KEYS = ["labelLines", "bodyLines"] as const;
export const IMAGE_KEYS = ["path", "alt"] as const;
export const IMAGES_ITEM_KEYS = ["path", "alt", "title"] as const;
export const CODE_KEYS = ["lines", "language"] as const;

const RENDER_SLIDE_KEYS = [...SLIDE_KEYS, "computedRowHeights", "computedFullPanel"] as const;

type Mode = "authoring" | "render";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function rejectUnknownKeys(
  data: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(data)) {
    if (!allowed.includes(key)) {
      throw new Error(`${label}: 未知のキー "${key}" は使用できません。`);
    }
  }
}

/** 行テキスト: string[]（各行非空）または改行入り string を受け付け、string[] に正規化する */
export function normalizeLines(value: unknown, label: string): string[] {
  let lines: unknown[];
  if (typeof value === "string") {
    lines = value.split(/\r?\n/);
  } else if (Array.isArray(value)) {
    lines = value;
  } else {
    throw new Error(`${label} は文字列または文字列配列で指定してください。`);
  }

  if (lines.length === 0) {
    throw new Error(`${label} を1行以上指定してください。`);
  }

  return lines.map((line, index) => {
    if (!isNonEmptyString(line)) {
      throw new Error(`${label} の ${index + 1} 行目が空です。空行は使用できません。`);
    }
    return line;
  });
}

function isCodeLinesArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")
  );
}

function readLayout(data: Record<string, unknown>, label: string): SlideLayout {
  if (data.layout === undefined) {
    return "table";
  }
  if (!isSlideLayout(data.layout)) {
    const options = SLIDE_LAYOUTS.map((layout) => `"${layout}"`).join("、");
    throw new Error(`${label}: layout は ${options} のいずれかを指定してください。`);
  }
  return data.layout;
}

function normalizeRows(value: unknown, layout: SlideLayout, label: string): TableRow[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label}: rows は配列で指定してください。`);
  }
  if (!isValidRowCount(layout, value.length)) {
    throw new Error(`${label}: ${rowCountRangeMessage(layout, value.length)}`);
  }

  return value.map((row, index) => {
    if (!isRecord(row)) {
      throw new Error(`${label}: rows[${index}] はオブジェクトで指定してください。`);
    }
    rejectUnknownKeys(row, ROW_KEYS, `${label}: rows[${index}]`);
    return {
      labelLines: normalizeLines(row.labelLines, `${label}: rows[${index}].labelLines`),
      bodyLines: normalizeLines(row.bodyLines, `${label}: rows[${index}].bodyLines`),
    };
  });
}

const BULLET_ITEM_KEYS = ["text", "children"] as const;

function normalizeBulletItem(value: unknown, label: string, depth: number): BulletItem {
  if (typeof value === "string") {
    if (!isNonEmptyString(value)) {
      throw new Error(`${label} に空でない文字列を指定してください。`);
    }
    return value;
  }
  if (!isRecord(value)) {
    throw new Error(`${label} は文字列またはオブジェクト（text, children）で指定してください。`);
  }
  rejectUnknownKeys(value, BULLET_ITEM_KEYS, label);
  if (!isNonEmptyString(value.text)) {
    throw new Error(`${label}.text に空でない文字列を指定してください。`);
  }
  if (value.children === undefined) {
    return value.text;
  }
  if (!Array.isArray(value.children) || value.children.length === 0) {
    throw new Error(`${label}.children は1件以上の配列で指定してください（不要なら省略）。`);
  }
  if (depth >= BULLETS_SPEC.maxDepth) {
    throw new Error(`${label}.children: 箇条書きは ${BULLETS_SPEC.maxDepth} 階層までです。`);
  }
  return {
    text: value.text,
    children: value.children.map((child, index) =>
      normalizeBulletItem(child, `${label}.children[${index}]`, depth + 1),
    ),
  };
}

function normalizeBulletItems(value: unknown, label: string): BulletItem[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label}: items は配列で指定してください。`);
  }
  if (!isValidRowCount("bullets", value.length)) {
    throw new Error(`${label}: ${rowCountRangeMessage("bullets", value.length, "items")}`);
  }
  return value.map((item, index) => normalizeBulletItem(item, `${label}: items[${index}]`, 1));
}

function validateCode(value: unknown, label: string): SlideCodeBlock {
  if (!isRecord(value)) {
    throw new Error(`${label}: code はオブジェクトで指定してください。`);
  }
  rejectUnknownKeys(value, CODE_KEYS, `${label}: code`);
  if (!isCodeLinesArray(value.lines)) {
    throw new Error(`${label}: code.lines は1行以上の string 配列で指定してください。`);
  }
  if (value.language !== undefined && !isNonEmptyString(value.language)) {
    throw new Error(`${label}: code.language に空でない文字列を指定してください。`);
  }
  const code: SlideCodeBlock = { lines: [...value.lines] };
  if (value.language !== undefined) {
    code.language = value.language;
  }
  return code;
}

function validateImageLike(
  value: unknown,
  label: string,
  srcKey: "path" | "src",
  requireTitle: boolean,
): { source: string; alt: string; title?: string } {
  if (!isRecord(value)) {
    throw new Error(`${label} はオブジェクトで指定してください。`);
  }
  const allowed = requireTitle ? [srcKey, "alt", "title"] : [srcKey, "alt"];
  rejectUnknownKeys(value, allowed, label);

  if (!isNonEmptyString(value[srcKey])) {
    const hint = srcKey === "path" ? "空でない文字列" : "画像データ";
    throw new Error(`${label}.${srcKey} に${hint}を指定してください。`);
  }
  if (!isNonEmptyString(value.alt)) {
    throw new Error(`${label}.alt に空でない文字列を指定してください。`);
  }
  const result: { source: string; alt: string; title?: string } = {
    source: value[srcKey],
    alt: value.alt,
  };
  if (requireTitle) {
    if (!isNonEmptyString(value.title)) {
      throw new Error(`${label}.title に空でない文字列を指定してください。`);
    }
    result.title = value.title;
  }
  return result;
}

type SlideCore = {
  name?: string;
  layout: SlideLayout;
  layoutSpecified: boolean;
  title: string;
  rows?: TableRow[];
  items?: BulletItem[];
  code?: SlideCodeBlock;
  image?: { source: string; alt: string };
  images?: { source: string; alt: string; title: string }[];
  subtitle?: string[];
  credits?: string[];
};

function onlyForLayouts(
  label: string,
  key: string,
  layouts: readonly SlideLayout[],
): Error {
  const names = layouts.map((layout) => `${layout}`).join(" / ");
  return new Error(`${label}: ${key} は ${names} レイアウトでのみ指定できます。`);
}

function normalizeSlideCore(value: unknown, label: string, mode: Mode): SlideCore {
  if (!isRecord(value)) {
    throw new Error(`${label}: スライドはオブジェクトである必要があります。`);
  }
  rejectUnknownKeys(value, mode === "render" ? RENDER_SLIDE_KEYS : SLIDE_KEYS, label);

  const core: SlideCore = {
    layout: readLayout(value, label),
    layoutSpecified: value.layout !== undefined,
    title: "",
  };

  if (value.name !== undefined) {
    if (typeof value.name !== "string" || !SLIDE_NAME_PATTERN.test(value.name)) {
      throw new Error(
        `${label}: name は英小文字・数字・ハイフンのみで指定してください（例: prior-research-3）。`,
      );
    }
    core.name = value.name;
  }

  if (!isNonEmptyString(value.title)) {
    throw new Error(`${label}: title に空でない文字列を指定してください。`);
  }
  core.title = value.title;

  if (layoutUsesRows(core.layout)) {
    core.rows = normalizeRows(value.rows, core.layout, label);
  } else if (value.rows !== undefined) {
    throw onlyForLayouts(label, "rows", ROW_LAYOUTS);
  }

  const srcKey = mode === "render" ? "src" : "path";
  const hasImage = value.image != null;
  const hasCode = value.code != null;
  const hasImages = value.images != null;
  const hasSubtitle = value.subtitle !== undefined;
  const hasCredits = value.credits !== undefined;
  const hasItems = value.items !== undefined;

  if (core.layout === "bullets") {
    core.items = normalizeBulletItems(value.items, label);
  } else if (hasItems) {
    throw onlyForLayouts(label, "items", ["bullets"]);
  }

  if (core.layout !== "table-image") {
    if (hasCode) {
      throw onlyForLayouts(label, "code", ["table-image"]);
    }
    if (hasImage) {
      throw onlyForLayouts(label, "image", ["table-image"]);
    }
  }
  if (core.layout !== "table-images" && hasImages) {
    throw onlyForLayouts(label, "images", ["table-images"]);
  }
  if (core.layout !== "title") {
    if (hasSubtitle) {
      throw onlyForLayouts(label, "subtitle", ["title"]);
    }
    if (hasCredits) {
      throw onlyForLayouts(label, "credits", ["title"]);
    }
  }

  if (core.layout === "table-image") {
    if (!hasImage && !hasCode) {
      throw new Error(
        `${label}: table-image レイアウトでは image または code のいずれかを指定してください。`,
      );
    }
    if (hasImage && hasCode) {
      throw new Error(`${label}: table-image レイアウトでは image と code は同時に指定できません。`);
    }
    if (hasImage) {
      const image = validateImageLike(value.image, `${label}: image`, srcKey, false);
      core.image = { source: image.source, alt: image.alt };
    }
    if (hasCode) {
      core.code = validateCode(value.code, label);
    }
  }

  if (core.layout === "table-images") {
    if (!Array.isArray(value.images) || value.images.length !== 2) {
      throw new Error(`${label}: table-images レイアウトでは images をちょうど2件指定してください。`);
    }
    core.images = value.images.map((image, index) => {
      const item = validateImageLike(image, `${label}: images[${index}]`, srcKey, true);
      return { source: item.source, alt: item.alt, title: item.title ?? "" };
    });
  }

  if (core.layout === "title") {
    if (hasSubtitle) {
      core.subtitle = normalizeLines(value.subtitle, `${label}: subtitle`);
    }
    if (hasCredits) {
      core.credits = normalizeLines(value.credits, `${label}: credits`);
    }
  }

  return core;
}

/** 執筆用スライド（画像は path）を検証し、正規化したコピーを返す */
export function normalizeSlideData(value: unknown, label: string): SlideData {
  const core = normalizeSlideCore(value, label, "authoring");
  // キー順は name, layout, title, rows, items, image, code, images, subtitle, credits
  const slide: SlideData = {
    ...(core.name !== undefined ? { name: core.name } : {}),
    ...(core.layoutSpecified ? { layout: core.layout } : {}),
    title: core.title,
  };
  if (core.rows) slide.rows = core.rows;
  if (core.items) slide.items = core.items;
  if (core.image) slide.image = { path: core.image.source, alt: core.image.alt };
  if (core.code) slide.code = core.code;
  if (core.images) {
    slide.images = core.images.map((image) => ({
      path: image.source,
      alt: image.alt,
      title: image.title,
    }));
  }
  if (core.subtitle) slide.subtitle = core.subtitle;
  if (core.credits) slide.credits = core.credits;
  return slide;
}

function isOldSlideFormat(value: Record<string, unknown>): boolean {
  return !("slides" in value) && ("title" in value || "studies" in value || "rows" in value);
}

/** デッキ全体を検証し、正規化したコピーを返す。source はエラー表示用のファイル名など */
export function normalizeDeckData(value: unknown, source: string): DeckData {
  if (!isRecord(value)) {
    throw new Error(`${source}: JSONのルートはオブジェクトである必要があります。`);
  }
  if (isOldSlideFormat(value)) {
    throw new Error(
      `${source}: 旧形式のスライドJSONです。slides 配列を持つデッキ形式に移行してください。`,
    );
  }
  rejectUnknownKeys(value, ROOT_KEYS, source);

  let schemaRef: string | undefined;
  if (value.$schema !== undefined) {
    if (typeof value.$schema !== "string") {
      throw new Error(`${source}: $schema は文字列で指定してください。`);
    }
    schemaRef = value.$schema;
  }

  let deckTitle: string | undefined;
  if (value.deckTitle !== undefined) {
    if (!isNonEmptyString(value.deckTitle)) {
      throw new Error(`${source}: deckTitle に空でない文字列を指定してください。`);
    }
    deckTitle = value.deckTitle;
  }

  if (!Array.isArray(value.slides) || value.slides.length === 0) {
    throw new Error(`${source}: slides には1件以上のスライドを指定してください。`);
  }

  const seenNames = new Set<string>();
  const slides = value.slides.map((slide, index) => {
    const label = `${source} の slides ${index + 1}枚目`;
    const normalized = normalizeSlideData(slide, label);
    if (normalized.name) {
      if (seenNames.has(normalized.name)) {
        throw new Error(`${source}: name "${normalized.name}" が重複しています。`);
      }
      seenNames.add(normalized.name);
    }
    return normalized;
  });

  return {
    ...(schemaRef !== undefined ? { $schema: schemaRef } : {}),
    ...(deckTitle !== undefined ? { deckTitle } : {}),
    slides,
  };
}

/** ブラウザ描画データ（画像は src）を検証する */
export function validateRenderSlideData(value: unknown): asserts value is RenderSlideData {
  const core = normalizeSlideCore(value, "スライド", "render");
  const data = value as Record<string, unknown>;
  if (data.computedRowHeights !== undefined) {
    const heights = data.computedRowHeights;
    const gridCount = core.rows?.length ?? core.items?.length;
    if (gridCount === undefined) {
      throw new Error("computedRowHeights は rows または items を持つレイアウトでのみ指定できます。");
    }
    if (
      !Array.isArray(heights) ||
      heights.length !== gridCount ||
      !heights.every((height) => typeof height === "number" && Number.isFinite(height) && height > 0)
    ) {
      throw new Error("computedRowHeights は rows と同数の正の数値配列で指定してください。");
    }
  }
  if (data.computedFullPanel !== undefined) {
    if (typeof data.computedFullPanel !== "boolean") {
      throw new Error("computedFullPanel は true / false で指定してください。");
    }
    if (core.rows === undefined && core.items === undefined) {
      throw new Error("computedFullPanel は rows または items を持つレイアウトでのみ指定できます。");
    }
  }
}

/** 行グリッドを持つレイアウトごとの最大行数（bullets は items の件数） */
export function describeRowCountLimits(): Partial<Record<SlideLayout, number>> {
  return Object.fromEntries(
    GRID_LAYOUTS.map((layout) => [layout, getMaxRowCount(layout)]),
  ) as Partial<Record<SlideLayout, number>>;
}
