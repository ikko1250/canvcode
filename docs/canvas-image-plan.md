# Canvas を画像にする（MAI-89）

Canvas の範囲やスライドを PNG にする。入口は 2 つある。

- ユーザー：右クリックとパイメニューの「画像として保存」「画像をコピー」
- AI：MCP のツール `render_canvas`。スライドや図を置いたあとに、自分で見て確かめるため

ここでは、その設計と作業の分け方を決める。

## 方針

- **画像はブラウザで作る**（MAI-64 と同じ）。描く処理（`renderRegion`・`renderRegionLoaded`。`packages/canvas/src/view.ts:716-761`）は、もうある。
- **サーバーは描かない**。AI が頼んだら、開いているタブに WebSocket で頼み、PNG を HTTP で受け取って返す。開いているタブがなければ、失敗として返す（チケットの「決めたこと」）。
- 右クリックと AI は、同じ関数で描く（`CanvasView.renderImage`。下の 2）。描く範囲・大きさの決め方だけが違う。

### チケットから変えたこと

| 変えたこと | 理由 |
|---|---|
| タブの答えは、成功も失敗も `PUT /api/renders/<attempt>` の 1 本にする（失敗は JSON） | 答えの道が 1 つなら、遅れて届いた答えの扱いが 1 か所で済む |
| タブは `hello` で、描けること（`features: ['render']`）を伝える。伝えていないタブには頼まない | デプロイの前から開いていたタブは `render` を知らないので、頼むと打ち切りまで待たされる |
| `presence` に `visible` を足し、見えているタブを先に選ぶ。描くときの PDF のページは `intent: 'print'` で描く | PDF.js は、`intent` が `print` でないと `requestAnimationFrame` で描き進める（`pdfjs-dist` 6.3.289 の `pdf.mjs:15957`・`17188`）。裏に回ったタブでは止まる |
| 描く前に、範囲の中の Markdown・コード・表のカードの本文を読み、カードの画像を作り終えるまで待つ | 今の待ち方（`MissingImageRecorder`）は、Asset と表のタイルのキーしか待たない（`view.ts:719`）。今見ていない Canvas のカードは、仮の絵（プレースホルダー）のまま写る |
| スライドの番号（`n`）は、サーバーが id にしてからタブに頼む | 番号の数え方（`slideOrder`）は `read_canvas` と同じものを、サーバーがもう持っている（`agent/outline.ts:614`） |

## 今の作り

| もの | 場所 | 中身 |
|---|---|---|
| 範囲を PNG にする | `view.ts:764` `renderRegionPng(editor, box, maxEdge)` | 長い辺が `maxEdge`（既定 1568）になる倍率で描く。2 倍より大きくはしない（`refs.ts:180` `refImageSize`） |
| スライドを PNG にする | `view.ts:696` `renderSlideImage(slideId, editor)` | `slideImageRegion`（`slideImage.ts:36`）：スライドとその子孫だけを、倍率 2（3840×2160）で、印刷用（名前と枠を描かない）に描く |
| 描く前に待つもの | `view.ts:716` `renderRegionLoaded` | フォント・PDF のページの画像・Asset の画像・表のタイル |
| 範囲の決め方 | `refs.ts:45` `canvasRefTarget` | 直前の範囲選択（そのあと選択を変えていないとき）か、選んでいるノード |
| サーバーからタブへ | `apps/server/src/sync.ts:10` | `changes`・`ack`・`canvas`・`error` だけ。頼んで答えを受け取る形はない |
| 見ている所 | `sync.ts:232-239`・`packages/canvas/src/sync.ts:233` | タブごとの `presence`（Canvas と範囲）。最後に知らせてきたタブのものを、AI のツールの既定にする |
| 読んだ Canvas | `sync.ts:70` `clients: Map<WebSocket, Scope>` | タブごとの購読（`hello` の `canvases`・`load`） |
| `/api/` の確かめ | `apps/server/src/index.ts:120-134`・`190` | Host と Origin が、このサーバーのものか |

## 1. 描く範囲と大きさ（`packages/canvas/src/canvasImage.ts`、新しく作る）

DOM に依存しない純粋な関数だけを置く（`slideImage.ts` と同じ）。

