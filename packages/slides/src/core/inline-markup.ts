/**
 * 最小限のインライン装飾。現状は `**強調**` のみ対応。
 * JSON / Markdown どちらの入力でも同じ扱いになる。
 */

export type InlineSegment = {
  text: string;
  bold: boolean;
};

const BOLD_PATTERN = /\*\*([^*]+?)\*\*/g;

export function parseInlineMarkup(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let last = 0;

  for (const match of text.matchAll(BOLD_PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) {
      segments.push({ text: text.slice(last, index), bold: false });
    }
    segments.push({ text: match[1] ?? "", bold: true });
    last = index + match[0].length;
  }

  if (last < text.length) {
    segments.push({ text: text.slice(last), bold: false });
  }

  return segments.length > 0 ? segments : [{ text: "", bold: false }];
}

/** 装飾記号を除いた表示文字列（文字数見積もり用） */
export function stripInlineMarkup(text: string): string {
  return parseInlineMarkup(text)
    .map((segment) => segment.text)
    .join("");
}
