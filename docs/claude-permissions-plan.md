# Claude のパネルの許可（MAI-90）

Linear の MAI-90。画面の右のパネルから頼む Claude Code（`apps/server/src/claude/`）の許し方を、2 段に分けて直す。

1. Claude Code が自分で書いたファイル（大きいツールの結果・バックグラウンドの作業の出力）と、読み込んだスキルのファイルを、ファイルのツールで読めるようにする
2. auto mode が自分で決められなかった呼び出しを、画面で「許可」「断る」できるようにする

チケットの背景にある数字は、本番の `.canvcode/claude.db` の記録による。2026-10-20〜11-03 の 286 件の依頼で、断った呼び出しは 15 回だった。そのうち「画面で許可できないから断った」Bash は 0 回、Claude Code が自分で書いたファイルかスキルのファイルを読もうとして断ったものは 7 回だった。

## 確かめた事実（2026-11-03）

実験は、SDK（`@anthropic-ai/claude-agent-sdk` 0.3.304。CLI も同じ版）の `query()` を、使い捨てのフォルダで直接呼んで行った。費用は合わせて約 0.08 ドル。

### SDK の型（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`）

- フックの入力（`BaseHookInput`）にあるもの：`session_id`・`transcript_path`・`cwd`・`prompt_id`・`permission_mode`・`agent_id`・`agent_type`・`effort`
  - `PreToolUse` には、これに加えて `tool_name`・`tool_input`・`tool_use_id`・`mcp_server` がある
  - `agent_id` は、サブエージェントの中の呼び出しのときだけ付く
- `canUseTool(toolName, input, options)` の `options` にあるもの：`signal`・`suggestions`・`blockedPath`・`mcpServer`・`decisionReason`・`title`・`displayName`・`description`・`defaultToNo`・`suppressAlwaysAllowRule`・`toolUseID`・`agentID`・`requestId`・`matchedAskRule`
  - `session_id` と `transcript_path` は**ない**
  - 実際に届いたものには、型に書いていない `decisionReasonType`（`'rule'`・`'workingDir'`）と `serverPolicyAskOnly` もあった
- 返すのは `PermissionResult`（`allow` に `updatedInput`、`deny` に `message` と `interrupt`）。`null` を返してよいのは、答えを別の経路で送ったときだけ
- **問い合わせに期限はない**（「permission prompts have no park deadline」）。答えを返すまで、ツールは止まったまま待つ
- `permissionMode: 'auto'`：「分類のモデルが許すか断るかを決め、決められないときは `canUseTool` で尋ねる」

### ファイルの本当の場所

| もの | 場所 | 実験でわかったこと |
|---|---|---|
| 大きいツールの結果（tool-results） | `<CLAUDE_CONFIG_DIR か ~/.claude>/projects/<cwd を変換した名前>/<session_id>/tool-results/<id>.txt` | `transcript_path`（`…/<session_id>.jsonl`）から `.jsonl` を除いたフォルダの下の `tool-results/`。`CLAUDE_CONFIG_DIR` を外すと `~/.claude/projects/…` に移った |
| バックグラウンドの作業の出力 | `<CLAUDE_CODE_TMPDIR か /tmp>/claude-<uid>/<cwd を変換した名前>/<session_id>/tasks/<task_id>.output` | `CLAUDE_CONFIG_DIR` には従わない。`CLAUDE_CODE_TMPDIR=/tmp/x` にすると `/tmp/x/claude-1001/…` に移った。`<cwd を変換した名前>` は、`transcript_path` のフォルダの名前と同じ |

どちらも次のことがわかった。

- **resume しても session の id は変わらず、同じ場所に書く**：同じ session を resume して、大きい結果を出させた
- **サブエージェントの中でも、親の session の場所に書く**：サブエージェントの中の呼び出しでは、フックの入力の `session_id`・`transcript_path` は親のもので、`agent_id` と `agent_type` が付く。サブエージェントの `agent_id` は、その作業の `task_started` の `task_id` と同じ
- 作業の出力の場所は、`task_notification` の `output_file` にも入っている。`task_started` には入っていない
- 本番で断った 7 件のパスの session の id は、どれもその依頼の session の id と一致した

参考までに、このマシンでは `~/.claude/projects` と Orca のプロフィールの `home/projects` は同じフォルダ（シンボリックリンク）だった。