```ts
// 何を描くか
export type ImageTarget =
  | { kind: 'rect'; rect: Box }           // 範囲に見えるものを全部
  | { kind: 'nodes'; ids: string[] }      // そのノードとその子孫だけ
  | { kind: 'slide'; id: string }         // スライドの枠どおり、印刷用

export interface ImageRegion {
  box: Box                     // 描く範囲（ワールド座標）
  only: Set<string> | null     // 描くノード（null は全部）
  print: boolean               // スライドなら true（名前・枠を描かない。Viewport.print）
}

export function imageRegion(editor: Editor, target: ImageTarget): ImageRegion | null
// 画面の選択から決める（右クリック）。範囲選択なら rect、スライドを 1 枚だけ選んでいれば slide、ほかは nodes
export function selectionImageTarget(source: CanvasRefSource, typeOf: (id: string) => string | undefined): ImageTarget | null

export interface ImageSize { width: number; height: number; scale: number; capped: boolean }
// 倍率で決める（ユーザー）か、長い辺で決める（AI）。どちらも上限で抑える
export function imageSize(box: Box, want: { scale: number } | { maxEdge: number }): ImageSize

export function imageFileName(canvasTitle: string, slideNumber?: number): string   // 「<Canvas の名前>.png」「<名前> - 3.png」
```

- `nodes` の余白：ノードを囲む矩形に、長い辺の 2%（8〜40 ワールド単位）を足す。
- `selectionImageTarget` は `canvasRefTarget` と同じ規則で範囲選択かを見る（`activeBrush`）。右クリックの「決めたこと」（範囲選択なら全部、ノードを選んだらそれだけ）と同じになる。
- 上限は「5. 大きさの決め方」。

## 2. 描く（`packages/canvas/src/view.ts`）

`renderRegionPng` と `renderSlideImage` を、次の 1 つにまとめる。今の 2 つは、これを呼ぶ薄い関数として残す（ref の画像とスライドの PDF の振る舞いは変えない）。

```ts
export interface RenderedImage {
  png: Blob
  box: Box            // 描いた範囲（ワールド座標）
  scale: number       // 1 ワールド単位あたりの画素
  width: number
  height: number
  capped: boolean     // 上限で倍率を下げた
  empty: boolean      // 描くノードが 1 つもなかった
  incomplete: string[] // 間に合わなかったもの（'pdf'・'card'・'image'）
}

async renderImage(editor: Editor, target: ImageTarget, size: { scale: number } | { maxEdge: number }, options?: { budgetMs?: number; pdfIntent?: 'display' | 'print' }): Promise<RenderedImage | null>
```

描く前に待つもの（`complete` の待ち方）：

1. フォント（`settleFonts`。今と同じ）
2. PDF のページの画像（`loadPdfPages`。今と同じ。`pdfIntent` を `assets.renderPdfPage` から `PdfDocument.render` まで渡す。`apps/web/src/pdfjs.ts:45` の `page.render({ canvas, viewport, intent })`）
3. 範囲の中の Markdown・コード・表のカードの本文（`FileManager.text(fileId)`。`packages/canvas/src/files.ts:120`）
4. 1 回描いて、手元になかった画像を全部読み込み、描き直す。`MissingImageRecorder` のフィルターを、エクスポートでは「全部」にする（カードの画像のキーはノードの id。`markdownCard.ts:186`・`205`）

- 2〜4 は `budgetMs`（既定 10 秒）までしか待たない。間に合わなければ、ある絵で描き、`incomplete` に入れる。
- ref の画像とサムネイルの待ち方は変えない（MAI-64 のまま）。

**今の振る舞いを変えない**：`renderRegionPng`（ref の画像）と `renderSlideImage`（スライドの PDF）は、`renderImage` を今と同じ設定で呼ぶ形にする。

| 呼び出し | 渡す設定 |
|---|---|
| `renderRegionPng(editor, box, maxEdge)` | `rect`、`{ maxEdge }`、カードを待たない（今のフィルター：Asset と表のタイル）、PDF は `display`、上限なし（`refImageSize` のまま） |
| `renderSlideImage(slideId, editor)` | `slide`、倍率 2、印刷用、カードを待たない、PDF は `display` |

- 変える前と後で、次を通す：`packages/canvas/src/refs.test.ts`・`slideImage.test.ts`・`apps/web/src/slidePdf*.test.ts` と、e2e の `slide-pdf.spec.ts`・`slide-templates.spec.ts`。
- まとめると振る舞いが変わりそうなら（描く順・待つものが変わるなど）、まとめずに `renderImage` を新しく足すだけにし、理由をコミットに書く。

