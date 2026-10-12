import { expect, test, type Page } from '@playwright/test'

// 右上の「保存済み」「未接続」の隣に、Google Drive に送れていないときのアイコンを出す。
// サーバーの応答（/api/records・/api/files・/api/backup-status）だけを差し替えて、本物の画面で確かめる
async function openApp(page: Page, status: unknown): Promise<void> {
  const records = [
    { typeName: 'canvas', id: 'canvas:root', title: 'ホーム', parentCanvasId: null, ownerNodeId: null, createdAt: 0, updatedAt: 0, deletedAt: null, trash: null },
  ]
  await page.route('**/api/records', (route) => route.fulfill({ json: { rootCanvasId: 'canvas:root', rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.route('**/api/backup-status', (route) => route.fulfill({ json: status }))
  await page.routeWebSocket('**/api/sync', (ws) => {
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.type === 'hello') ws.send(JSON.stringify({ type: 'changes', rev: 0, records: [], deleted: [] }))
    })
  })
  const loaded = page.waitForResponse('**/api/backup-status')
  await page.goto('/')
  await loaded
  await expect(page.locator('.status-bar .sync-status')).toHaveText('保存済み')
}

test('shows a Drive icon next to the sync status when Google Drive is unreachable', async ({ page }) => {
  await openApp(page, {
    state: 'drive',
    lastAttemptAt: '2026-10-12T03:05:00.000Z',
    lastSuccessAt: '2026-10-12T02:00:00.000Z',
    driveLastOkAt: '2026-10-12T02:00:00.000Z',
    error: 'rclone about: dial tcp: no such host',
  })
  const icon = page.locator('.status-bar .backup-status')
  await expect(icon).toBeVisible()
  await expect(icon).toHaveAttribute('title', /^Google Drive に接続できません（最終成功: .+、理由: rclone about: dial tcp: no such host）$/)
  // 「保存済み」などの表示の左隣に並ぶ
  const iconBox = (await icon.boundingBox())!
  const syncBox = (await page.locator('.status-bar .sync-status').boundingBox())!
  expect(iconBox.x + iconBox.width).toBeLessThanOrEqual(syncBox.x)
  expect(Math.abs(iconBox.y - syncBox.y)).toBeLessThan(8)
  // クリックで詳しい説明を開く
  await icon.click()
  const detail = page.locator('.backup-status-detail')
  await expect(detail).toContainText('Google Drive に接続できません')
  await expect(detail).toContainText('理由: rclone about: dial tcp: no such host')
  await icon.click()
  await expect(detail).toHaveCount(0)
  // ほかの場所を押しても閉じる
  await icon.click()
  await expect(detail).toBeVisible()
  await page.mouse.click(400, 400)
  await expect(detail).toHaveCount(0)
})

test('shows a stopped-backup icon when the timer has not run for a while', async ({ page }) => {
  await openApp(page, { state: 'stale', lastAttemptAt: '2026-10-12T03:05:00.000Z', lastSuccessAt: '2026-10-12T03:05:00.000Z', driveLastOkAt: null, error: null })
  await expect(page.locator('.backup-status.stale')).toHaveAttribute('title', /^バックアップが動いていません/)
})

test('shows nothing when the backup works', async ({ page }) => {
  await openApp(page, { state: 'ok', lastAttemptAt: '2026-10-12T03:05:00.000Z', lastSuccessAt: '2026-10-12T03:05:00.000Z', driveLastOkAt: '2026-10-12T03:05:00.000Z', error: null })
  // 状態を読み終えたあと（openApp）で、出ていないことを確かめる
  await expect(page.locator('.backup-status')).toHaveCount(0)
})
