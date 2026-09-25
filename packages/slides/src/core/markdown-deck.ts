/**
 * Markdown デッキ → デッキオブジェクト（JSON と同じ構造）への変換。
 *
 * 対応する記法（行単位の限定サブセット）:
 *
 *   ---                       先頭のみ: front matter（deckTitle: ...）
 *   # タイトル {#name}        スライド開始。{#name} と {layout=...} は任意
 *   ## 副題                   表紙の副題（表紙以外ではエラー）
 *   プレーン行                表紙の発表者・所属・日付（表紙以外ではエラー）
 *   - 項目 / 字下げ - 子項目  箇条書き（3 階層まで。表・画像・コードとの併用は不可）
 *   | ラベル | 本文 |         表の行。<br> でセル内改行。ヘッダー行 + |---|---| は無視
 *   ![alt](path "title")      画像。1枚 → table-image、2枚（title 必須）→ table-images
 *   ```lang ... ```           コードブロック → table-image（code）
 *   <!-- name: xxx -->        コメント。name / layout の指定にも使える
 *   ---                       スライド区切り（省略可。# 見出しで自動的に区切られる）
 *
 * layout の推定: リストあり → bullets、表・画像・コードがない → title、表のみ → table、
 * 表＋画像1枚または表＋コード → table-image、表＋画像2枚 → table-images。
 *
 * 戻り値は未検証のプレーンオブジェクト。呼び出し側で normalizeDeckData を通す。
 */
import { pickAdjust } from "./slide-schema.ts";

export type MarkdownImage = {
  path: string;
  alt: string;
  title?: string;
  zoom?: number;
  x?: number;
  y?: number;
};

type BulletDraft = {
  text: string;
  children: BulletDraft[];
};

type SlideDraft = {
  line: number;
  title: string;
  name?: string;
  layout?: string;
  rows: { labelLines: string[]; bodyLines: string[] }[];
  images: MarkdownImage[];
  code?: { lines: string[]; language?: string };
  subtitle: string[];
  paragraphs: { line: number; text: string }[];
  items: BulletDraft[];
  /** 進行中のリストの入れ子（indent と対応ノード） */
  listStack: { indent: number; node: BulletDraft }[];
};

const MAX_BULLET_DEPTH = 3;

const HEADING_PATTERN = /^#\s+(.+?)\s*$/;
const SUBTITLE_PATTERN = /^##\s+(.+?)\s*$/;
const DEEP_HEADING_PATTERN = /^#{3,6}\s+/;
const HEADING_ATTRS_PATTERN = /\s*\{([^}]*)\}\s*$/;
const FENCE_OPEN_PATTERN = /^```\s*([A-Za-z0-9_+-]*)\s*$/;
const FENCE_CLOSE_PATTERN = /^```\s*$/;
const IMAGE_PATTERN =
  /^!\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+"([^"]*)")?\s*\)(?:\s*\{([^}]*)\})?\s*$/;
const IMAGE_ATTR_TOKEN_PATTERN = /^(zoom|x|y)=(-?\d+(?:\.\d+)?)$/;
const COMMENT_PATTERN = /^<!--\s*(.*?)\s*-->$/;
const LIST_PATTERN = /^([ 	]*)[-*+][ 	]+(.+?)\s*$/;
const DIRECTIVE_PATTERN = /^(name|layout)\s*:\s*(\S+)$/;
const TABLE_SEPARATOR_CELL_PATTERN = /^:?-{1,}:?$/;
const BR_PATTERN = /<br\s*\/?>/gi;
const ESCAPED_PIPE = " PIPE ";

function fail(sourceName: string, lineNo: number, message: string): never {
  throw new Error(`${sourceName}:${lineNo}: ${message}`);
}

function splitCells(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  return body
    .replace(/\\\|/g, ESCAPED_PIPE)
    .split("|")
    .map((cell) => cell.replace(new RegExp(ESCAPED_PIPE, "g"), "|").trim());
}