### 描いたあとに手放すもの

見ていない Canvas を描くと、描くためだけに読んだものができる。iPad はメモリーが厳しい（MAI-66）ので、今の上限と手放し方を調べ、残り続けるものは描いたあとに手放す。

| もの | 今の上限と手放し方 | 描いたあと |
|---|---|---|
| 画像のキャッシュ（PDF のページ・Asset・カード・表のタイル。`imageCache.ts`） | 使った順で 256 MB まで。Canvas を移るときに 64 MB まで減らす（`view.ts:528`）。描くためだけに読んだ画像は、上限に達するまで残る | **手放す**。描いている間に新しく入れた（キー・解像度）を覚えておき（`ImageCache.track()`）、描いたあとで、直近のフレームで画面に使っていないものを捨てる（`ImageCache.release(tracked)`） |
| 開いた PDF の文書（`assets.ts` の `pdfDocuments`） | 3 つまで。超えたら使っていないものから閉じる（`MAX_OPEN_PDFS`） | そのまま（上限がある） |
| PDF の縮小画像のシート（`previewSheets`） | 2 枚まで（`MAX_PREVIEW_SHEETS`） | そのまま |
| カードの HTML の画像（`markdownCard.ts` の `htmlImages`） | 4 つまで（`HTML_IMAGE_LIMIT`） | そのまま |
| File の本文（`files.ts` の `entries`） | 上限なし（文字だけ） | そのまま。Canvas を開いたときと同じ |
| 読んだ Canvas のレコード（`ensureCanvas`） | 手放さない（`docs/lazy-canvas-loading-plan.md` の 7 はまだ） | そのまま。読んでいるタブを先に選ぶので、新しく読むのは見ていない子の Canvas のときだけ |
| 一時的な Editor | — | **必ず捨てる**（`try … finally` で `editor.dispose()`）。`editors` に入れない |
| 描いた canvas 要素（最大 8192×2048 などで数十 MB） | GC まで残る | `toBlob` のあとで幅と高さを 0 にする（Safari は GC まで中身を持ち続ける） |

確かめ方：

- 単体（`imageCache.test.ts`）：`track` の間に入れたものだけが `release` で消え、画面に使っているもの・前からあったものは残る。バイト数が戻る。
- e2e（`render-canvas.spec.ts`）：見ていない Canvas を AI が描いたあとで、タブの画像のキャッシュのバイト数が描く前と同じに戻り、Editor の数が増えていない（`window.canvcode` から読む）。
- 手で：`tests/bench/memory.ts` は Canvas を巡るベンチマークなので、ここでは使わない。上の e2e で足りる。

## 3. ユーザーの入口（`apps/web/src/App.tsx`・`apps/web/src/pie/menus.ts`）

| 入口 | 出す条件 | 項目 |
|---|---|---|
| 右クリック（ノードの上。`App.tsx:1087` の「AIに渡すIDをコピー」の上） | 選んでいるノードがある | 「画像として保存 ›」「画像をコピー ›」 |
| 右クリック（何もない所。`App.tsx:1231`） | 直前の範囲選択がある | 同じ 2 つ |
| パイメニューの操作 `o`（`menus.ts:223` `actionItems`） | どちらか | 「画像 ›」の中に「保存（等倍）」「保存（2 倍）」「コピー（等倍）」「コピー（2 倍）」 |

- 右クリックの `›` は、押すと同じ位置に次のメニューを出す（「子キャンバスに移動」と同じ。`App.tsx:1093-1104`）。中身は「等倍（1200×800）」「2 倍（2400×1600）」で、出来上がりの画素の数を見せる。上限で抑えるときは「2 倍（上限で 1.4 倍・8192×5460）」。
- 保存：`<a download>` で落とす（`slidePdf.ts:49` と同じやり方）。ファイル名は `imageFileName`。
- コピー：`navigator.clipboard.write([new ClipboardItem({ 'image/png': pngPromise })])` を、**メニューを押した処理の中ですぐに**呼ぶ（Safari は、押したすぐあとでないと書かせない。Promise を渡せば描き終えるのを待ってくれる）。書けなければ「コピーできませんでした。「画像として保存」を使ってください」と知らせる（`ClipboardItem` がない・断られた）。
- 知らせ：描き始めに「画像を作っています…」、終わったら「画像を保存しました（2400×1600）」「画像をコピーしました（…）」。`capped`・`incomplete` があれば、それも書く。
- 描いている間に、もう一度押されたら、前のものを待ってから描く（1 つずつ）。

