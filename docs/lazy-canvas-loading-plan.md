# 開いた Canvas の分だけレコードを読む

新しいタブで開くたびに、ワークスペースの全部のレコード（`GET /api/records`）を読み直している。記録の数に比例して遅くなり、メモリーも増える。ここでは、ブラウザが開いた Canvas の分だけ読む形（案 C）に変える設計と、作業の分け方を決める。

## 測った値（2026-10-25）

合成のワークスペース（画像・PDF・Markdown の入った Canvas 4 つと、付箋・文字・図形・矢印を 100 個ずつ置いた Canvas）で、元のタブを開いたまま、新しいタブで Canvas を開いた。5 回の中央値。「遠隔」は遅延 40 ms・下り 20 Mbps（SSH 越しを想定した仮の値）。

| レコード | 回線 | `/api/records` | サーバーが返し始めるまで | 受け取り | JSON.parse | 組み立て | 操作できるまで | タブのヒープ |
|---|---|---|---|---|---|---|---|---|
| 約 100 | 手元 | 0.04 MB | 2 ms | 1 ms | 0.4 ms | 48 ms | 0.6 秒 | 15 MB |
| 5,000 | 遠隔 | 2.1 MB | 61 ms | 873 ms | 14 ms | 92 ms | 1.5 秒 | 15 MB |
| 20,000 | 手元 | 8.4 MB | 251 ms | 53 ms | 73 ms | 237 ms | 1.0 秒 | 23 MB |
| 20,000 | 遠隔 | 8.4 MB | 197 ms | 3,435 ms | 60 ms | 258 ms | 4.5 秒 | 25 MB |
| 50,000 | 手元 | 20.8 MB | 686 ms | 191 ms | 152 ms | 562 ms | 1.9 秒 | 48 MB |
| 50,000 | 遠隔 | 20.8 MB | 732 ms | 8,657 ms | 146 ms | 555 ms | 10.6 秒 | 51 MB |

本番のワークスペースは約 13,000 件で、これから増える。記録以外（画面のプログラム・縮小画像・本文）は 1 回 約 280 KB で、ほとんど効かない。

## 目的

- 新しいタブで操作できるまでの時間とタブのメモリーを、ワークスペース全体の記録の数ではなく、開いた Canvas のノードの数で決まるようにする。
- 今の動き（同期・Undo・ゴミ箱・引用・ショートカット・AI の編集）は変えない。

## 何を読むか

レコードを 2 つに分ける。

| 種類 | typeName | 扱い |
|---|---|---|
| 一覧のレコード | `canvas`・`file`・`anchor` | 今までどおり全部読み、全部の変更を受け取る（サイドバー・パンくずリスト・ゴミ箱・参照先の状態・PDF の引用の印に使う） |
| 引用のつながり | （レコードではない。4 節） | 全部読み、全部の変更を受け取る |
| Canvas の中のレコード | `node`・`binding` | 読み込んだ Canvas（以下「読んだ Canvas」）の分だけ持つ |

ノードがどの Canvas にあるか（以下「所属」）は、親をたどった先の Canvas。Binding の所属は、矢印（`fromId`）の所属。

## サーバー

### 1. レコードに所属を持たせる（`records.ts`）

- `records` 表に `canvas_id` を足し、索引を張る。`parent_id`・`type_name` の列と索引はもうある（`records.ts:97-108`）。
- 起動したときに、`canvas_id` が空の行をまとめて埋める（一度だけの移行）。
- `apply` で決める：
  - `parentId` が `canvas:` で始まればそれ。ノードなら、同じ差分の中か表から親の `canvas_id` を引く（差分の中で子が親より先に来てもよい）。
  - Binding は `fromId` の所属。
- ノードの所属が変わったら（別の Canvas へ移した）、子孫の `canvas_id` を付け直し、`rev` も上げる。子孫は差分に入っていないが、移した先の Canvas を読んだタブに届けるため。
- Canvas のレコードを消したら、その Canvas に所属する行も同じトランザクションで消し、`deleted` に残す。今はブラウザのフック（`workspace.ts:178-181`）が、手元にある子だけを消している。読んでいない Canvas の中身を、ゴミ箱から完全に削除しても残らないようにするため。
  - AI の編集（`applyAgentOp`）でこれが起きたら、消した行も `agent_ops` の patch に入れ、取り消しで戻るようにする。