function cellToLines(cell: string): string[] {
  return cell
    .split(BR_PATTERN)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseHeading(text: string): { title: string; name?: string; layout?: string } {
  const match = text.match(HEADING_ATTRS_PATTERN);
  if (!match) {
    return { title: text.trim() };
  }
  const title = text.slice(0, match.index).trim();
  const result: { title: string; name?: string; layout?: string } = { title };
  for (const token of (match[1] ?? "").split(/\s+/).filter(Boolean)) {
    if (token.startsWith("#")) {
      result.name = token.slice(1);
    } else if (token.startsWith("layout=")) {
      result.layout = token.slice("layout=".length);
    } else {
      throw new Error(`見出し属性 "${token}" は解釈できません（使用可: {#name layout=...}）。`);
    }
  }
  return result;
}

/** 画像の属性ブロック（{zoom=1.5 x=-10 y=5}）を解析する。範囲チェックはスキーマ側に委ねる */
function parseImageAttrs(raw: string): { zoom?: number; x?: number; y?: number } {
  const result: { zoom?: number; x?: number; y?: number } = {};
  for (const token of raw.split(/\s+/).filter(Boolean)) {
    const match = token.match(IMAGE_ATTR_TOKEN_PATTERN);
    if (!match || result[match[1] as "zoom" | "x" | "y"] !== undefined) {
      throw new Error(
        `画像属性 "${token}" は解釈できません（使用可: {zoom=1.5 x=-10 y=5}）。`,
      );
    }
    result[match[1] as "zoom" | "x" | "y"] = Number(match[2]);
  }
  return result;
}

function parseFrontMatter(
  lines: string[],
): { meta: Record<string, string>; nextLine: number } {
  if (lines[0]?.trim() !== "---") {
    return { meta: {}, nextLine: 0 };
  }
  const meta: Record<string, string> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const text = raw.trim();
    if (text === "---") {
      return { meta, nextLine: i + 1 };
    }
    if (text === "") {
      continue;
    }
    const match = text.match(/^([A-Za-z$][A-Za-z0-9_$]*)\s*:\s*(.*)$/);
    if (!match) {
      // key: value 以外を含む → front matter ではなく区切りとして扱う
      return { meta: {}, nextLine: 0 };
    }
    meta[match[1] ?? ""] = (match[2] ?? "").replace(/^"(.*)"$/, "$1").trim();
  }
  return { meta: {}, nextLine: 0 };
}

function indentWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += char === "	" ? 4 : 1;
  }
  return width;
}

function addListItem(draft: SlideDraft, indent: number, text: string, sourceName: string, lineNo: number): void {
  const stack = draft.listStack;
  while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) > indent) {
    stack.pop();
  }
  const top = stack[stack.length - 1];
  if (top && top.indent === indent) {
    stack.pop();
  }
  const parent = stack[stack.length - 1];
  const node: BulletDraft = { text, children: [] };
  if (parent) {
    parent.node.children.push(node);
  } else {
    draft.items.push(node);
  }
  stack.push({ indent, node });
  if (stack.length > MAX_BULLET_DEPTH) {
    fail(sourceName, lineNo, `箇条書きは ${MAX_BULLET_DEPTH} 階層までです（字下げが深すぎます）。`);
  }
}

type BulletOutput = string | { text: string; children: BulletOutput[] };

function toBulletOutput(node: BulletDraft): BulletOutput {
  if (node.children.length === 0) {
    return node.text;
  }
  return { text: node.text, children: node.children.map(toBulletOutput) };
}

function inferLayout(draft: SlideDraft, sourceName: string): string {
  const imageCount = draft.images.length;
  const hasCode = draft.code !== undefined;
  const hasTable = draft.rows.length > 0;

  if (draft.items.length > 0) {
    return "bullets";
  }

  if (!hasTable && imageCount === 0 && !hasCode) {
    return "title";
  }
  if (!hasCode && imageCount === 0) {
    return "table";
  }
  if (hasCode && imageCount === 0) {
    return "table-image";
  }
  if (!hasCode && imageCount === 1) {
    return "table-image";
  }
  if (!hasCode && imageCount === 2) {
    return "table-images";
  }
  return fail(
    sourceName,
    draft.line,
    `スライド "${draft.title}": 画像 ${imageCount} 枚とコードブロックの組み合わせは未対応です（画像1枚 / 画像2枚 / コード1つ のいずれか）。`,
  );
}

