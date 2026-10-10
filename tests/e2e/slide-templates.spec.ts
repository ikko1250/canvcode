import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// スライドのテンプレート（スライド v2）の見た目：5 種のテンプレートを置いたスライドを、PDF に出す画像（renderSlideImage）で撮る。
// 見比べるための画像は SLIDE_TEMPLATE_SHOTS のディレクトリ（なければテストの出力先）に書く。テストは画像の大きさと、描けたことだけを確かめる
// （v1 のプレビューで撮った画像との見比べは、v1 のスライドとともに消した）

const CANVAS_ID = 'canvas:slide-template-test'
const KINDS = ['title', 'bullets', 'table', 'table-image', 'table-images'] as const
type Kind = (typeof KINDS)[number]

function slide(id: string, x: number, ratio: string) {
  return {
    typeName: 'node', id, type: 'slide', parentId: CANVAS_ID, x, y: 0, rotation: 0, index: `a${x / 2200}`, opacity: 1, locked: false, version: 1,
    props: { ratio, name: id, hidden: false }, meta: {},
  }
}

async function openApp(page: Page) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'テンプレート', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const records = [canvas, ...KINDS.flatMap((kind, i) => [slide(`node:${kind}`, i * 4400, '16:9'), slide(`node:${kind}-43`, i * 4400 + 2200, '4:3')])]
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
}

// テンプレートを置いて、スライドの画像（PNG）を base64 で返す
async function templateImage(page: Page, slideId: string, kind: Kind): Promise<{ applied: boolean; width: number; height: number; png: string }> {
  return page.evaluate(async ({ slideId, kind }) => {
    type Api = {
      editor: { applySlideTemplate(id: string, kind: string): boolean }
      view: { renderSlideImage(id: string): Promise<{ png: Blob; width: number; height: number } | null> }
    }
    const api = (window as unknown as { canvcode: Api }).canvcode
    const applied = api.editor.applySlideTemplate(slideId, kind)
    const image = await api.view.renderSlideImage(slideId)
    const bytes = new Uint8Array(await image!.png.arrayBuffer())
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return { applied, width: image!.width, height: image!.height, png: btoa(binary) }
  }, { slideId, kind })
}

test('renders the five slide templates', async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', '見た目の比較は chromium だけで撮る')
  test.setTimeout(120_000)
  const dir = process.env.SLIDE_TEMPLATE_SHOTS ?? testInfo.outputPath('slide-templates')
  await mkdir(dir, { recursive: true })

  await openApp(page)
  for (const kind of KINDS) {
    for (const [suffix, size] of [['', { width: 1920, height: 1080 }], ['-43', { width: 1440, height: 1080 }]] as const) {
      const image = await templateImage(page, `node:${kind}${suffix}`, kind)
      expect(image.applied).toBe(true)
      expect({ width: image.width, height: image.height }).toEqual(size)
      await writeFile(join(dir, `v2-${kind}${suffix || '-169'}.png`), Buffer.from(image.png, 'base64'))
    }
  }
})