- `changesSince` は、各レコードの `canvas_id` も返す。

### 2. 一覧と 1 つの Canvas の読み出し

- `RecordStore.loadScoped(canvasIds)`：一覧のレコード全部と、指定した Canvas に所属するレコード、それに今の `rev`。
- `GET /api/records?canvas=<id>`：開くときに使う。`?file=<id>`（`/f/<id>` で開いたとき）なら、その File の持ち主の Canvas（`parentCanvasId`）を読む。指定がない・見つからないときはルート。
- 引数のない `GET /api/records` と `RecordStore.load()` は、今までどおり全部を返す（AI の編集に使うサーバーの中のワークスペース `agent/host.ts`、旧データの取り込み、テスト）。

### 3. WebSocket の購読（`sync.ts`）

タブごとに「読んだ Canvas」の集合を持つ。

| メッセージ | 中身 |
|---|---|
| ブラウザ → `hello` | `{ since, canvases }`。サーバーは `canvases` を購読に入れてから、`since` より後の変更を絞って返す |
| ブラウザ → `load` | `{ canvasId, req }`。サーバーは購読に足し、`{ type: 'canvas', req, canvasId, rev, records }` を返す |
| サーバー → `changes` | 今の形のまま。中身を、そのタブの分に絞る（下） |

変更の絞り方：

- 一覧のレコードは、全部のタブに送る。
- Canvas の中のレコードは、所属がそのタブの読んだ Canvas なら `records` に入れる。そうでなければ id を `deleted` に入れる。手元にあれば消え、なければ何も起きない。読んだ Canvas から読んでいない Canvas へ移ったノードを、手元から消すため。
- 本当に消したものの id は、全部のタブに送る（今と同じ）。

送る中身は、受け取った `puts` ではなく、保存したあとの `changesSince(前の rev)` から作る。子孫の付け直しや Canvas の中身の削除も一緒に届く。同じ組み立てを、AI の編集・取り込みの `broadcast` と、AI 用ワークスペースへの知らせ（`onChange`）にも使う。

WebSocket は送った順に届き、サーバーは 1 本のスレッドで処理する。そのため `load` の応答より前の変更は応答に入り、後の変更は `changes` で届く。抜けも重なりもない。

古いタブとの互換：`canvases` のない `hello` を送ってきたタブは、全部の Canvas を購読しているものとして扱う（デプロイの間に開いていたタブが壊れない）。

### 4. 引用の索引

引用ノート（quote-card）は、引用元の PDF・Markdown とは別の Canvas に置くことが多い。今は次の 3 つが、ほかの Canvas のノートまで見ている。

- 「引用しているノート」の一覧と、ノートへの移動（`App.tsx:617-640`・`890`）
- PDF の引用の印。引用しているノートが、ゴミ箱の外にある SourceAnchor だけを出す（`workspace.ts:296`、`view.ts:318`、`editor.ts:748`）
- 最後のノートを消したら、SourceAnchor も消す（`workspace.ts:501-503`）

そこで、引用の「つながり」を、一覧のレコードと同じく全部のタブに配る。

- つながり：`{ noteId, anchorId, canvasId, head }`。`head` は一覧に出す文字（メモか引用の 1 行目の先頭 24 文字）。
- サーバーは quote-card の `props.anchorId` から作る（`json_extract` の式に索引を張る）。
- 最初の読み込み（2）と `load` の応答には、全部のつながりを入れる。ノートの数だけなので小さい。
- `changes` には、quote-card が変わった・消えた・所属が変わったときの差分（`citations: { put, removed }`）を、購読によらず全部のタブに入れる。

ブラウザの `CitationIndex`（`workspace.ts:85-120`）は、手元にあるノートからの分と、届いたつながりを合わせて引く。手元にあるノートは、手元の分を使う。こうすると、SourceAnchor を消す処理も今のまま（同じトランザクション・Undo で一緒に戻る）でよい。