function finalizeSlide(draft: SlideDraft, sourceName: string): Record<string, unknown> {
  const layout = inferLayout(draft, sourceName);

  if (draft.layout !== undefined && draft.layout !== layout) {
    fail(
      sourceName,
      draft.line,
      `スライド "${draft.title}": 指定された layout "${draft.layout}" と内容から推定した "${layout}" が一致しません。`,
    );
  }

  if (layout !== "title") {
    const paragraph = draft.paragraphs[0];
    if (paragraph) {
      fail(
        sourceName,
        paragraph.line,
        `段落行 "${paragraph.text}" は表紙（表・画像・コードのないスライド）でのみ使えます。表の行は "| ラベル | 本文 |" の形式です。`,
      );
    }
    if (draft.subtitle.length > 0) {
      fail(sourceName, draft.line, `スライド "${draft.title}": 副題（##）は表紙でのみ使えます。`);
    }
  }

  if (layout === "bullets") {
    if (draft.rows.length > 0 || draft.images.length > 0 || draft.code !== undefined) {
      fail(
        sourceName,
        draft.line,
        `スライド "${draft.title}": 箇条書きと表・画像・コードは同じスライドに併用できません。`,
      );
    }
  } else if (layout !== "title" && draft.rows.length === 0) {
    fail(sourceName, draft.line, `スライド "${draft.title}": 表の行（| ラベル | 本文 |）がありません。`);
  }

  const slide: Record<string, unknown> = { title: draft.title };
  if (draft.name !== undefined) slide.name = draft.name;
  if (layout !== "table") slide.layout = layout;

  if (layout === "title") {
    if (draft.subtitle.length > 0) slide.subtitle = draft.subtitle;
    if (draft.paragraphs.length > 0) {
      slide.credits = draft.paragraphs.map((paragraph) => paragraph.text);
    }
    return slide;
  }

  if (layout === "bullets") {
    slide.items = draft.items.map(toBulletOutput);
    return slide;
  }

  slide.rows = draft.rows;

  if (layout === "table-image") {
    if (draft.code) {
      slide.code = draft.code;
    } else {
      const image = draft.images[0];
      if (image) {
        slide.image = { path: image.path, alt: image.alt, ...pickAdjust(image) };
      }
    }
  }

  if (layout === "table-images") {
    slide.images = draft.images.map((image, index) => {
      if (image.title === undefined) {
        fail(
          sourceName,
          draft.line,
          `スライド "${draft.title}": 2図レイアウトでは images[${index}] に図タイトルが必要です（![alt](path "title") の形式）。`,
        );
      }
      return { path: image.path, alt: image.alt, title: image.title, ...pickAdjust(image) };
    });
  }

  return slide;
}