## 4. AI の入口

### 4.1 データの流れ

```
AI ──render_canvas──▶ MCP（mcp.ts）
                        │ 確かめる：Canvas がある・ノードの id がその Canvas にある・スライドの番号 → id
                        ▼
                      RenderBroker.request（renders.ts）
                        │ タブを選ぶ → attempt を作る（推測されにくい id）
                        ▼
  タブ ◀──WebSocket { type: 'render', attempt, canvasId, rev, target, maxEdge }──
   │ 1 つずつ並べる → ensureCanvas → 届いた変更を当て終えるのを待つ → renderImage
   ▼
  PUT /api/renders/<attempt>（image/png。失敗なら application/json { error }）
                        │
                        ▼
                      RenderBroker：attempt を解決 → MCP が [画像, テキスト] を返す
```

### 4.2 サーバー：`SyncHub` に足すもの（`apps/server/src/sync.ts`）

`receive` の振る舞いはほとんど変えず、外から使う口だけを足す。

```ts
export interface TabInfo {
  socket: WebSocket
  scope: Set<string> | 'all'      // 読んだ Canvas
  presence: Presence | null
  visible: boolean                // presence の visible（来ていなければ true）
  features: ReadonlySet<string>   // hello の features
}
tabs(): TabInfo[]                                         // hello が済んだ、開いているタブ
sendTo(socket: WebSocket, message: unknown): boolean      // 開いていなければ false
onClose(listener: (socket: WebSocket) => void): () => void
```

- `hello` に `features?: string[]`、`presence` に `visible?: boolean` を足す。どちらも、なければ今までどおりに扱う。
- `Presence` に `visible` を足すので、`latestPresence` は今までどおり使える（AI のツールの既定は、見えているかによらない）。

### 4.3 サーバー：`RenderBroker`（`apps/server/src/renders.ts`、新しく作る）

```ts
export type RenderTarget = { kind: 'rect'; rect: Box } | { kind: 'nodes'; ids: string[] } | { kind: 'slide'; id: string }
export interface RenderResult { png: Buffer; box: Box; scale: number; width: number; height: number; rev: number; empty: boolean; incomplete: string[]; capped: boolean }
export class RenderError extends Error { code: 'no-tab' | 'timeout' | 'busy' | 'failed' }

export class RenderBroker {
  constructor(hub: SyncHub, options?: { attemptTimeoutMs?: number; totalTimeoutMs?: number; maxPending?: number })
  request(canvasId: string, target: RenderTarget, maxEdge: number, rev: number): Promise<RenderResult>
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>   // PUT /api/renders/<attempt>
}
```

**頼む先のタブの選び方**：`features` に `render` があるタブを、次の順に並べる。同じ順位なら、最後に `presence` を知らせてきたものが先。

1. その Canvas を見ていて、見えているタブ
2. その Canvas を読んでいて（`scope`）、見えているタブ
3. そのほかの、見えているタブ（描く前に、その Canvas を読む）
4. 1〜3 と同じ順で、裏に回ったタブ

3 を入れるかは「決めきれないこと」の 1。

**1 回の頼み（attempt）**：

- attempt の id は `randomBytes(16).toString('base64url')`。頼み直すたびに作り直す（前のタブから遅れて届いた答えは 404 にする）。
- 打ち切り：1 回 20 秒、全体で 45 秒。打ち切ったら、次のタブに頼む。
- 頼んだタブが閉じたら（`onClose`）、すぐに次のタブに頼む。
- タブが失敗を返したとき：Canvas を読めない・描けないなら、次のタブに頼む。範囲が大きすぎる・ノードがないなど、どのタブでも同じになるものは、そのまま返す（`error` に `retry: false` を付けてもらう）。
- 全部のタブで駄目なら `RenderError`。最後の理由を入れる。

**同時に頼まれたとき**：

- サーバー全体で、終わっていない頼みは 4 つまで。超えたら `busy`。
- タブの中では 1 つずつ描く（下の 4.4）。同じタブに 2 つ頼むと、2 つ目は 1 つ目のあとになる。打ち切りの 20 秒は、タブが受け取ってからではなくサーバーが送ってから数えるので、並んで待つ間も数える（タブが重いときは、ほかのタブに回る）。