### スキルの参照ファイルの件の原因

- Claude Code は、プロジェクトのスキルを、**cwd から git のリポジトリの根までのそれぞれの `.claude/skills/`** から読み込む
  - 実験：`outer/.claude/skills/outerskill`・`outer/repo/.claude/skills/reposkill`（`repo` が git の根）・cwd は `outer/repo/ws` にした。読み込まれたのは `reposkill` だけで、根より上の `outerskill` は読み込まれなかった
- 本番のワークスペース（`CanvCode-MAI1/workspace`）には `.claude/` がなく、ワークスペースは CanvCode-MAI1 のリポジトリの中にある
  - そのため、リポジトリの `.claude/skills/imozuru` が読み込まれる
  - Claude はスキルのフォルダ（`/home/ubuntu/prog/2026/CanvCode-MAI1/.claude/skills/imozuru`）の `references/canvcode.md` を Read しようとして、ワークスペースの外なので断られた
- `settingSources: ['project']` のとき、ユーザーのスキル（`~/.claude/skills/` の dcf-valuation・imozuru・ja-research-report）は読み込まれなかった
  - 読み込まれたのは、プロジェクトのスキルと、Claude Code に付いているスキル（deep-research など）だけ
  - README の「スキルはワークスペースの `.claude/skills/` にあるもの」は、正しくは「ワークスペースから git の根まで」

### auto mode で `canUseTool` に来るとき

- 本番の 286 件では 1 回も来ていない（来れば Bash を断り、`denied` が残るはずだが、0 回）
- **ワークスペースの `.claude/settings.json` の `permissions.ask` の規則に当たると、auto mode でも必ず来る**
  - 実験：`{"permissions":{"ask":["Bash(echo canvcode-ask-test:*)"]}}` を置き、`echo canvcode-ask-test hello` を頼んだ
  - `decisionReasonType: 'rule'` が付いて `canUseTool` に来た。`settingSources: ['project']` なので、ワークスペースの設定は読まれる
  - 今のサーバーでは、規則で「尋ねる」と決めたものは、Bash なら必ず断ることになる
- `default` のモードで、ワークスペースの外を Glob すると、`decisionReason: 'Path is outside allowed working directories'`・`decisionReasonType: 'workingDir'` で来た
- **問い合わせを待っているあいだに `interrupt()` すると、`signal` がすぐ abort される**
  - そのツールは「The user doesn't want to proceed…」で断られ、ターンは `error_during_execution` で終わる
  - そのあと同じプロセスに送った次のメッセージには、ふつうに答えた
  - エラーで終わったターンの直後に入力を閉じると、SDK の for await が「Claude Code returned an error result」を投げた。今の止め方（`cancel` → `interrupt`）でも起きうるので、実装のときに確かめる

### 今のファイルのガードの穴

`guardTool` は Glob の `path` だけを見ている。`path` を省き、`pattern` を絶対パス（`/etc/host*`）にすると、ワークスペースの外を探せる。実験では `/etc` の中の 17 個のファイル名が返った。

- auto mode が `canUseTool` に回しても、今の `askTool` は Glob を許す
- 名前が見えるだけで中身は読めないが、「ファイルのツールで読むのはワークスペースの中だけ」という約束とは合わない
- 段階 1 で一緒に直す

## 方針

- **段階 1**：ファイルのツールで読んでよい場所を、ワークスペースのほかに 3 つ足す
  - その session の `tool-results/`
  - その session の作業の出力（`tasks/`）
  - Claude Code が読み込むスキルのフォルダ（ワークスペースから git の根まで）
  - どれも、PreToolUse のフックで、決めた場所の中の**読むだけ**を `allow` にする。書くのは今どおり断る
  - Glob は `pattern` の固定の部分も確かめる
- **段階 2**：`canUseTool` に来た Bash（と、規則で尋ねると決めた呼び出し）を、画面に尋ねて答えを待つ
  - 待っている問い合わせは、会話（thread）に付ける。バックグラウンドの作業と同じ形
  - 尋ねたことと答えは、ジョブの出来事として `claude.db` に残す
  - 10 分たっても誰も答えなければ断る

チケットから変えた点：

