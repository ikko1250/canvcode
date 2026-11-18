# パネルで Gemini（agy）を使う件

**見送り（2026-11-17）。** 画面の右のパネル（`apps/server/src/claude/`）で Gemini も選べるようにするため、サーバーから Google の Antigravity CLI（`agy`）をヘッドレスモード（`agy -p`）か ACP（`agy acp`）で動かすことを考えた。規約を調べると、個人向けプランのログインのまま CanvCode から agy を動かすのは、認められていない側に入ると読めた。そのため実装しなかった。この文書は、あとで再開するときのために、調べたことを残す。

## 結論と理由

「ヘッドレスモードで動かすのは規約上 OK らしい」は、一次情報では確かめられなかった。一次情報は逆を向いている。引用はどれも 2026-11-17 に取得した。

FAQ（https://antigravity.google/docs/faq ）：

> Antigravity CLI headless mode (`agy -p`) is intended for direct scripting and CI workflows. Wrapping `agy` inside third-party coding agents or applications, or automating account rotation, is not supported under consumer plans.

> Such actions can result in suspension or termination of your account.

> To use a third-party coding agent with Gemini, we recommend using a Gemini Enterprise or Google AI Studio API key.

追加規約の第 6 項（https://antigravity.google/terms ）：

> You must not abuse, harm, interfere with, or disrupt the Service. This includes, but is not limited to, using the Service in connection with products not provided by us. Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts.

同じ規約の冒頭には、Gemini Enterprise（Google Cloud）か、Gemini for business の API キーで使う場合は、管理者が受け入れた・署名した利用条件に従う、とある。つまりそれらで使う場合は、個人向けプランとは別の条件になる。

CanvCode のサーバーが agy を子プロセスで動かし、画面からの依頼を渡す形は、FAQ の「アプリケーションに agy を包む（wrapping）」に当たると読める。ACP の文書（https://antigravity.google/docs/cli/acp ）は、Zed・JetBrains IDE・Android Studio・Xcode などのエディタから使うためのもので、どのプラン・どの認証で使えるかは書いていない。

## フォーラムの回答（規約ではない）

Google AI Developers Forum（discuss.ai.google.dev）の回答。規約そのものではない。どの回答者にも、取得したページの上ではスタッフの印が見えなかった。

- **許すと答えたもの（9 月末〜10 月初め）**
  - 9-30：chunduriv（https://discuss.ai.google.dev/t/185992 ）。手元の AI のコーディングアシスタントから公式の `agy` を呼ぶことに「Yes」と答えた。条件は、自分 1 人が自分のマシンで使うことと、キャッシュした OAuth のトークンを取り出して外に渡さないこと
  - 10-07：chunduriv（https://discuss.ai.google.dev/t/186246 ）。手を加えていない `agy` を手元でヘッドレス（`agy -p … --output-format stream-json` など）に、自分の個人向けサブスクリプションで動かすのは「permitted」と答えた。条件は、自分 1 人の作業に限り、共有しない・まとめない・複数人のサービスにしないこと
- **許さないと答えたもの（10 月 8 日から）**
  - 10-08：chunduriv（https://discuss.ai.google.dev/t/187241 ）。"we do not support using third-party coding agents (like Codex, Claude Code, OpenClaw, or OpenCode) … to orchestrate or wrap `agy` under a consumer login."
  - 10-16：Rebbanpalli_Naveen（https://discuss.ai.google.dev/t/189905 ）。FAQ が、食い違う前のフォーラムの回答に優先する（"supersedes earlier forum comments where they differ"）と答えた。手を加えていない `agy` を手元で子プロセスとして動かす場合も、サードパーティのエージェントやアプリケーションに包むなら、個人向けプランでは「No」とした
  - 11-12：Rebbanpalli_Naveen（https://discuss.ai.google.dev/t/199303 ）。CanvCode にいちばん近い例。質問者は、自分のアカウントだけが入れる非公開の Web アプリから公式の `agy acp` を stdin / stdout で動かしていた。共有も転売もせず、OAuth のトークンも取り出していなかった。回答は "not permitted on consumer `oauth-personal` plans" で、自分 1 人で使う場合も同じだとした。代わりに、Antigravity の Remote Control / Remote Agents を使うことと、`agy acp` を Google AI Studio の API キー（`GEMINI_API_KEY`）か Google Cloud（`agent-platform`）で動かすことを勧めた