/** Markdown 文字列をデッキオブジェクトに変換する（検証は normalizeDeckData で行う） */
export function parseMarkdownDeck(source: string, sourceName = "deck.md"): Record<string, unknown> {
  const lines = source.replace(/^﻿/, "").split(/\r?\n/);
  const { meta, nextLine } = parseFrontMatter(lines);

  const slides: Record<string, unknown>[] = [];
  let current: SlideDraft | null = null;
  let pendingHeaderRow = false;

  const pushCurrent = (): void => {
    if (current) {
      slides.push(finalizeSlide(current, sourceName));
      current = null;
    }
  };

  for (let i = nextLine; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const raw = lines[i] ?? "";
    const text = raw.trim();

    if (text === "") {
      continue;
    }

    if (text === "---") {
      pushCurrent();
      continue;
    }

    const heading = text.match(HEADING_PATTERN);
    if (heading) {
      pushCurrent();
      let parsed: ReturnType<typeof parseHeading>;
      try {
        parsed = parseHeading(heading[1] ?? "");
      } catch (error) {
        fail(sourceName, lineNo, error instanceof Error ? error.message : String(error));
      }
      if (parsed.title === "") {
        fail(sourceName, lineNo, "スライドタイトルが空です。");
      }
      current = {
        line: lineNo,
        title: parsed.title,
        rows: [],
        images: [],
        subtitle: [],
        paragraphs: [],
        items: [],
        listStack: [],
      };
      if (parsed.name !== undefined) current.name = parsed.name;
      if (parsed.layout !== undefined) current.layout = parsed.layout;
      pendingHeaderRow = false;
      continue;
    }

    if (DEEP_HEADING_PATTERN.test(text)) {
      fail(sourceName, lineNo, "見出しは #（スライド）と ##（表紙の副題）のみ使用できます。");
    }

    const comment = text.match(COMMENT_PATTERN);
    if (comment) {
      const directive = (comment[1] ?? "").match(DIRECTIVE_PATTERN);
      if (directive) {
        if (!current) {
          fail(sourceName, lineNo, `${directive[1]} 指定は # 見出しの後に置いてください。`);
        }
        if (directive[1] === "name") current.name = directive[2];
        if (directive[1] === "layout") current.layout = directive[2];
      }
      continue;
    }

    if (!current) {
      fail(sourceName, lineNo, "スライドは # 見出しで始めてください。");
    }

    const subtitle = text.match(SUBTITLE_PATTERN);
    if (subtitle) {
      current.subtitle.push(subtitle[1] ?? "");
      continue;
    }

    const fence = text.match(FENCE_OPEN_PATTERN);
    if (fence) {
      if (current.code) {
        fail(sourceName, lineNo, "1スライドにコードブロックは1つまでです。");
      }
      const codeLines: string[] = [];
      let closed = false;
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const codeLine = lines[j] ?? "";
        if (FENCE_CLOSE_PATTERN.test(codeLine.trim())) {
          closed = true;
          break;
        }
        codeLines.push(codeLine);
      }
      if (!closed) {
        fail(sourceName, lineNo, "コードブロックが閉じられていません（``` が必要です）。");
      }
      if (codeLines.length === 0) {
        fail(sourceName, lineNo, "コードブロックが空です。");
      }
      current.code = { lines: codeLines };
      const language = fence[1];
      if (language) current.code.language = language;
      i = j;
      continue;
    }

    const image = text.match(IMAGE_PATTERN);
    if (image) {
      const rawPath = image[2] ?? "";
      const imagePath = rawPath.startsWith("<") ? rawPath.slice(1, -1) : rawPath;
      const entry: MarkdownImage = { path: imagePath, alt: image[1] ?? "" };
      if (image[3] !== undefined) entry.title = image[3];
      if (image[4] !== undefined) {
        try {
          Object.assign(entry, parseImageAttrs(image[4]));
        } catch (error) {
          fail(sourceName, lineNo, error instanceof Error ? error.message : String(error));
        }
      }
      current.images.push(entry);
      continue;
    }

    if (text.startsWith("|")) {
      const cells = splitCells(text);
      if (cells.every((cell) => TABLE_SEPARATOR_CELL_PATTERN.test(cell))) {
        // GFM ヘッダー区切り: 直前の行はヘッダーなので捨てる
        if (pendingHeaderRow) {
          current.rows.pop();
          pendingHeaderRow = false;
        }
        continue;
      }
      if (cells.length !== 2) {
        fail(
          sourceName,
          lineNo,
          `表の行は "| ラベル | 本文 |" の2セルで指定してください（現在 ${cells.length} セル）。`,
        );
      }
      const labelLines = cellToLines(cells[0] ?? "");
      const bodyLines = cellToLines(cells[1] ?? "");
      if (labelLines.length === 0 || bodyLines.length === 0) {
        fail(sourceName, lineNo, "表のセルが空です。ラベルと本文の両方を入力してください。");
      }
      current.rows.push({ labelLines, bodyLines });
      pendingHeaderRow = current.rows.length === 1;
      continue;
    }

    const listItem = raw.match(LIST_PATTERN);
    if (listItem) {
      addListItem(current, indentWidth(listItem[1] ?? ""), listItem[2] ?? "", sourceName, lineNo);
      continue;
    }

    // それ以外のプレーン行は段落（表紙の credits）。表紙以外では finalizeSlide でエラーにする
    current.paragraphs.push({ line: lineNo, text });
  }

  pushCurrent();

  const deck: Record<string, unknown> = {};
  if (meta.deckTitle !== undefined) deck.deckTitle = meta.deckTitle;
  deck.slides = slides;
  return deck;
}