- スキルのフォルダの扱いを決めた：Claude Code が読み込む範囲（ワークスペースから git の根まで）と同じにする
- Glob の穴を段階 1 に入れた
- 規則（`permissions.ask`）で尋ねると決めた呼び出しも、画面で尋ねる。これで、ユーザーがワークスペースの設定に「`git push` の前は尋ねる」のような規則を書けるようになる。確かめるときの仕掛けにも使える
- 作業の出力の場所をはっきりさせるため、`CLAUDE_CODE_TMPDIR` をサーバーから渡す（下）

## 段階 1：読んでよい場所の決め方（`apps/server/src/claude/permissions.ts`）

### 形

`guardTool(name, input, workspace)` を `guardTool(name, input, guard)` にする。

```ts
export interface Guard {
  workspace: string
  // ワークスペースのほかに、読むだけなら許すフォルダ（実際のパス。realpath したもの）
  readRoots: readonly string[]
}
```

- 読むツールは、パスがワークスペースか `readRoots` のどれかの中なら許す
- 書くツール（Write・Edit）は、今どおりワークスペースの中だけ。`readRoots` は見ない
- フック（`preToolUseHook`）は、呼び出しごとに `readRoots` を組み立てる
  - 中身は、フックの入力から出す session の 2 つの場所と、スキルのフォルダ
  - パスが `readRoots` の中だった読む呼び出しには、`permissionDecision: 'allow'` を返す（auto mode の判定にも `canUseTool` にも回さない）
  - ワークスペースの中の読む呼び出しは、今どおり何も決めない

### 場所の出し方

フックの入力 `{ session_id, transcript_path }` から出す。

- `transcript_path` の名前が `<session_id>.jsonl` でなければ、場所を足さない（Claude Code の置き方が変わったら、今と同じく断る側に倒れる）
- tool-results：`join(dirname(transcript_path), session_id, 'tool-results')`
- 作業の出力：`join(tmpRoot, 'claude-' + uid, basename(dirname(transcript_path)), session_id, 'tasks')`
  - `uid` は `process.getuid()`
  - `tmpRoot` は、サーバーが Claude Code に渡す `CLAUDE_CODE_TMPDIR`。`options.env` に `CLAUDE_CODE_TMPDIR: process.env.CLAUDE_CODE_TMPDIR ?? tmpdir()` を入れ、Claude Code の既定に頼らない
- スキルのフォルダ：`ClaudeJobs` を作るときに 1 回だけ出す（`skillRoots(workspace)`）
  - ワークスペースから親へたどり、`.git`（フォルダでもファイルでもよい）のあるフォルダで止める。そこまでのそれぞれの `.claude/skills` のうち、あるものを realpath して並べる
  - `.git` が見つからなければ、ワークスペースのものだけにする。Claude Code が根の外まで読む場合は断る側に倒れる。git がないときの Claude Code の動きは、まだ確かめていない
  - ワークスペースの `.claude/skills` は、もとからワークスペースの中なので読める

### ほかの session のものを読ませない

- 場所には、その呼び出しの `session_id` のフォルダだけを入れる
- `~/.claude/projects/<名前>/` や `/tmp/claude-<uid>/<名前>/` の全体は許さない（ほかの会話の結果や transcript が読めてしまうため）
- `tool-results/` と `tasks/` だけを許す。同じ session でも、transcript（`.jsonl`）とサブエージェントの transcript（`<session_id>/subagents/`）は許さない

### シンボリックリンク

今の `inside()` と `realish()`（シンボリックリンクをたどってから比べる）をそのまま使い、`readRoots` も realpath したものにする。

- `tool-results/` の中のシンボリックリンクが外を指していれば、断る
- `~/.claude/projects` 自体がシンボリックリンクでも（このマシンがそう）、両方を realpath するので合う
- スキルのフォルダが外へのシンボリックリンクなら、リンクの先を許す（Claude Code もリンクの先を読み込むため）

### Glob・Grep

- Grep：今どおり `path`（省けば cwd）で確かめる。`glob` の引数は `path` の下を絞るだけなので見ない
- Glob：探す場所を、`path`（省けばワークスペース）と `pattern` の固定の部分から出して確かめる
  - 固定の部分は、`*` `?` `[` `{` を含む最初の区切りより前
  - `pattern` が絶対パスなら、固定の部分をそのまま使う。`..` を含むときは、`path` から解決したあとの場所で確かめる
  - 例：`/etc/host*` は `/etc` なので断る。`../outside/*` も断る。`notes/**/*.md` は許す
  - tool-results の中を探す `pattern`（`<tool-results>/*.txt`）は許す

