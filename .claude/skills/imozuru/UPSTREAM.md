# 取り込み元

[MaryCache/imozuru](https://github.com/MaryCache/imozuru)（MIT。`LICENSE`）の commit 1bd9fa9 を取り込んだもの。

- 取り込み元の `skills/imozuru/` をこのフォルダに、`examples/demo/` と `tests/` をこのフォルダの下に置いた（テストのスクリプトの場所だけ直した）
- CanvCode とつなぐために足したもの：`references/canvcode.md`、`scripts/canvas.py`、`tests/test_canvas.py`、SKILL.md の CanvCode の行（説明・置き場・渡す・抜き書きのページ・道具）
- それ以外（調べものの進め方とスクリプト）は取り込み元のまま。取り込み元を更新したら、上の差分を残して写し直す

テスト: このフォルダで `python3 -I -m unittest discover -s tests`
