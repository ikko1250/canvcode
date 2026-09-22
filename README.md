# CanvCode

ドキュメント管理機能と階層構造を持つ infinite canvas。設計は Linear の MAI-1（MAI-2〜MAI-16）を参照。

現在は段階 1・2（パン・ズーム、図形の作成・選択・移動、1 万ノードのベンチマーク）まで。データはまだ保存されず、再読み込みで消える。

## 構成

| パス | 内容 |
| -- | -- |
| `packages/core` | 幾何計算・カメラ・fractional index・ID・ストア・Undo（DOM に依存しない） |
| `packages/nodes` | ノードの型（`defineNodeType`、`geo`） |
| `packages/canvas` | 描画（Canvas2D の 3 レイヤー）・入力・ツール・空間インデックス |
| `apps/web` | React の画面 |
| `apps/server` | Node のサーバー（127.0.0.1 でのみ待ち受け、ビルドした画面を配信） |

## 使い方

Node 24 以上が必要。

```bash
npm install
npm run build   # 型チェックと画面のビルド
npm start       # http://127.0.0.1:8787
```

VPS 上で動かし、手元の PC からは SSH のポートフォワードで開く。

```bash
ssh -L 8787:127.0.0.1:8787 <VPS>
# ブラウザで http://localhost:8787 を開く
```

開発時は `npm run dev`（Vite、http://127.0.0.1:5173）。ポートフォワードは `-L 5173:127.0.0.1:5173`。

```bash
npm test        # ユニットテスト（Vitest）
npm run lint    # oxlint
```

## 操作

| 操作 | 入力 |
| -- | -- |
| パン | ホイール、Space+ドラッグ、中ボタンドラッグ、手のひらツール（H） |
| ズーム | Ctrl（⌘）+ホイール、トラックパッドのピンチ |
| 全体表示 | Shift+1 |
| ツール | V 選択 / H 手のひら / R 矩形 / O 楕円 |
| 選択 | クリック、Shift+クリックで追加・解除、Ctrl+A で全選択 |
| 移動 | ドラッグ、矢印キー（Shift で 10） |
| 削除 | Delete / Backspace |
| 元に戻す / やり直す | Ctrl+Z / Ctrl+Shift+Z（Ctrl+Y） |
| 取り消し | Esc（ドラッグ中なら開始時の状態に戻す） |

画面上部の「ベンチマーク」で、1 万ノードを置いた状態のパン・ズームのフレーム時間を測れる（MAI-14）。