**rev**：`request` を呼んだときの `records.rev` を送る。サーバーは、変更を保存したらすぐにすべてのタブへ `changes` を送り（`broadcast`・`relay`）、そのあとで `render` を送る。WebSocket は送った順に届くので、`render` が届いた時点で、そのタブは rev までの変更を受け取っている。タブは、それを当て終えてから描く（4.4）。

### 4.4 ブラウザ：頼まれて描く

**同期（`packages/canvas/src/sync.ts`）**

- `hello` に `features: ['render']` を入れる。
- `{ type: 'render' }` を受け取ったら、`options.onRender(request)` を呼ぶ（`setHandlers` で受け取る口を足す）。
- `afterRemote(): Promise<void>`：届いている変更（トランザクションの途中で後回しにしたもの、`deferred`）を当て終えたら解決する。`applyRemote([], [], resolve)` で、後回しの列の最後に並べる。
- `reportVisibility(visible)`：`presence` に `visible` を付けて、すぐ送る。`App.tsx` が `visibilitychange` で呼ぶ。

**画面（`apps/web/src/App.tsx`）**

`onRender` で、次を 1 つずつ行う（タブの中の列）。

1. `sync.ensureCanvas(canvasId)`（読んでいなければ読む）
2. `sync.afterRemote()`。そのあとの rev が頼まれた rev より小さければ、`{ error: 'stale', retry: true }`（つなぎ直しの途中など）
3. その Canvas の Editor：表示しているものか、`editors` にあるものを使う。なければ一時的に作り、描いたら捨てる（`editors` には入れない。`trimEditors` に数えない）
4. `view.renderImage(editor, target, { maxEdge }, { pdfIntent: 'print', budgetMs: 10_000 })`
5. `PUT /api/renders/<attempt>`。PNG と、描いた範囲などを query に付ける（`putReferenceImage` と同じ形。`refs.ts:186`）。失敗なら JSON

- 描いた絵は、タブの手元のものになる。まだサーバーに送っていない手元の編集も写る。
- 画面がまだない（読み込み中）タブは、`{ error: 'not-ready', retry: true }` を返す。

### 4.5 MCP のツール `render_canvas`（`apps/server/src/mcp.ts`）

```ts
server.registerTool('render_canvas', {
  title: 'Render a canvas to an image',
  description: 'PNG of part of a canvas, drawn by an open CanvCode tab, to check how slides and diagrams look. ' +
    'Give a slide number (n= in read_canvas), node ids (only those nodes), or a world rect (everything in it); ' +
    'default: what the user sees, else the whole canvas. Needs an open CanvCode tab.',
  inputSchema: {
    canvas_id: z.string().optional(),                // 省けば見ている Canvas、なければルート
    slide: z.number().int().min(1).optional(),
    ids: z.array(z.string()).min(1).max(100).optional(),
    rect: z.object({ x, y, w: z.number().positive(), h: z.number().positive() }).optional(),
    max_edge: z.number().int().min(64).max(2576).optional(),   // 既定 1568
  },
  annotations: { readOnlyHint: true },
}, …)
```

- `slide`・`ids`・`rect` は 1 つだけ。どれもなければ：見ている Canvas なら、ユーザーの見ている範囲（`presence.viewport`）を `rect` にする。そうでなければ、Canvas のノード全体を囲む範囲（`readCanvas` と同じ索引から）を `rect` にする。
- `ids` が 1 つで、それがスライドなら、`slide` として描く。
- スライドの番号 → id は、`agent/outline.ts` の `slideInfos` を外から呼べるようにした関数（`slideIdOf(records, canvasId, n)`）で決める。
- 返すもの：`[画像, テキスト]` の順（MAI-64 と同じ）。テキストは JSON：

```json
{ "canvas": "canvas:…", "rev": 12, "target": { "slide": 2, "id": "node:…" },
  "image": { "x": 0, "y": 0, "w": 1920, "h": 1080, "scale": 0.8167, "width": 1568, "height": 882 },
  "notes": ["Some PDF pages were drawn from low-resolution previews."] }
```