- **止められたという報告**（https://discuss.ai.google.dev/t/199882 ）
  - 2026-11-12 ごろから、公式の CLI しか使っていないのに 403（`PERMISSION_DENIED`、利用規約に反したため無効にした）を受けた、という報告が複数ある
  - その 1 人は、Claude Code から短い `agy -p` を 10 回ほど、読むだけのモードで動かしただけだった
  - 11-13 のスタッフ側の回答：`agy -p` を直接のスクリプトや CI で動かすのは想定どおりの使い方。Claude Code・OpenCode・OpenClaw などのサードパーティのコーディングエージェントから、個人向けのログインで `agy` を呼ぶのは認めない。フォーラムでは個々のアカウントは見られないので、異議申し立てのフォームを使う

## 確かめられなかったこと

- 自作の個人用アプリが、規約の "products not provided by us" や "third party software" に入るかどうか。規約に定義がない（フォーラムの 11-12 の回答は、入るとしている）
- FAQ の "not supported" が、規約違反と同じ意味かどうか

## 再開するなら

個人向けプランのログインでは動かさない。Google AI Studio の API キー（従量課金）か、Gemini Enterprise / Google Cloud（`agent-platform`）で動かす。

### 設計の要点

- **認証を分ける**
  - agy を CanvCode 専用の設定フォルダ（`agy acp --gemini-dir` か `--app-data-dir`。個人のログインのトークンが置かれていない場所）と `GEMINI_API_KEY` で、ACP で動かす
  - changelog には「`settings.json` が API キーの認証を指していても、`GEMINI_API_KEY` がなければ保存したログインに戻る」とある。なので、専用のフォルダで個人のログインに落ちないことを、最初に確かめる
- **許可を通す**
  - 専用の設定なので、許可を尋ねる設定にできる（ユーザーの `~/.gemini/antigravity-cli/settings.json` は `toolPermission: always-proceed` で、ほとんど尋ねない）
  - 尋ねられた `session/request_permission` を、`jobs.ts` の画面での問い合わせ（`ask`）と `guardTool`（`permissions.ts`。ワークスペースの外と `.canvcode/` には書かせない）に通す
- **jobs.ts を複製しない**
  - `RunQuery`（`apps/server/src/claude/session.ts` の差し込み口）を、agy 用のアダプターに差し替える
  - アダプターは、agy の出来事を `jobs.ts` が読む SDKMessage の形（assistant の text / tool_use と `user_message_uuids`、result）に直す
  - ツールの名前は Claude のものに直す。こうすると `toolDetail`・画面の `TOOL_LABELS`・`askTool` がそのまま使える

    | agy | Claude |
    | --- | --- |
    | `run_command` | Bash |
    | `view_file` | Read |
    | `write_to_file` | Write |
    | `replace_file_content`・`multi_replace_file_content` | Edit |
    | `grep_search` | Grep |
    | `find_by_name`・`list_dir` | Glob |
    | `search_web` | WebSearch |
    | `read_url_content` | WebFetch |
    | canvcode の MCP | `mcp__canvcode__<tool>` |
    | `invoke_subagent` | Agent |
  - `interrupt` は `session/cancel` にする。`stopTask` は断る（agy の作業は 1 つずつは止めない）
- **会話はプロバイダーに固定する**
  - Claude Code の session を agy で続けることはできないので、会話は始めたプロバイダーのまま使う
  - `store.ts` の jobs に `provider` の列を足す（NULL は claude）。会話の途中で別のプロバイダーのモデルを選んだら 409 で断り、画面は「新規」で始めるよう出す