### サブエージェント

サブエージェントの中の呼び出しも、同じフックを通る。フックの入力の `session_id`・`transcript_path` は親のものなので、そのままで親の session の場所を許す。`agent_id` は見ない。

### `canUseTool`（`askTool`）の側

`askTool` にはフックの入力がない（`canUseTool` の引数に `session_id` がない）。

- 会話ごとに、最後に通ったフックの `readRoots` を `LiveThread` に覚えておき、`askTool` に渡す
- 決めた場所はフックで `allow` にするので、ふつうは `askTool` まで来ない。覚えていないときは、ワークスペースだけで確かめる（断る側に倒れる）

### README

「画面から Claude Code に頼む」の節を直す。

- 「スキルはワークスペースの `.claude/skills/` にあるもの」を、「ワークスペースから git の根までの `.claude/skills/`」にする
- ファイルのツールで読める場所に、3 つの例外を書き足す

## 段階 2：画面で許可する

### 尋ねる呼び出し

`askTool` の判断を次のように変える（`permissions.ts`）。

| `canUseTool` に来た呼び出し | 今 | 変えたあと |
|---|---|---|
| `guardTool` で断るもの | 断る | 断る（尋ねない） |
| Bash | 断る | **尋ねる** |
| `decisionReasonType === 'rule'`（規則で尋ねると決めた） | ツールによって許すか断る | **尋ねる**（ツールを問わない） |
| そのほかの `CLAUDE_TOOLS` と canvcode の MCP | 許す | 許す（今どおり） |
| そのほかのツール | 断る | 断る |

`askTool` は `'allow' | 'deny' | 'ask'` を返し、`'ask'` のときに `ClaudeJobs` が画面に尋ねる。

### 型（`jobs.ts`）

```ts
// 画面で答えを待っている問い合わせ（プロセスが持っているもの。保存しない）
export interface PendingPermission {
  id: string            // randomUUID()。答えるときに使う
  jobId?: string        // そのときの今のジョブ（バックグラウンドのサブエージェントからなら、ない）
  name: string          // ツールの名前（Bash など）
  detail: string        // Bash ならコマンドの全文。ほかは toolDetail と同じもの
  description?: string  // canUseTool の description（Claude が付けた説明）
  agent?: string        // サブエージェントの中なら、その作業の名前（thread.names.get(agentID)）
  reason?: string       // 規則で尋ねたなら 'rule'。blockedPath があれば「<パス> を触ります」
  createdAt: number
  expiresAt: number
}

export interface ThreadInfo extends ThreadSummary {
  tasks: BackgroundTask[]
  permissions: PendingPermission[]   // 足す
}

// JobEvent に 2 つ足す（claude.db の events にそのまま残る。表の形は変えない）
| { kind: 'ask'; id: string; name: string; detail: string; agent?: string }
| { kind: 'answer'; id: string; result: 'allowed' | 'denied' | 'expired' | 'cancelled' }
```

- 問い合わせは**会話（thread）に付ける**
  - バックグラウンドのサブエージェントは、今のジョブがないときにも尋ねてくる
  - `LiveThread` に `permissions: Map<string, { info: PendingPermission; resolve; timer }>` を持つ
- 出来事は、今のジョブがあればそこに `push` し、なければ会話の最後のジョブに足す（`appendToLast`）
- 待っている一覧が変わったら `notifyThread` で知らせる（SSE の `{ type: 'thread' }`）

### 状態の移り方

```
（canUseTool に来る）→ 待つ ─┬─ 許す        → allow（updatedInput はそのまま）  answer: allowed
                             ├─ 断る        → deny「ユーザーが画面で断りました…」 answer: denied
                             ├─ 10 分たつ   → deny「誰も許可しなかったので…」     answer: expired
                             └─ 取り消し    → deny（SDK はもう見ていない）        answer: cancelled
```

