# md2pdf（取り込んだもの）

Markdown の File を PDF にするときの見た目（`../src/markdownPdf.ts` が使う）。
https://github.com/ikko1250/md2pdf の 781f31f から、次のファイルをそのまま写した。

- `pandoc-lualatex-mplus.tex`：紙・余白・フォント（M PLUS 1p）・行間・字下げなど
- `filters/*.lua`：pandoc の Lua フィルタ（図の前の改ページ、参考文献のぶら下げ）
- `filters/preserve-extra-blank-lines.py`：2 行以上続く空行を、PDF でも空きとして残す

見た目を変えるときは、md2pdf のほうを直してから写し直す。
環境変数 `CANVCODE_MD2PDF` に md2pdf を clone したフォルダを渡すと、ここではなくそちらを使う。

`canvcode-images.lua` は CanvCode のもの（md2pdf にはない）。画像のパスを、画面のプレビューと同じ規則で探す。
`canvcode-align.lua` も CanvCode のもの。`<p align="center">`・`<div align="center">`（right も）の寄せを、PDF でも center・flushright で効かせる。

`pandoc-lualatex-mplus.tex` の末尾の「コードブロック」の数行（fvextra で長い行を折り返す）と、`\setmainjfont`・`\setsansjfont` の `AutoFakeSlant`（和文の斜体）も CanvCode で足したもので、md2pdf にはまだない。写し直すときは消さないこと。

## 要るもの

- pandoc、LuaLaTeX（Ubuntu なら `pandoc texlive-luatex texlive-lang-japanese texlive-latex-recommended texlive-latex-extra`）
- python3
- フォント M PLUS 1p（Google Fonts の `ofl/mplus1p`。Ubuntu の fonts-mplus には入っていない）
- SVG の画像を使うなら rsvg-convert（`librsvg2-bin`）