## ブラウザ

### 5. 同期（`packages/canvas/src/sync.ts`）

- `loadRecords(canvasId | { file })` で、絞った最初のレコードを読む。
- `SyncClient` が、読んだ Canvas の集合を持つ。
  - `isLoaded(canvasId)`
  - `ensureCanvas(canvasId): Promise<void>`：読んでいなければ `load` を送り、応答を当ててから解決する。同じ Canvas への呼び出しは 1 つにまとめる。つながっていなければ、つながって読み終えるまで待つ。
  - 手元で作った Canvas（`createCanvas`・Portal の作成・取り込み・貼り付け）は、作ったときに読んだ Canvas に入れ、`load` を送る（中身は空）。そうしないと、Undo で Canvas を消すときの「子が残らないか」の確かめ（`leavesNoOrphans`）に、ほかのタブで足した中身が入らない。
- つなぎ直すときは、`hello` に読んだ Canvas を全部入れる。
- 届いた `deleted` は、今と同じく、まだ送っていない手元の変更のあるものは消さない。
- 読んでいない Canvas に、手元の操作でノードを置いたとき（ゴミ箱から戻して、持ち主の Portal を置き直したときなど）は、そのまま持っておく。その Canvas を読んだときに、サーバーの分で上書きされる。

### 6. 画面（`apps/web/src/App.tsx`）

- `navigate` は、`getEditor` の前に `ensureCanvas` を待つ。待つ間はパンくずリストに「読み込み中…」を出す。`getEditor` は、読んでいない Canvas の Editor を作らない（作ろうとしたら投げる）。
- 開いたときの URL：
  - `/c/<id>`：その Canvas を最初に読む。
  - `/f/<id>`：その File の持ち主の Canvas を最初に読む。
  - `/r/<id>`：ルートを読んでから、今までどおり移る。
- 「別の Canvas へ移す」と「親キャンバスに移動」（`App.tsx:947-959`、`editor.moveToCanvas` は移す先の中身を見て置く場所を決める）：移す先を `ensureCanvas` してから移す。
- ショートカットの「元の場所へ移動」（`App.tsx:604-605`）：持ち主のノードの所属は、参照先の `parentCanvasId` を使う（持ち主の Canvas と同じ）。
- 引用（`App.tsx:617-640` と `890`）：一覧の文字は、手元にないノートならつながりの `head` を使う。ノートへ移るときは、つながりの `canvasId` へ移る（`ensureCanvas` してから `focusNode`）。
- ゴミ箱から元に戻す（`workspace.restoreCanvas`）：持ち主の Portal を置き直す先の Canvas を、先に読む。Portal の親がノード（group など）のときは、Canvas がわからないので、サーバーに聞く（`GET /api/records/<id>/canvas`）。
- `Workspace.notesOfAnchor`・`anchorsOfFile`・SourceAnchor を消す処理は、4 の索引を使う。`canvasOf(noteId)` を使っているところは、つながりの `canvasId` に置き換える。

### 7. 読んだ Canvas を手放す（あとで）

開いた Canvas を巡ると、手元のレコードは今と同じだけ増える。`trimEditors` で Editor を捨てるときに、その Canvas のレコードもストアから外し、購読をやめる。

- 外す前に、その Canvas に送っていない変更がないことを確かめる。
- その Canvas の Undo の履歴（scope）も捨てる。

1〜6 の効果を測ってから決める。

## 変えないもの

- AI の編集に使うサーバーの中のワークスペース（`agent/host.ts`）は、今までどおり全部を持つ。
- 本文（File の中身）・画像・PDF・縮小画像の読み方。
- ほかのタブとの同時編集の決まり（後から届いたものを採用する）。

## 作業の分け方

上から順に進める。各段で `npm run typecheck`・`npm test`・`npm run lint` を通す。e2e は 6 と 7 で通す。

