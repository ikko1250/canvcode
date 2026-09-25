/**
 * デッキオブジェクト → Markdown / JSON の書き出し。GUI エディタの保存で使う。
 *
 * Markdown は markdown-deck.ts のパーサが受理する行単位のサブセットで、既存の decks/*.md と
 * 同じ体裁（見出し → 空行 → ブロック、表紙は見出し直後に ## と credits）で出力する。
 * layout はパーサが内容から推定するため出力しない。JSON にしかない $schema と明示的な
 * layout: "table" は Markdown で表現できないので、往復比較の前に正準化して落とす。
 *
 * serializeDeckToMarkdownChecked は「書き出し → 再パース → 正規化」が元と一致することを
 * 確認し、Markdown で表現できない内容（前後空白、行頭の記号、<br> 入りセルなど）は
 * 日本語のエラーで拒否する。
 */
import { parseMarkdownDeck } from "./markdown-deck.ts";
import {
  normalizeDeckData,
  type BulletItem,
  type DeckData,
  type SlideData,
} from "./slide-schema.ts";

/** Markdown で表現できないキー（$schema、明示的な layout: "table"）を落とす */
export function canonicalizeDeckForMarkdown(deck: DeckData): DeckData {
  const slides = deck.slides.map((slide) => {
    if (slide.layout !== "table") {
      return slide;
    }
    const { layout: _layout, ...rest } = slide;
    return rest;
  });
  return {
    ...(deck.deckTitle !== undefined ? { deckTitle: deck.deckTitle } : {}),
    slides,
  };
}

function escapeCell(line: string): string {
  return line.replace(/\|/g, "\\|");
}

function cellText(lines: string[]): string {
  return lines.map(escapeCell).join("<br>");
}

function imagePath(path: string): string {
  return /[\s)]/.test(path) ? `<${path}>` : path;
}

/** 既定値以外の zoom/x/y があるときだけ {zoom=1.5 x=-10 y=5} を返す。無ければ空文字 */
function imageAttrs(image: { zoom?: number; x?: number; y?: number }): string {
  const parts: string[] = [];
  if (image.zoom !== undefined) parts.push(`zoom=${image.zoom}`);
  if (image.x !== undefined) parts.push(`x=${image.x}`);
  if (image.y !== undefined) parts.push(`y=${image.y}`);
  return parts.length > 0 ? `{${parts.join(" ")}}` : "";
}

function headingLine(slide: SlideData): string {
  return slide.name !== undefined ? `# ${slide.title} {#${slide.name}}` : `# ${slide.title}`;
}

function pushBulletLines(item: BulletItem, depth: number, out: string[]): void {
  const indent = "  ".repeat(depth);
  if (typeof item === "string") {
    out.push(`${indent}- ${item}`);
    return;
  }
  out.push(`${indent}- ${item.text}`);
  for (const child of item.children) {
    pushBulletLines(child, depth + 1, out);
  }
}

function serializeSlide(slide: SlideData): string[] {
  const lines = [headingLine(slide)];
  const layout = slide.layout ?? "table";

  if (layout === "title") {
    for (const subtitle of slide.subtitle ?? []) {
      lines.push(`## ${subtitle}`);
    }
    for (const credit of slide.credits ?? []) {
      lines.push(credit);
    }
    return lines;
  }

  const blocks: string[][] = [];

  if (layout === "bullets") {
    const out: string[] = [];
    for (const item of slide.items ?? []) {
      pushBulletLines(item, 0, out);
    }
    blocks.push(out);
  } else {
    blocks.push(
      (slide.rows ?? []).map((row) => `| ${cellText(row.labelLines)} | ${cellText(row.bodyLines)} |`),
    );

    if (layout === "table-image") {
      if (slide.code) {
        blocks.push([`\`\`\`${slide.code.language ?? ""}`, ...slide.code.lines, "```"]);
      } else if (slide.image) {
        const attrs = imageAttrs(slide.image);
        blocks.push([`![${slide.image.alt}](${imagePath(slide.image.path)})${attrs}`]);
      }
    }

    if (layout === "table-images" && slide.images) {
      blocks.push(
        slide.images.map(
          (image) =>
            `![${image.alt}](${imagePath(image.path)} "${image.title}")${imageAttrs(image)}`,
        ),
      );
    }
  }

  for (const block of blocks) {
    lines.push("", ...block);
  }
  return lines;
}

/** 正規化済みデッキを Markdown 文字列にする（往復保証はしない。Checked 版を使うこと） */
export function serializeDeckToMarkdown(deck: DeckData): string {
  const parts: string[] = [];
  if (deck.deckTitle !== undefined) {
    parts.push(`---\ndeckTitle: ${deck.deckTitle}\n---`);
  }
  for (const slide of deck.slides) {
    parts.push(serializeSlide(slide).join("\n"));
  }
  return `${parts.join("\n\n")}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

/** 2 つのデッキの最初の差異を日本語で説明する。差異がなければ null */
export function describeDeckDifference(expected: DeckData, actual: DeckData): string | null {
  if (expected.deckTitle !== actual.deckTitle) {
    return "deckTitle";
  }
  if (expected.slides.length !== actual.slides.length) {
    return `スライド数 ${expected.slides.length} → ${actual.slides.length}`;
  }
  for (let index = 0; index < expected.slides.length; index += 1) {
    const before = expected.slides[index] as unknown as Record<string, unknown>;
    const after = actual.slides[index] as unknown as Record<string, unknown>;
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      if (!deepEqual(before[key], after[key])) {
        const title = expected.slides[index]?.title ?? "";
        return `スライド ${index + 1}「${title}」の ${key}`;
      }
    }
  }
  return null;
}

const ROUND_TRIP_HINT =
  "Markdown で表現できない文字（行頭の | - # ![、<br>、前後の空白など）を修正するか、JSON デッキとして保存してください。";

/**
 * デッキを検証・正準化して Markdown にし、再パースしても同じ内容になることを確認する。
 * 往復できない内容は日本語のエラーで拒否する。
 */
export function serializeDeckToMarkdownChecked(deck: unknown, sourceName = "deck.md"): string {
  const canonical = canonicalizeDeckForMarkdown(normalizeDeckData(deck, sourceName));
  const markdown = serializeDeckToMarkdown(canonical);

  let reparsed: DeckData;
  try {
    reparsed = normalizeDeckData(parseMarkdownDeck(markdown, sourceName), sourceName);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Markdown として保存できません: ${detail} ${ROUND_TRIP_HINT}`);
  }

  const difference = describeDeckDifference(canonical, reparsed);
  if (difference) {
    throw new Error(
      `Markdown として保存すると内容が変わるため保存できません（${difference}）。${ROUND_TRIP_HINT}`,
    );
  }
  return markdown;
}

/** デッキを検証し、md2json と同じ体裁の JSON 文字列にする（$schema は保持） */
export function serializeDeckToJson(deck: unknown, sourceName = "deck.json"): string {
  return `${JSON.stringify(normalizeDeckData(deck, sourceName), null, 2)}\n`;
}

/** ファイル名の拡張子で Markdown / JSON を選んで書き出す */
export function serializeDeck(deck: unknown, fileName: string): string {
  const extension = (fileName.match(/\.([^./\\]+)$/)?.[1] ?? "").toLowerCase();
  if (extension === "md") {
    return serializeDeckToMarkdownChecked(deck, fileName);
  }
  if (extension === "json") {
    return serializeDeckToJson(deck, fileName);
  }
  throw new Error("保存先は .md または .json のファイルにしてください。");
}