- 取り消しになるのは、次の 4 通り。どれでも、一覧から外して `answer: cancelled` を残す
  - SDK の `signal` の abort：ジョブの「止める」（`cancel` → `interrupt`）で、実験どおりすぐ届く
  - 会話の「全部止める」（`stopThread`）
  - プロセスの終わり（`exited`）
  - サーバーを止めるとき（`dispose`）
- 答えたとき、時間切れのとき、取り消したときのどれも、タイマーを止めて一覧から外す。2 回目の答えは 404
- `defaultToNo` は画面に渡し、許可のボタンにフォーカスを置かない。`suppressAlwaysAllowRule` と `suggestions` は使わない（「いつも許す」は出さない）
- 断ったときの `interrupt` は付けない。Claude はターンを続け、代わりの案か、ユーザーへの頼みを書ける

Claude に返す言葉：

- 断った：`The user declined this in the CanvCode panel. Do not run it again; say what you wanted to do and ask how to proceed.`
- 時間切れ：`Nobody approved this in the CanvCode panel within 10 minutes, so it was denied. Ask the user to run it by hand or to ask you again.`

### API（`http.ts`）

- `POST /api/claude/threads/<threadId>/permissions/<id>`、本文は `{ "decision": "allow" | "deny" }`
  - 成功は 204
  - もう待っていない（答えた・時間切れ・取り消した）なら 404 と「その問い合わせはもうありません」
  - `decision` が違えば 400
  - `content-type` が `application/json` でなければ 415（下の「セキュリティ」）
  - id は `[0-9a-f-]{36}`
- `GET /api/claude/threads`・`GET /api/claude/threads/<id>`・SSE の `snapshot` と `thread` には、`ThreadInfo.permissions` がそのまま入る。あとから開いたタブも、つないだときの snapshot で待っている問い合わせを受け取る

### ほかの仕組みとの関係

- **同時に答えを書ける依頼は 2 つまで（`MAX_RUNNING`）**：許可を待っているジョブも動いているジョブとして数える（ターンの途中なので）。待てるのは最長 10 分。429 の言葉に「許可を待っている依頼があれば、答えると進みます」を足す
- **何もしていないプロセスを閉じる（`scheduleIdle`・`makeRoom`）**：待っている問い合わせのある会話は閉じない。条件に `permissions.size > 0` を足す
- **サーバーの再起動**：待っている問い合わせはメモリーにだけあり、プロセスと一緒になくなる
  - 止めるとき（`dispose`）は、取り消しにして `answer: cancelled` を残す
  - 落ちたときは何も残らない。次に起動したときに、ジョブは今どおり「途切れました」になる。画面は、答えのない `ask` を「答えないまま途切れました」と出す
- **時間**：`ClaudeJobsDeps.permissionTimeoutMs`（既定は 10 分。テストでは短くする）。環境変数 `CANVCODE_CLAUDE_PERMISSION_TIMEOUT_MS` で変えられるようにする（決めること 2）
- **システムプロンプト**：`systemPromptAppend` は MAI-89 が行を足すので、こちらは最後の行（「…nobody is watching to approve the ones that are not.」）の 1 行だけを変える
  - 変えたあとの行：`Bash commands are approved or denied automatically; the ones that are not are shown to the user in the panel to approve or decline (unanswered ones are declined after 10 minutes).`

## 画面（`apps/web/src/claude/`）

### パネル（`ClaudePanel.tsx`）

- 入力欄の上（バックグラウンドの作業の一覧の上）に、待っている問い合わせを並べる。古いものが上
- 見出し：「許可を待っています（n）」
- 1 つごとに出すもの：
  - 1 行目：「コマンドを実行」（Bash）か、ツールの名前（`toolLabel`）
  - 2 行目：コマンドの全文。等幅、折り返し、高さの上限つきでスクロール。切らない（判断の材料なので）
  - 3 行目（あれば）：Claude が付けた説明（`description`）、「サブエージェント「…」から」、「ワークスペースの外（<パス>）を触ります」
  - 右端：「あと 9 分で断ります」（1 分ごとに更新）
  - ボタン：［断る］［許可する］。［断る］を左（先）に置く
- ジョブの中の出来事：
  - `ask`：「許可を求めました：<コマンド>」
  - `answer`：「許可しました」「断りました」「時間切れで断りました」「止めたので取り消しました」
  - 答えのない `ask` が、終わったジョブにあれば「答えないまま途切れました」
