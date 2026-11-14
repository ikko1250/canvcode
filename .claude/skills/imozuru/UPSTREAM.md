# 取り込み元

[MaryCache/imozuru](https://github.com/MaryCache/imozuru)（MIT。`LICENSE`）の commit 1bd9fa9 を取り込んだもの。

- 取り込み元の `skills/imozuru/` をこのフォルダに、`examples/demo/` と `tests/` をこのフォルダの下に置いた（テストのスクリプトの場所だけ直した）
- CanvCode とつなぐために足したもの：`references/canvcode.md`、`scripts/canvas.py`、`tests/test_canvas.py`、SKILL.md の CanvCode の行（説明・置き場・渡す・抜き書きのページ・道具）
- 原文の URL を残すために足したもの（CanvCode の MAI-97）：`scripts/fetch.py` の sources.json（`record_source`）と .md の先頭の出典の行（`stamp_md`・`SOURCE_LINE`）、`scripts/report.py` の unreached の `{title, url, reason}` の形とリンク（`unreached_items`・`web_url`）、`scripts/canvas.py` の PDF の Portal の下と届かなかったもののリンクカード（`--no-links`）、`examples/demo/extracts.json` の unreached の形、`tests/test_report.py` と test_fetch.py・test_canvas.py のその検査、SKILL.md の sources.json・出典の行・unreached の形の行
- Codex でも使うために足したもの：`references/codex.md`、`agents/openai.yaml`（Codex の UI に出す名前と説明）、SKILL.md の「検索役のサブエージェント」の Codex の行
- サブエージェントを細かく分けるために変えたもの（2026-11-13）：SKILL.md の「サブエージェント（検索役と読み取り役）」の節（取り込み元の「検索役のサブエージェント」を置き換えた。Haiku を前提に、1本を10万トークンを目安に切ること（上限ではない）・起動する順番・brief-search.md と brief-reading.md・candidates/）、0周目の検索役の並べ方、各周で検索役を出し直すこと、「境界」の検索役の同時起動の上限（取り込み元は2本まで）を外したこと、references/codex.md の検索役の数の行。2026-11-14 に「親の頼みの回数を減らす」の節を足した（知らせごとに道具を使わず、一まとまりが戻ってから log.md と map.md をまとめて1回で書き足す）
- それ以外（調べものの進め方とスクリプト）は取り込み元のまま。取り込み元を更新したら、上の差分を残して写し直す

テスト: このフォルダで `python3 -I -m unittest discover -s tests`
