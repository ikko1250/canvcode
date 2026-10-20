# CanvCode とつなぐ

CanvCode の MCP（`canvcode`。`list_documents` や `edit_canvas` がある）がつながっているときの置き場と渡し方。
調べものの進め方（問いと主張・検索役・周・止めどき・抜き書きの照合）は SKILL.md のまま変えない。変わるのは、置く場所と、最後に渡す形だけ。

## 置き場

- `list_documents` を1回呼び、返ってくる `workspace`（CanvCode のワークスペースのフォルダの絶対パス）を見る
- 話題のフォルダは `<workspace>/research/<話題>/` にする（ユーザーが別の場所を言えばそこ。ただしワークスペースの外に置くと、下のつなぎ方は使えない）
- ワークスペースの中の `.md`・`.py`・`.csv` は、書いただけで CanvCode の文書になる（サイドバーの「未配置」に出る）。だから map.md・log.md・`sources/*.md`（HTML と字幕を文字にしたもの）・`watch/*.md` は、ブラウザでもそのまま読める。`.pdf` と `.txt` は文書にならない（PDF は下の Canvas で Portal にする）
- MCP の `create_document` は使わない。ファイルは今までどおり `fetch.py` とエディタで書く（`create_document` はワークスペースの直下にしか作れない）

## ref: から始める

依頼に `ref:XXXXXXXXXX` があれば、ユーザーが CanvCode で選んだ所を指している。調べ始める前に `resolve_reference` で読む。

- 文書の行・PDF の範囲なら、その文と、ファイルのパス（`absPath`、PDF は `textPath`）が返る。そこに出てくる用語・人・引いている文献を map.md の 0周目の手がかりにし、log.md に「ref:… から始めた」と書く
- その PDF がすでに `sources/` にある原文なら、後ろへたどる起点にする（参考文献の節を grep する）
- ref は3日で消える。読めなければ、もう一度コピーしてもらう

## 渡す（Canvas に並べる）

SKILL.md の「抜き書きのページ」で `report.py` の照合が通り report.html ができたら、同じ抜き書きを CanvCode の Canvas にも並べる。

1. `scripts/canvas.py <topic_dir> --workspace <workspace>` を回す。report.py と同じ照合をもう一度行い、通れば `<topic_dir>/canvas.json`（`label` と `ops`）を書く。通らなければ何も書かずに止まる
2. ユーザーが見ている Canvas（`list_canvases` の viewing）に、この調べもの用の Canvas の Portal を作る:
   `edit_canvas({ ops: [{ "op": "create", "type": "portal", "as": "r", "name": "imozuru: <話題>" }], label: "imozuru: <話題>" })`
   結果の `canvases.r.canvas` が新しい Canvas の id
3. その Canvas に canvas.json を流す: `edit_canvas({ canvas_id: <新しい Canvas>, label: <canvas.json の label>, ops: <canvas.json の ops> })`。ops は書き換えずにそのまま渡す（付箋の文は照合済みの原文なので、手で直すと言い換えになる）
4. 返事の「抜き書きのページ」の行に、report.html のパスと並べて「CanvCode の Canvas『imozuru: <話題>』」と書く

並ぶもの:

- 左から主張ごとの列。列の頭の付箋に主張・状態（付いた／一部だけ／付かなかった で色が変わる）・注記、その下に抜き書きの付箋（印・「原文」・訳・`file:行`。PDF の .txt なら何ページ目か）
- 食い違いの列、届かなかったものの付箋
- 右の列に map.md・log.md のカードと原文。Markdown の原文はカード、PDF は Portal（その PDF を取り込み、ページの Canvas を作る。`edit_canvas` の create type `pdf`）。抜き書きの付箋から原文へ点線の矢印
- 取り込んだ PDF の結果には `textPath`（CanvCode が取り出した文字。ページごとに `=== page N ===`）が付く。pdftotext の .txt と行がずれるので、抜き書きの行番号は今までどおり `sources/` の .txt で数える

Canvas に置いたあとは、ユーザーが付箋を動かしたり書き足したりしてよい。エージェントは canvas.json を流し直さない（同じものがもう1組できる）。やり直すときは、結果の `batch` を `undo_canvas_edit` で取り消してから流す。

## 見張り

`watch.py check` の結果（`watch/<日付-時刻>.md`）はワークスペースの中の Markdown なので、CanvCode でそのまま読める。Canvas には並べない（要約も並べ替えもしない一覧なので、ファイルのままでよい）。

## 使えないとき

- MCP がつながっていない、または `edit_canvas` が `pdf` / `portal` を受け付けない（古い CanvCode）なら、SKILL.md のとおり `~/research/` に置き、report.html だけを渡す
- `canvas.py` が「操作が 500 個を超える」と止まったら、主張を半分ずつにした extracts.json を2つ作り、Canvas を2つにする