- 今のジョブの「考えています…」は、そのジョブの問い合わせを待っているあいだは「許可を待っています…」にする
- 会話の一覧（`claude-thread-select`）：待っている問い合わせのある会話の名前に「・許可待ち」を付ける

### パネルの外

`apps/web/src/App.tsx` の Claude のボタン（`claude-toggle`）：どれかの会話に待っている問い合わせがあれば、`waiting` のクラスを付けて印を出す（決めること 4）。パネルが閉じていても気づけるようにする。

### キー操作

- 1 つのキーで許可できるようにはしない（`defaultToNo` の趣旨）。Ctrl+Enter（送る）も Esc（閉じる）も、問い合わせには効かない
- ボタンはふつうの `button`。Tab で移れる。押したあとは、その問い合わせのボタンを無効にする（SSE で一覧から消えるまで）
- パネルの中のキーがキャンバスに渡らないのは、今のまま（`data-own-keys`）

### `claudeClient.ts`

- `ThreadSummary` に `permissions?: PendingPermission[]` を、`JobEvent` に `ask`・`answer` を足す（サーバーと同じ形）
- `answerPermission(threadId, id, decision)` を足す。`content-type: application/json` で POST する
- `threadBusy` に、待っている問い合わせも入れる

## セキュリティ

- **誰が押せるか**：ログインがないので、画面を開ける人なら誰でも押せる
  - 今の「誰でも頼める」と同じ範囲で、auto mode は、はっきり頼まれたコマンドなら今でも通す
  - README の注意（tailnet の ACL で入れる端末を絞る）はそのまま。許可のボタンが増えることを書き足す
- **Origin**：`/api/` は今どおり `trusted()`（`apps/server/src/index.ts`。Host と Origin を確かめる）を通る
  - あわせて、答える API は `content-type: application/json` だけを受ける。Origin の確かめに加える、2 つ目の守り
  - 別のサイトのフォームから送れるのは `application/x-www-form-urlencoded` などだけなので、ここで断れる
  - 別のサイトから JSON を POST するには、ブラウザが CORS の事前の確かめ（OPTIONS）をする。このサーバーは CORS に答えない（`Access-Control-*` を返すところがない）ので、ブラウザは送らない
- **id**：`randomUUID()`（122 ビット）。会話の id と組で照らし合わせ、違う会話の id では答えられない。SDK の `requestId` は画面に出さない
- **見せる中身**：
  - コマンドの全文は、断る判断の材料なので切らずに出す
  - 画面では文字として出す（React の文字。`dangerouslySetInnerHTML` を使わない）
  - `mcpServer.name` は信用できない文字（型の説明）だが、canvcode の MCP しかつながないので出さない
- **許すのは 1 回だけ**：`updatedPermissions` を返さないので、同じコマンドでも次はまた auto mode の判定から始まる
- **段階 1 で読める場所**：その session のものとスキルのフォルダだけ。transcript とほかの session は読めない

## テストの計画

### `permissions.test.ts`（段階 1・2）

- その session の `tool-results/` と `tasks/` の中は読める。ほかの session の同じ場所は読めない
- 同じ session の transcript（`.jsonl`）と `subagents/` は読めない
- `tool-results/` の中のシンボリックリンクが外を指していれば読めない
- `readRoots` の中にも書けない（Write・Edit）
- `transcript_path` の名前が `<session_id>.jsonl` でなければ、場所を足さない
- スキルのフォルダ：ワークスペースから git の根までのものは読める。根より上は読めない。`.git` がなければワークスペースのものだけ
- Glob：`/etc/host*`・`../outside/*` は断る。`notes/**` と、`tool-results` の中を探す `pattern` は許す
- サブエージェントの呼び出し（`agent_id` つきで、`session_id` は親）も同じに許す
- `askTool`：Bash は `ask`、`decisionReasonType: 'rule'` は（Write でも）`ask`。`guardTool` で断るものは尋ねない。そのほかは今どおり

### `jobs.test.ts`（段階 2。今の `fakeSdk` に `canUseTool` を呼ぶ仕掛けを足す）

