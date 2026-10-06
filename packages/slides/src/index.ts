// スライド v2（キャンバスのノード slide / slide-layout）の幾何とテーマ。DOM に依存しない純関数だけを置く。
// - core/：v1 のスライドエンジンから残した寸法の仕様（slide-layout-spec）と行の容量の規則（slide-row-capacity）。
//   v1 のデッキ（.slide.md / .slide.json）の読み書き・lint・描画・エディタは、v1 とともに消した
// - canvas/：v2 のテンプレートが使う幾何（canvas-slide-layout）・行の高さ（canvas-slide-rows）・テーマ（canvas-slide-theme）
export * from './core/slide-layout-spec.ts'
export * from './core/slide-row-capacity.ts'
export * from './canvas/canvas-slide-layout.ts'
export * from './canvas/canvas-slide-rows.ts'
export * from './canvas/canvas-slide-theme.ts'