| # | 作業 | 中身 | 確かめること | 先に要るもの |
|---|---|---|---|---|
| 0 | 測る仕組み | 合成のワークスペースを作り、新しいタブで開くまでを測るスクリプトを `tests/bench/newtab.ts` に置く（`npm run bench:newtab`）。今の値を残す | 上の表と同じくらいの値が出る | — |
| 1 | 所属の列 | `canvas_id` の列・移行・`apply` での計算・移したときの子孫の付け直し（`rev` を上げる）・Canvas を消したときの中身の削除（`agent_ops` にも入れる）・`changesSince` で返す | 単体テスト：親が同じ差分にある・後に来る・group の中の子・移動・Canvas の削除・Binding・移行・AI の編集の取り消しで戻る | 0 |
| 2 | 絞った読み出し | `loadScoped`・`GET /api/records?canvas=`・`?file=`・`GET /api/records/<id>/canvas` | 単体テスト：一覧のレコードは全部、ほかの Canvas のノードは入らない | 1 |
| 3 | 購読と絞った中継 | `hello` の `canvases`・`load`・`changes` の絞り込みと `deleted` での追い出し・`broadcast` と `onChange` の組み立てを `changesSince` からにする・古いタブとの互換 | 単体テスト：2 つのソケットで、読んだ Canvas の変更だけが届く・読んだ Canvas から出たノードが `deleted` で届く・`load` の前後の変更が抜けない・`canvases` のない `hello` は全部 | 1 |
| 4 | 引用のつながり | サーバーでつながりを作る・最初の読み込みと `load` に入れる・`changes` に差分を入れる | 単体テスト：別の Canvas のノートの追加・メモの変更・削除・移動が、読んでいないタブに届く | 1・3 |
| 5 | 同期のクライアント | `loadRecords` の引数・読んだ Canvas の集合・`ensureCanvas`・手元で作った Canvas を足す・つなぎ直し・`CitationIndex` に届いたつながりを足す | 単体テスト（今の `sync.test.ts` のやり方で、サーバーを本物で立てる）：移った先の Canvas が届く・同時に頼んでも 1 回・切れている間に頼んで、つながってから届く | 2・3 |
| 6 | 画面を合わせる | `navigate` と読み込み中の表示・開いたときの URL・移す操作・元の場所へ移動・引用の一覧と移動・ゴミ箱から戻す | e2e：新しいタブで Canvas を開く・Portal で入る・別のタブで編集した読んでいない Canvas に入る・ほかの Canvas へ移す・読んでいない Canvas の引用ノートへ移る・PDF の引用の印が出る・最後の引用ノートを消して Undo する・ゴミ箱から戻す・完全に削除・Undo で Canvas を消す（ほかのタブで中身を足したとき） | 4・5 |
| 7 | e2e とテストの前提を直す | `window.canvcode.workspace` から全部のノードを引いている e2e・ベンチマーク（`memory.ts` など）を、`navigate` を待つ形に直す | `npm run test:e2e` が Chromium・Firefox で通る | 6 |
| 8 | 測り直して書く | 0 のスクリプトで測り直し、この文書の表と README に書き足す | 新しいタブで操作できるまでの時間が、記録の数でほとんど変わらない | 7 |
| 9 | （あとで）手放す | 7 節。8 の値を見て決める | Canvas を巡ってもタブのメモリーが一定 | 8 |
| — | （別に）圧縮 | `/api/records` と `canvas` の応答を gzip / brotli で返す（`compress.ts` の `pickEncoding` を使う）。どの段とも独立 | 応答に `content-encoding` が付く | — |

1 つの PR にまとめると大きいので、PR は 0、1〜4（サーバー。ブラウザは今までどおり全部を読み、互換で動く）、5〜7（ブラウザ）、8 に分ける。

## 気をつけること

- 移したノードの子孫の `rev` を上げるので、大きな group を移すと、その分の変更が全部のタブに流れる。そのタブの読んでいない Canvas なら id だけ。
- 読んでいない Canvas の中で、Binding の先（`toId`）が別の Canvas を指すことは、今の操作ではない前提。あれば、所属は矢印の側で決める。
- 引用のつながりは、ノートの数に比例して全部のタブに配る。引用ノートが数万になったら、これも Canvas ごとに絞る必要がある。
