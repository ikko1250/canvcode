// Markdown カードの見た目（MAI-9）。旧実装の markdown-card の CSS を流用している（MAI-3）。
// DOM で表示するときも、画像に変換するときも、同じ HTML と CSS を使う。

export const MARKDOWN_CARD_CSS = `
.md-card {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  overflow: hidden;
  color: #2b2930;
  background: #fffdf7;
  border: 1px solid rgba(80, 66, 45, 0.28);
  border-radius: 10px;
  /* system-ui は、DOM と SVG の画像とで違うフォントに解決されることがあり、改行の位置がずれる。
     DOM と画像で同じフォントになるよう、フォント名を明示する（MAI-21） */
  font-family: 'Noto Sans JP', 'Noto Sans CJK JP', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', 'Meiryo', sans-serif;
}
.md-card-header {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
  min-height: 36px;
  box-sizing: border-box;
  padding: 7px 12px;
  background: rgba(245, 231, 197, 0.55);
  border-bottom: 1px solid rgba(80, 66, 45, 0.16);
}
.md-card-type {
  padding: 2px 5px;
  color: #795b22;
  background: rgba(209, 166, 76, 0.24);
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.md-card-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 700;
}
.md-card-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 18px 22px 28px;
  font-size: 16px;
  line-height: 1.65;
}
.md-card-body h1, .md-card-body h2, .md-card-body h3,
.md-card-body h4, .md-card-body h5, .md-card-body h6 {
  margin: 0.65em 0 0.35em;
  line-height: 1.25;
}
.md-card-body h1 { font-size: 1.7em; }
.md-card-body h2 { font-size: 1.4em; }
.md-card-body h3 { font-size: 1.2em; }
.md-card-body > :first-child { margin-top: 0; }
.md-card-body p { margin: 0.5em 0; }
.md-card-body table {
  width: max-content;
  max-width: 100%;
  margin: 0.8em 0;
  border-collapse: collapse;
  font-size: 0.92em;
}
.md-card-body th, .md-card-body td {
  padding: 0.35em 0.65em;
  border: 1px solid rgba(80, 66, 45, 0.24);
  vertical-align: top;
}
.md-card-body th { background: rgba(80, 66, 45, 0.08); font-weight: 700; }
.md-card-body img {
  display: block;
  max-width: 100%;
  max-height: 280px;
  margin: 0.5em 0;
  object-fit: contain;
}
.md-card-body .markdown-math-block { margin: 0.65em 0; padding: 0.2em 0; text-align: center; }
.md-card-body .markdown-math-error { color: #a40000; }
.md-card-body ul, .md-card-body ol { margin: 0.45em 0; padding-left: 1.5em; }
.md-card-body li { padding-left: 0.2em; }
.md-card-body li input { margin: 0 0.45em 0 0; vertical-align: middle; }
.md-card-body blockquote {
  margin: 0.8em 0;
  padding: 0.35em 0.9em;
  color: #655f65;
  border-left: 3px solid rgba(170, 59, 255, 0.42);
}
.md-card-body hr { margin: 1.1em 0; border: none; border-top: 1px solid rgba(80, 66, 45, 0.2); }
.md-card-body pre {
  margin: 0.8em 0;
  padding: 10px 12px;
  background: rgba(30, 28, 26, 0.08);
  border-radius: 6px;
  font-size: 0.86em;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.md-card-body code {
  padding: 0.08em 0.28em;
  background: rgba(80, 66, 45, 0.1);
  border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, 'DejaVu Sans Mono', monospace;
  font-size: 0.9em;
}
.md-card-body pre code { padding: 0; background: transparent; }
.md-card-body a { color: #6d43bd; text-decoration: underline; }
/* 大きさを固定したカードで、収まらない分は下端をぼかして切る（MAI-30） */
.md-card-body { position: relative; }
.md-card.clipped .md-card-body::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 64px;
  background: linear-gradient(rgba(255, 253, 247, 0), #fffdf7 85%);
}
/* ショートカットのカードは、種類の印に ↗ を付ける */
.md-card-shortcut { color: #6d43bd; font-size: 11px; font-weight: 700; }
`

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

// bodyHtml は renderMarkdown で無害化済みのもの
export function buildMarkdownCardHtml(
  title: string,
  bodyHtml: string,
  options: { clipped?: boolean; shortcut?: boolean } = {},
): string {
  return (
    `<div class="md-card${options.clipped ? ' clipped' : ''}">` +
    `<div class="md-card-header"><span class="md-card-type">MD</span>` +
    (options.shortcut ? `<span class="md-card-shortcut">↗</span>` : '') +
    `<span class="md-card-title">${escapeText(title)}</span></div>` +
    `<div class="md-card-body">${bodyHtml}</div>` +
    `</div>`
  )
}
