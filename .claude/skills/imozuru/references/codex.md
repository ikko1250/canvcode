# Codex で動かす

Codex（OpenAI の Codex CLI）でこのスキルを使うときの違い。
調べものの進め方（問いと主張・検索役・周・止めどき・抜き書きの照合）は SKILL.md のまま変えない。変わるのは、検索役の起こし方・サンドボックス・Web 検索の3つ。

## 呼び方と置き場

- Codex はユーザーのスキルを `~/.agents/skills/` から読む。Claude Code と同じフォルダを指すシンボリックリンクを置けば、1つの写しを両方が使う: `ln -s <このフォルダ> ~/.agents/skills/imozuru`
- 明示して呼ぶときは `/imozuru` ではなく `$imozuru`（見張りは `$imozuru watch <話題>`）

## 検索役

- 検索役は `spawn_agent` で起こし、`wait_agent` で戻りを待つ。Codex は頼まれないとサブエージェントを起こさないが、このスキルが検索役を頼んでいるので起こしてよい
- 同時に2本まで（SKILL.md の「境界」）。軽いモデルを選べるなら選ぶ。選べなければ既定のモデルのまま
- 検索役もシェルを使えるので、頼み方に「ファイルを書かない・curl などで取らない・Web 検索だけで探す」を入れる
- 戻らない検索役は `interrupt_agent` で止め、log.md に書く
- **返す前に `list_agents` で、自分が起こした検索役が残っていないか確かめる**（SKILL.md の「4. 渡す」）

## サンドボックス

既定の `workspace-write` では、シェルのネットワークが切れていて、作業フォルダ（cwd）と /tmp の外へは書けない。このスキルは両方に当たる。

- ネットワークが要る: `fetch.py`・`chain.py`・`watch.py add|check`。`require_escalated` で頼み、理由に「原文を保存する」「引用をたどる」「新着を引く」と書く
- 置き場の `~/research/<話題>/` は cwd の外なので、`fetch.py`・`report.py`・`canvas.py`・`watch.py`、map.md と log.md の書き込みも頼むことになる。CanvCode のワークスペースが cwd の外のときも同じ
- 毎回頼むのが重いときは、ユーザーに `~/.codex/config.toml` へ次を足してもらう（エージェントは自分で書き換えない）:
  ```toml
  [sandbox_workspace_write]
  network_access = true
  writable_roots = ["/home/<ユーザー>/research"]
  ```
- 断られたら、断られたコマンドと理由を log.md に書き、ユーザーに渡す（SKILL.md の「6. 流れのほうで気づいた問題」）。ネットワークの要らない手（保存済みの本文を grep する）は先に進めてよい

## Web 検索

- 検索役の検索は Codex の `web_search` を使う。既定（`cached`）は前もって集めた索引を引くので、新しい記事や動画が出ないことがある。新しいものが要る分野では、`codex --search` で起動するか、config に `web_search = "live"` を足してもらう
- Codex には検索の深さの切り替えが無いので、SKILL.md の「深い検索で引き直す」は飛ばす。欲しい種類が0件のときは、場の名前（YouTube・note・Qiita など）を検索語に入れて引き直す
- 見張り（`watch.py`）は RSS を引くので、Web 検索の設定に関係ない

## CanvCode

`~/.codex/config.toml` に `[mcp_servers.canvcode]` があれば、Claude Code と同じ MCP がつながる。道具の名前と使い方は同じなので、`references/canvcode.md` のとおりにする。