- Bash の問い合わせが `ThreadInfo.permissions` に入り、`thread` の変化が届き、ジョブに `ask` が残る
- 許す → `allow` と元の入力が返り、`answer: allowed` が残り、一覧から消える
- 断る → `deny` と断ったときの言葉。時間切れ（`permissionTimeoutMs: 20`）→ `deny` と時間切れの言葉、`answer: expired`
- ジョブの「止める」→ `signal` の abort で取り消し、`answer: cancelled`。会話の「全部止める」・プロセスの終わり・`dispose` でも同じ
- 2 回目の答え・知らない id・違う会話の id → 404 の `JobError`
- 今のジョブがないとき（バックグラウンドのサブエージェント）は、会話の最後のジョブに `ask` と `answer` が残る。`agent` に作業の名前が入る
- 待っているあいだは `scheduleIdle` で閉じず、`makeRoom` でも選ばれない
- 規則で尋ねたものは、Bash でなくても尋ねる

### `http.test.ts`

- 答える API：204・404・400（`decision` が違う）・415（JSON でない）・405（POST でない）・id の形
- `GET /api/claude/threads` と SSE の `snapshot` に `permissions` が入る

### `claudeClient.test.ts`

- `applyStreamMessage` が `thread` の変化で `permissions` を差し替える
- `answerPermission` が JSON で POST する
- `threadBusy` が問い合わせを数える

### e2e（`tests/e2e/claude-panel.spec.ts`。今のように API を `page.route` で差し替える）

- 会話に待っている問い合わせがあると、パネルに一覧が出て、コマンドの全文が見える。許可のボタンにフォーカスがない
- ［許可する］で、正しい本文の POST が出て、ボタンが無効になる。SSE の `thread`（問い合わせなし）が届くと一覧が消える
- ［断る］も同じ
- パネルが閉じていても、Claude のボタンに印が出る
- ジョブの `ask`・`answer` の出来事の文言
- 走らせるときは `flock /tmp/canvcode-e2e.lock npx playwright test --project=chromium tests/e2e/claude-panel.spec.ts`（ポート 4179 を MAI-89 と分け合うため）

## 本物で確かめる方法

本番には触らない。ポート 8811〜8819 と、`mktemp -d` の中のフォルダを使う。

1. 置き場を作る：使い捨てのフォルダに git のリポジトリを作る
   - `repo/.claude/skills/t/SKILL.md` と `references/r.md` を置く
   - ワークスペースを `repo/ws` にし、`repo/ws/.claude/settings.json` に `{"permissions":{"ask":["Bash(echo canvcode-ask-test:*)"]}}` を置く
2. サーバー：`CANVCODE_PORT=8811 node apps/server/src/index.ts --workspace <repo/ws>` を起動する。画面は `npm run build -w @canvcode/web` でビルドしておく
3. 段階 1：`/api/claude/jobs` に次の 3 つを頼み、`GET /api/claude/jobs/<id>` の出来事に `denied` がないことを確かめる
   - 「`seq 1 300000` を実行し、保存された結果のファイルを Read で読んで最後の行を答えて」
   - 「`sleep 2; echo done` をバックグラウンドで動かし、出力のファイルを Read で読んで」
   - 「スキル t を使い、参照ファイルを Read で読んで」
4. 段階 2：Playwright の chromium で画面を開き、パネルから「`echo canvcode-ask-test hello` を実行して」と頼む
   - 問い合わせが出て、［許可する］で続きが進み、答えに `canvcode-ask-test hello` が出ること
   - ［断る］では、Claude が断られたと書くこと
   - 待っているあいだの「止める」で取り消しになり、同じ会話で続けて頼めること
   - `CANVCODE_CLAUDE_PERMISSION_TIMEOUT_MS=15000` での時間切れ
5. 費用は合わせて 2 ドル以内。終わったらサーバーを止め、フォルダと、その cwd の `~/.claude/projects/<名前>/`・`/tmp/claude-<uid>/<名前>/` を消す

## 作業の分け方