- `notes` に入れるもの：`capped`（上限で縮めた）、`empty`（描くノードがない）、`incomplete`（間に合わなかったもの）、倍率がとても小さい（0.1 未満なら、狭い `rect` で描き直すよう勧める）。
- 使いどころの説明を足す：
  - `get_canvas_format`（`outline.ts:730` `canvasFormatGuide`）に「スライドや図を作ったり並べ直したりしたら、`render_canvas` で見て確かめる。ノードを 1 つ足すたびには描かない」
  - パネルのシステムプロンプト：`apps/server/src/claude/jobs.ts` の `systemPromptAppend` に、同じことを 1 行足すだけにする（MAI-90 が `jobs.ts` の別の所を変えるので、ほかには触らない）
- `McpDeps` に `renders?: RenderBroker` を足す。なければツールを出さない（テストと、画面のないサーバー）。

## 5. 大きさの決め方

| 入口 | 倍率 | 上限 |
|---|---|---|
| ユーザー：等倍 | 1 ワールド単位 = 1 画素 | 長い辺 8192 画素、面積 16,777,216 画素（iPad の Safari の canvas の上限）。超えたら倍率を下げる |
| ユーザー：2 倍 | 2 | 同じ |
| ユーザー：スライドを 1 枚 | 等倍 1920×1080・2 倍 3840×2160（`SLIDE_IMAGE_SCALE` と同じ） | 同じ |
| AI | 長い辺が `max_edge`（既定 1568、最大 2576）になる倍率。2 倍より大きくはしない（`refImageSize` と同じ） | 同じ |

- 1568 と 2576 は、Claude が画像を縮めずに読む長い辺の上限（MAI-64）。トークンは、おおよそ幅×高さ÷750（1568×882 で約 1,800）。
- 受け取る PNG は 8 MB まで（ref の画像と同じ `MAX_REF_IMAGE_BYTES`）。

## 6. 端の場合と失敗

| 場合 | ユーザー | AI（`render_canvas` の答え） |
|---|---|---|
| 開いているタブがない・描けるタブがない | — | エラー：「CanvCode を開いているタブがありません。ユーザーに CanvCode を開いてもらってから、もう一度呼んでください。それまでは read_canvas で確かめてください」 |
| 打ち切り（全部のタブで） | — | エラー：何秒で、いくつのタブで打ち切ったか |
| 頼みが多すぎる（`busy`） | — | エラー：少し待ってから呼び直すように |
| Canvas がない・ゴミ箱の中 | — | エラー（タブに頼む前にサーバーで断る） |
| スライドの番号がない | — | エラー：ある番号（1〜N、非表示のものは番号がない） |
| ノードの id がない・別の Canvas | — | エラー：見つからない id |
| 描くノードがない（空の範囲） | メニューを出さない | 白い画像と `notes` に empty |
| 大きすぎる | 倍率を下げ、知らせに書く | 倍率を下げ、`notes` に capped |
| PDF のページ・カード・画像が間に合わない | ある絵で描き、知らせに書く | ある絵で描き、`notes` に incomplete |
| 描いている途中でタブを閉じた | — | 次のタブに頼む |
| 裏に回ったタブ | — | 見えているタブを先に頼む。PDF のページは `print` で描くので止まらない。iPad の Safari の裏のタブは動かないので、打ち切りで次へ |
| 古いタブ（`features` がない） | — | 頼まない |
| クリップボードに書けない | 知らせて、保存を勧める | — |
| 描けなかった（例外） | 「画像を作れませんでした」 | 次のタブに頼み、全部駄目ならエラー |

## 7. セキュリティ

- `/api/renders/<attempt>` は `/api/` の下なので、ほかの API と同じく Host と Origin を確かめる（`index.ts:190`）。WebSocket の `/api/sync` も同じ（`index.ts:248`）。
- PUT を受け付けるのは、いま待っている attempt だけ。id は 128 ビットの乱数で、そのタブの WebSocket にだけ送る。1 回答えたら（成功・失敗・打ち切り）消すので、2 回目は 404。
- PNG は `image/png` だけ、8 MB まで。先頭の署名と IHDR の幅・高さを確かめる（`refImages.ts:87` の `pngWidth` を、高さも読む `pngSize` にして共有する）。頼んだ大きさより 1 画素を超えて大きければ断る。失敗の JSON は 4 KB まで。
- 画像はメモリーにだけ置き、ファイルには書かない（ref の画像と違い、あとで読み直すことがない）。
- 画面を開ける人なら誰でも、今でも `read_canvas` で中身を読める。画像になっても、読める範囲は広がらない。
- **偽の画像**：画面を開ける人なら、`features: ['render']` を名乗るタブ（やスクリプト）を作り、どんな PNG でも返せる。AI は、その偽の画像を見ることがある。ただし、画面を開ける人は今でも Canvas を書き換えられ（`push`）、パネルから Claude に頼むこともできる。偽の画像を返せることで、信頼の範囲は広がらない。AI に見せる画像は「画面を開ける人が見せたもの」で、Canvas のレコード（`read_canvas`）と同じ重みで扱う。
- `render_canvas` は Canvas を変えない。パネルの Claude Code では、canvcode の MCP をもう許している（`claude/permissions.ts` の `preToolUseHook`）。

