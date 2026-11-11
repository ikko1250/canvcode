# 取り込み元

[MaryCache/imozuru](https://github.com/MaryCache/imozuru)（MIT。`LICENSE`）の commit 1bd9fa9 を取り込んだもの。

- 取り込み元の `skills/imozuru/` をこのフォルダに、`examples/demo/` と `tests/` をこのフォルダの下に置いた（テストのスクリプトの場所だけ直した）
- CanvCode とつなぐために足したもの：`references/canvcode.md`、`scripts/canvas.py`、`tests/test_canvas.py`、SKILL.md の CanvCode の行（説明・置き場・渡す・抜き書きのページ・道具）
- 原文の URL を残すために足したもの（CanvCode の MAI-97）：`scripts/fetch.py` の sources.json（`record_source`）と .md の先頭の出典の行（`stamp_md`・`SOURCE_LINE`）、`scripts/report.py` の unreached の `{title, url, reason}` の形とリンク（`unreached_items`・`web_url`）、`scripts/canvas.py` の PDF の Portal の下と届かなかったもののリンクカード（`--no-links`）、`examples/demo/extracts.json` の unreached の形、`tests/test_report.py` と test_fetch.py・test_canvas.py のその検査、SKILL.md の sources.json・出典の行・unreached の形の行
- Codex でも使うために足したもの：`references/codex.md`、`agents/openai.yaml`（Codex の UI に出す名前と説明）、SKILL.md の「検索役のサブエージェント」の Codex の行
- それ以外（調べものの進め方とスクリプト）は取り込み元のまま。取り込み元を更新したら、上の差分を残して写し直す

テスト: このフォルダで `python3 -I -m unittest discover -s tests`