| コミット | 中身 |
|---|---|
| 1. 段階 1 | `permissions.ts`（`Guard`・`readRoots`・Glob の `pattern`・`skillRoots`）、`jobs.ts`（フックの入力から場所を出す、`CLAUDE_CODE_TMPDIR` を渡す、`LiveThread` に覚える）、`permissions.test.ts`・`jobs.test.ts`、README |
| 2. 段階 2（サーバー） | `permissions.ts`（`askTool` の `ask`）、`jobs.ts`（問い合わせ・取り消し・時間切れ・出来事・`systemPromptAppend` の 1 行）、`http.ts`（答える API）、`index.ts`（環境変数）、テスト |
| 3. 段階 2（画面） | `claudeClient.ts`・`ClaudePanel.tsx`・`App.tsx`（ボタンの印）・CSS、`claudeClient.test.ts`・e2e、README |

段階 1 は単独でも入れられる（2 と 3 を待たずに PR にできる）。

## 決めきれないこと（レビューで決めてほしい）

1. **画面で尋ねる呼び出し**
   - A. Bash と、規則（`permissions.ask`）で尋ねると決めたもの（**おすすめ**。規則を書けば、ユーザーが尋ねてほしいものを選べる）
   - B. `canUseTool` に来たもの全部（ワークスペースの外への Glob なども尋ねる。数が増える）
   - C. Bash だけ（チケットどおり。規則で尋ねると決めた Write などは今どおり許してしまう）
2. **打ち切りの時間**
   - 10 分（**おすすめ**。チケットどおり）／30 分／打ち切らない（SDK には期限がない。同時に 2 つまでの枠を取り続ける）
   - 環境変数で変えられるようにするか：**する**（おすすめ。確かめるときにも使う）／しない
3. **許可を待つ依頼を「同時に 2 つまで」に数えるか**
   - 数える（**おすすめ**。ターンの途中で、プロセスも動いている）／数えない（ほかの依頼を始めやすいが、答えたあとに 3 つ同時に書くことになる）
4. **パネルが閉じているときの知らせ方**
   - Claude のボタンに印（**おすすめ**）／パネルを自分で開く（作業の邪魔になる）／ブラウザの通知（許しが要る。あとで足せる）
5. **断ったとき、そのターンを止めるか**
   - 止めない（**おすすめ**。Claude が代わりの案か、ユーザーへの頼みを書ける）／止める（`interrupt: true`。Claude Code の「No, and tell Claude what to do differently」に近い）
6. **スキルのフォルダを読めるようにする範囲**
   - ワークスペースから git の根まで（**おすすめ**。Claude Code が読み込む範囲と同じ）
   - ワークスペースの中だけ（今のまま。imozuru の参照ファイルは、Claude が Bash で読み直す）
7. **履歴の残し方**
   - 尋ねたときと答えたときの 2 つの出来事（**おすすめ**。落ちても「尋ねた」ことが残る）／答えたときだけ
8. **Glob の穴を段階 1 で一緒に直すか**
   - 直す（**おすすめ**）／別のチケットにする

## リスク

- tool-results と作業の出力の場所は、Claude Code の文書にない置き方
  - CLI を上げて変わったら、段階 1 の場所が合わなくなる。そのときは今と同じく断る側に倒れる（Claude は Bash で読み直す）
  - 単体テストは場所の組み立てを固定するだけなので、変わったことには気づけない。CLI を上げるときに、本物で確かめる手順（上の 3）を流す
- `CLAUDE_CODE_TMPDIR` を渡すと、Claude Code の一時ファイル全部の置き場になる。既定（`/tmp`）と同じ値を渡すので、今と変わらない。サーバーの環境ですでに決めてあれば、その値を使う
- 問い合わせを待つあいだ、同時に 2 つまでの枠を最長 10 分取る
- パネルを見ていなければ、時間切れで断るだけになる（今と同じ結果）
- 止めたあとにプロセスを閉じると、SDK がエラーを投げることがある（上の実験）。今の止め方でも起きうるので、実装のときに `exited` の扱いを確かめる

## やらないこと

- 「この会話のあいだは、同じコマンドを許す」（`suggestions`・`updatedPermissions`。決めたこと）
- スマホ・iPad 向けの「読むだけ」の会話（決めたこと。要るなら別のチケット）
- ログインと、人ごとの許可
- Claude からの質問（`AskUserQuestion`）。今は `CLAUDE_TOOLS` に入っていない
- ブラウザの通知（決めること 4 で、あとで足せる）
- `systemPromptAppend` の、最後の 1 行のほかの行（MAI-89 が足す）