## 8. テスト

| 種類 | ファイル | 確かめること |
|---|---|---|
| 単体 | `packages/canvas/src/canvasImage.test.ts`（新しく作る） | 範囲選択・ノード（group の子孫を含む）・スライド 1 枚の判定。余白。等倍・2 倍・`maxEdge`・長い辺と面積の上限・`capped`。ファイル名（使えない文字・スライドの番号） |
| 単体 | `packages/canvas/src/sync.test.ts` | `hello` に `features` が入る。`render` が `onRender` に届く。トランザクションの途中に届いた変更を当ててから `afterRemote` が解決する。`visible` が送られる |
| 単体 | `apps/server/src/sync.test.ts` | `hello` の `features`・`presence` の `visible` が `tabs()` に出る。`onClose` |
| 単体 | `apps/server/src/renders.test.ts`（新しく作る。`sync.test.ts` と同じく本物の WebSocket） | タブの順（見ている・読んだ・そのほか・裏）。`features` のないタブに頼まない。打ち切り → 次のタブ。閉じた → 次のタブ。`retry: false` は次へ回さない。遅れた答えは 404。PUT の確かめ（型・大きさ・署名・寸法）。`busy` |
| 単体 | `apps/server/src/mcp.test.ts` | 偽の `RenderBroker` で：画像が先・テキストが後。タブがないときのエラー。スライドの番号 → id。ない id。既定の範囲（見ている所・Canvas 全体）。`renders` がなければツールを出さない |
| e2e | `tests/e2e/canvas-image.spec.ts`（新しく作る。`slide-pdf.spec.ts` と同じく API を `page.route` で差し替える。Chromium と Firefox） | 右クリック › 画像として保存 › 2 倍 で落ちる PNG の寸法。範囲選択なら範囲の全部、ノードなら選んだものだけが写る（色を見る）。スライド 1 枚は 3840×2160。パイメニューの「画像 ›」。画像をコピー（`clipboard-read` を許して読み戻す）は Chromium だけ |
| e2e | `tests/e2e/render-canvas.spec.ts`（新しく作る。`lazy-canvas.spec.ts` と同じく本物のサーバーと Vite を起動。ポート 4420〜） | タブを開き、MCP のクライアントで `edit_canvas` → `render_canvas`。返った PNG に、置いた付箋の色がある。読んでいない子の Canvas も描ける。タブを閉じるとエラー |

e2e は `flock /tmp/canvcode-e2e.lock` を付けて走らせる（ポート 4179 がほかの作業とぶつかる）。

## 9. 本物で確かめる

1. 画面をビルドする（`npm run build -w @canvcode/web`）。
2. 使い捨てのワークスペース（`mktemp -d`）で、サーバーをポート 8801 に起動する（`CANVCODE_CLAUDE=0`）。
3. Playwright の Chromium で、タブを 1 つ開いたままにする。
4. MCP のクライアントで、次を描かせて PNG を保存し、目で見る：
   - `edit_canvas` でスライドを 2 枚（表紙・箇条書き）
   - `render_canvas`：`slide: 1`、`rect`、`ids`、引数なし
5. タブを裏に回したとき（2 つ目のタブを前に出す）に、PDF のページを含む範囲が描けるか。
6. `claude -p` で 1 回、「このキャンバスにスライドを 3 枚作って」と頼み、`render_canvas` を使うか、崩れを直すかを見る（費用は 1 ドルまで）。
7. サーバーとブラウザを止め、ワークスペースを消す。本番（8787・8788）には触らない。

