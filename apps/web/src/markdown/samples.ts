// 検証用の Markdown（MAI-21）。見出し・表・コード・数式・画像をひととおり含める。

const inlineSvg =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60"><rect width="240" height="60" rx="8" fill="#fff4e6"/><text x="16" y="38" font-size="20" fill="#e8590c" font-family="sans-serif">data: URL の画像</text></svg>',
  )

export function sampleMarkdown(origin: string): string {
  return `# 研究ノート：拡散方程式

キャンバス上の **Markdown カード** を、画像にして描いたときの見え方を確かめる。インラインの数式 $E = mc^2$ や $\\alpha_i + \\beta^{2}$、\`inline code\`、[リンク](https://example.com) を含む。

## 数式

$$
\\frac{\\partial u}{\\partial t} = D \\nabla^2 u, \\qquad
\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}
$$

$$
\\mathbf{A} = \\begin{pmatrix} a_{11} & a_{12} \\\\ a_{21} & a_{22} \\end{pmatrix}, \\quad
\\sum_{n=1}^{N} \\frac{1}{n^2} \\approx \\mathcal{O}(1)
$$

## 表

| 手法 | 精度 | 計算量 |
| --- | ---: | --- |
| 陽解法 | 0.82 | $O(n)$ |
| 陰解法 | 0.95 | $O(n^3)$ |

## コード

\`\`\`python
def step(u, dt, D):
    return u + dt * D * laplacian(u)
\`\`\`

## リスト

- [x] 画像への変換
- [ ] 解像度の切り替え
  - 入れ子の項目

> 引用：foreignObject で描いた HTML は、倍率に合わせて描き直せばにじまない。詳しくは [MDN の foreignObject の説明（SVG の中に別の名前空間の要素を埋め込む仕組み）](https://developer.mozilla.org/ja/docs/Web/SVG/Element/foreignObject) を参照。

![同じサーバーの画像](${origin}/lab-sample.svg)

![埋め込み画像](${inlineSvg})
`
}

// まとめて変換するときの所要時間を測るための、長さの違う Markdown
export function batchVariants(origin: string, count: number): string[] {
  const full = sampleMarkdown(origin)
  const sections = full.split('\n## ')
  return Array.from({ length: count }, (_, i) => {
    const take = 1 + (i % sections.length)
    return `# カード ${i + 1}\n\n` + sections.slice(0, take).join('\n## ').replace(/^# .*\n/, '')
  })
}
