import { describe, expect, it } from 'vitest'
import { Editor, Workspace } from '@canvcode/canvas'
import { CITE_NOTE_COLOR, citationParagraphs, citeSourceOf } from './cite.ts'

// APA の引用を置く（MAI-98）：引用を作れるアイテムと、置くテキストの段落

describe('citeSourceOf', () => {
  it('PDF の Portal とページは PDF、リンクカードは URL と題など、Markdown のカードはその File', () => {
    const workspace = new Workspace({ rootCanvasId: 'canvas:root' })
    const editor = new Editor({ workspace })
    const pdf = editor.importPdf({ title: '論文', asset: { id: 'asset:abc', hash: 'abc', size: 1 }, pageSizes: [{ width: 600, height: 800 }], center: { x: 0, y: 0 } })
    expect(citeSourceOf(workspace.getNode(pdf.portalId)!, workspace)).toEqual({ kind: 'pdf', fileId: pdf.fileId })
    const page = new Editor({ workspace, canvasId: pdf.canvasId }).pdfPageIds()[0]!
    expect(citeSourceOf(workspace.getNode(page)!, workspace)).toEqual({ kind: 'pdf', fileId: pdf.fileId })
    // PDF でない Canvas の Portal は作れない
    const plain = editor.createPortal({ x: 500, y: 0 })
    expect(citeSourceOf(workspace.getNode(plain.portalId)!, workspace)).toBeNull()

    const link = editor.makeNode('link-card', { x: 0, y: 0, props: { url: 'https://example.com/a', title: '題', description: null, siteName: 'Example', status: 'done' } })
    expect(citeSourceOf(link, workspace)).toEqual({ kind: 'link', url: 'https://example.com/a', title: '題', siteName: 'Example' })
    // 読み込み中のカード・http(s) でない URL は作れない
    expect(citeSourceOf({ ...link, props: { ...link.props, status: 'loading' } }, workspace)).toBeNull()
    expect(citeSourceOf({ ...link, props: { ...link.props, url: 'file:///etc/passwd' } }, workspace)).toBeNull()
    expect(citeSourceOf(editor.makeNode('note', { x: 0, y: 0 }), workspace)).toBeNull()
  })
})

describe('citationParagraphs', () => {
  it('1 段落目が引用の文（斜体つき）。未確認の項目・資料にあった値・根拠・メモを、薄い色の段落で続ける', () => {
    const paragraphs = citationParagraphs({
      citation: [{ text: 'Smith, J. (2020). Title. ' }, { text: 'Journal', italic: true }, { text: ', [未確認：巻号].' }],
      unverified: [
        { field: 'volumeIssue', label: '巻号', candidate: '3(1)' },
        { field: 'pages', label: 'ページ' },
      ],
      evidence: [{ url: 'https://example.com/paper', labels: ['著者', '年'] }],
      note: '版が 2 つある',
    })
    expect(paragraphs[0]!.runs).toEqual([{ text: 'Smith, J. (2020). Title. ' }, { text: 'Journal', format: { italic: true } }, { text: ', [未確認：巻号].' }])
    expect(paragraphs.slice(1).map((p) => p.runs)).toEqual(
      [
        '未確認：巻号・ページ（Web で確かめられなかったので、推測で埋めていません）',
        '資料にあった値（未確認）：巻号 3(1)',
        '根拠（著者・年）：https://example.com/paper',
        'メモ：版が 2 つある',
      ].map((text) => [{ text, format: { color: CITE_NOTE_COLOR } }]),
    )
  })

  it('すべて確かめられたなら、未確認の行は出さない', () => {
    const paragraphs = citationParagraphs({ citation: [{ text: 'A. (2020). T.' }], unverified: [], evidence: [] })
    expect(paragraphs).toEqual([{ runs: [{ text: 'A. (2020). T.' }] }])
  })
})