## 10. 作業の分け方

上から順に進める。各段で `npm run typecheck`・`npx vitest run`・`npx oxlint` を通す。

| # | コミット | 中身 | 確かめること |
|---|---|---|---|
| 1 | 描く範囲と大きさ | `canvasImage.ts` とテスト | 単体 |
| 2 | 描く関数をまとめる | `renderImage`、カードの本文と画像を待つ、PDF の `intent`。`renderRegionPng`・`renderSlideImage` はこれを呼ぶ | 今の e2e（`slide-pdf`・ref の画像）が変わらない |
| 3 | 右クリックとパイメニュー | 保存・コピー・知らせ・README | `canvas-image.spec.ts` |
| 4 | サーバーがタブに頼む口 | `SyncHub` の `tabs`・`sendTo`・`onClose`・`features`・`visible`、`RenderBroker`、`PUT /api/renders` | `sync.test.ts`・`renders.test.ts` |
| 5 | タブが頼まれて描く | `SyncClient` の `onRender`・`afterRemote`・`reportVisibility`、`App.tsx` の列 | `packages/canvas/src/sync.test.ts` |
| 6 | MCP の `render_canvas` | ツール・`slideIdOf`・`get_canvas_format`・`systemPromptAppend` の 1 行・README | `mcp.test.ts`・`render-canvas.spec.ts` |
| 7 | 本物で確かめて書く | 9 の結果をこの文書に足す | — |

PR は 2 つに分ける：1〜3（ユーザーの入口。これだけでも使える）と 4〜7（AI の入口）。

## 11. 決めたこと（2026-11-03 のレビュー）

| # | 決めたこと | 選ばなかったもの |
|---|---|---|
| 1 | その Canvas を読んでいないタブにも頼む（描く前に読む）。AI は子の Canvas にスライドを作ることが多く、ユーザーは親を見ていることが多いため | 見ているタブだけ・読んだタブまで |
| 2 | 引数がないときは、ユーザーが見ている範囲。見ていない Canvas なら、ノード全体を囲む範囲 | 引数を必ず求める |
| 3 | `ids` は、そのノード（と子孫）だけを描く。範囲の全部なら `rect` | ノードを囲む範囲の全部 |
| 4 | 頼まれて描く PDF のページは、`intent: 'print'` で描く（裏のタブでも止まらない） | そのまま（打ち切りに任せる） |
| 5 | 右クリックは「画像として保存 ›」「画像をコピー ›」の 2 つと、等倍・2 倍の次のメニュー | 「画像として出力…」と小さな画面 |
| 6 | ユーザーの画像の上限は、どの端末でも長い辺 8192 画素・面積 16,777,216 画素 | 端末ごとに変える |
| 7 | AI の `max_edge` は 2576 まで。既定は 1568 | 1568 で固定 |
| 8 | カードを待つ処理は、ref の画像には使わない（MAI-64 の振る舞いを変えない） | ref の画像にも使う |
| 9 | PR は 2 つ（1〜3 のユーザーの入口、4〜7 の AI の入口） | 1 つ |

## 12. リスクとやらないこと

**リスク**

- 描くのはユーザーのタブの中なので、大きい範囲を描く間は画面が止まる（数百 ms）。上限・タブの中で 1 つずつ・打ち切りで抑える。
- 読んでいない Canvas を描くと、そのタブにその Canvas のレコードが残る（`ensureCanvas` で読んだものは手放さない。`docs/lazy-canvas-loading-plan.md` の 7）。画像と Editor は、描いたあとに手放す（2 の「描いたあとに手放すもの」）。
- 画像はトークンを使う（1568×882 で約 1,800）。説明に「毎回は描かない」と書き、効き目は `claude.db` の時間・費用で見る。
- 手元の、まだ送っていない編集も写る。rev はサーバーの値なので、絵と rev がずれることがある（`notes` には書かない。まれなので）。
- ブラウザごとのクリップボードの違い（Firefox は 127 から `ClipboardItem` が使える）。

**やらないこと**

- サーバーで描く（ヘッドレスの Chromium）。要るようになったら、別のチケットで考える。
- 描いた画像を保存しておくこと。
- SVG・PDF での書き出し（スライドの PDF はもうある）。
- `edit_canvas` のたびに自動で描くこと。
- ref の画像（MAI-64）とサムネイルの振る舞いを変えること。