- **モデルの一覧**
  - `agy models` の出力（`id<TAB>表示名`）から Gemini のものだけを取る
  - effort の接尾辞を外してまとめる（`gemini-4-argon` ＝ Gemini 4 Argon、effort は low / medium / high）
  - `ModelChoice` に `provider` を足し、モデルを選ぶ欄では Claude の系統のあとに別のまとまりとして出す
- **その他**
  - 費用（USD）は出ないので、画面にも出さない
  - 有効にするのは環境変数で入れたときだけにする
  - 会話を消しても、agy の側の会話の記録は消えないので、そのことを README に書く

### 先に確かめること

1. `session/new` の答え（モデルの一覧・モード・configOptions）。`mcpServers` に http の canvcode を渡せるか
2. `session/update` の形（`agent_message_chunk`・`tool_call` の title / kind / rawInput に、agy のツールの名前と引数が入るか）
3. `session/request_permission` が来る条件（モードと設定による）
4. ターンの途中の `session/cancel`（ターンだけが止まり、プロセスは残るか）
5. 途中でのモデルの切り替え（`session/set_model` か `set_config_option`）
6. プロセスを立て直したあと、`session/load` か `session/resume` で続けられるか
7. `_meta.antigravity.systemPrompt.append` が効くか
8. API キーで使えるモデル（個人向けプランの一覧と違うかもしれない）

## このマシンで確かめた agy の事実（2026-11-17）

使ったのは agy 1.4.9（`agy acp` の initialize は、ACP サーバー 1.5.10 と答えた）。

- **`agy -p "…" --output-format stream-json` の出力**：1 行に 1 つの JSON
  - `init`：`conversation_id` と、`init.model`・`init.cwd`・`init.tools`（`run_command`・`view_file`・`write_to_file`・`grep_search`・`search_web`・`call_mcp_tool`・`invoke_subagent` など）・`init.permission_mode`
  - `step_update`：`step_type` が `user_input`・`agent_response`・`tool` のどれか、`state` が `ACTIVE` か `DONE`
    - `agent_response` は、文を `text_delta` で少しずつ流す
    - `tool` は `tool_name` を持ち、`tool_info.parameters`（例：`read_file` の `Path`、`run_command` の `CommandLine`）を持つ。`DONE` のときは `tool_info.output` も持つ
    - ステップごとに `usage`（入出力・思考・キャッシュのトークン数）を持つ
  - `result`：`status`（`SUCCESS` など）・`response`（答えの全文）・`duration_seconds`・`num_turns`・`usage`。**費用（USD）はない**
- **`agy -p` のフラグ**：`--input-format stream-json` は、stdin から 1 行に 1 つのメッセージを読み、メッセージごとに 1 ターン動かす。ほかに `--conversation`（続き）・`--model`・`--effort`・`--mode`（accept-edits / auto / plan）・`--json-schema`（構造化出力）・`--sandbox`・`--dangerously-skip-permissions`・`--add-dir`。MCP をその場で渡すフラグはなく、`agy mcp add` で全体に登録する
- **`agy acp` の initialize の答え**
  - `loadSession: true`
  - `sessionCapabilities`：resume・close・load・list・additionalDirectories
  - `promptCapabilities`：image・embeddedContext
  - `_meta.antigravity.systemPrompt.append: true`
  - authMethods：`oauth-personal`・`oauth-business`・`gemini-api-key`・`agent-platform`
  - `mcpCapabilities` は答えになかった
- **`agy acp` のフラグ**：`--gemini-dir`・`--app-data-dir`・`--cli_dir_name`・`--process-per-session`・`--sandbox`・`--dangerously-skip-permissions`・`--login`・`--disable-telemetry`
- **モデルの id**：effort ごとに分かれている（`gemini-4-argon-low|medium|high`、`gemini-4-hydrogen-low|medium|high|xhigh`、`gemini-3.8-flash-low|medium|high`）。一覧には Claude のモデルと `gpt-oss-120b-medium` もある
- **全体の設定**
  - canvcode の MCP は、全体の設定に登録してある（`agy mcp list`）
  - 全体のフック（`~/.gemini/config/hooks.json`）は、PreToolUse で `{"decision":"ask"}` などを返せる
